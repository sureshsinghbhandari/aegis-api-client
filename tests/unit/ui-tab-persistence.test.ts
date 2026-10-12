import { describe, expect, it } from 'vitest';
import { emptyRequestDraft, type RequestDraft } from '@aegis/core';
import {
  MAX_PERSISTED_BYTES,
  isSecretAuthParam,
  mergeRestoredDraft,
  parsePersistedTabs,
  serializeTabs,
  serializeTabsForStorage,
  stripSecretAuth,
  type PersistableTab,
} from '../../apps/desktop/renderer/src/lib/tab-persistence';

const SECRETS = ['hunter2', 'tok-123', 'cs-456', 'rt-789', 'sk-abc', '-----BEGIN PRIVATE KEY-----', 'secretref:auth:r1:token'];

const tab = (over: Omit<Partial<PersistableTab>, 'draft'> & { draft?: Partial<RequestDraft> } = {}, dirty = false): PersistableTab => {
  const draft = emptyRequestDraft(over.draft);
  const saved = dirty ? emptyRequestDraft({ ...over.draft, name: 'saved name' }) : draft;
  return { requestId: over.requestId === undefined ? 'r1' : over.requestId, collectionId: over.collectionId === undefined ? 'c1' : over.collectionId, folderId: over.folderId === undefined ? null : over.folderId, draft, savedJson: JSON.stringify(saved) };
};

describe('tab persistence strips secrets', () => {
  it('knows which auth parameters are credentials', () => {
    expect(isSecretAuthParam('basic', 'password')).toBe(true);
    expect(isSecretAuthParam('basic', 'username')).toBe(false);
    expect(isSecretAuthParam('bearer', 'token')).toBe(true);
    expect(isSecretAuthParam('oauth2', 'clientSecret')).toBe(true);
    expect(isSecretAuthParam('oauth2', 'clientId')).toBe(false);
    expect(isSecretAuthParam('awsv4', 'secretKey')).toBe(true);
    expect(isSecretAuthParam('jwt', 'privateKey')).toBe(true);
    expect(isSecretAuthParam('custom', 'x-api-key')).toBe(true);
    expect(isSecretAuthParam('custom', 'password')).toBe(true);
    expect(isSecretAuthParam('custom', 'region')).toBe(false);
  });
  it('removes credential values but keeps {{variable}} references and non-secret params', () => {
    const auth = stripSecretAuth({ type: 'oauth2', params: { clientId: 'id', clientSecret: 'cs-456', accessToken: 'tok-123', refreshToken: '{{refresh}}', grant_type: 'client_credentials', password: '' } });
    expect(auth).toEqual({ type: 'oauth2', params: { clientId: 'id', refreshToken: '{{refresh}}', grant_type: 'client_credentials', password: '' } });
  });
  it('never writes secrets (literal or secretref) to the serialised form, for dirty and unsaved tabs', () => {
    const dirty = tab({ draft: { auth: { type: 'basic', params: { username: 'u', password: 'hunter2' } } } }, true);
    const unsaved = tab({ requestId: null, draft: { auth: { type: 'bearer', params: { token: 'secretref:auth:r1:token' } } } });
    const clean = tab({ requestId: 'r2', draft: { auth: { type: 'awsv4', params: { accessKey: 'ak', secretKey: 'sk-abc', sessionToken: 'rt-789' } } } });
    const custom = tab({ requestId: null, draft: { auth: { type: 'custom', params: { 'x-api-key': 'cs-456', privateKey: '-----BEGIN PRIVATE KEY-----', region: 'eu' } } } });
    const json = serializeTabsForStorage([dirty, unsaved, clean, custom], 1);
    for (const s of SECRETS) expect(json, s).not.toContain(s);
    expect(json).toContain('"username":"u"');
    expect(json).toContain('"region":"eu"');
    const parsed = JSON.parse(json) as { activeIndex: number; tabs: Array<{ requestId: string | null; draft?: unknown }> };
    expect(parsed.activeIndex).toBe(1);
    expect(parsed.tabs[0]?.draft).toBeDefined(); // dirty: draft kept (without secrets)
    expect(parsed.tabs[1]?.draft).toBeDefined(); // unsaved: draft kept
    expect(parsed.tabs[2]?.draft).toBeUndefined(); // clean saved request: id only
    expect(parsed.tabs[2]?.requestId).toBe('r2');
  });
  it('never persists responses', () => {
    const t = tab();
    const out = serializeTabs([{ ...t, response: { status: 'done', result: { secret: 'tok-123' } } } as unknown as PersistableTab], 0);
    expect(JSON.stringify(out)).not.toContain('response');
    expect(JSON.stringify(out)).not.toContain('tok-123');
  });
  it('falls back to ids only when the payload is too large', () => {
    const big = tab({ draft: { body: { mode: 'raw', raw: 'x'.repeat(MAX_PERSISTED_BYTES) } } }, true);
    const json = serializeTabsForStorage([big, tab({ requestId: 'r9' })], 0);
    expect(json.length).toBeLessThan(MAX_PERSISTED_BYTES);
    expect(json).toContain('"r9"');
    expect(json).toContain('"r1"');
  });
});

describe('tab persistence restore', () => {
  it('parses what it wrote and rejects garbage', () => {
    const json = serializeTabsForStorage([tab({ requestId: null, draft: { name: 'ad hoc', url: 'http://x.test' } }), tab({ requestId: 'r5' })], 1);
    const parsed = parsePersistedTabs(json);
    expect(parsed?.tabs).toHaveLength(2);
    expect(parsed?.activeIndex).toBe(1);
    expect(parsed?.tabs[0]?.draft?.name).toBe('ad hoc');
    expect(parsed?.tabs[1]).toEqual({ requestId: 'r5', collectionId: 'c1', folderId: null });
    for (const bad of [null, '', '{', '[]', '{"version":99,"tabs":[]}', '{"version":1,"tabs":"x"}', '{"version":1,"tabs":[{"requestId":5},{"draft":"x"}]}']) {
      expect(parsePersistedTabs(bad), String(bad)).toBeNull();
    }
  });
  it('strips secrets that somehow ended up in storage and repairs malformed drafts', () => {
    const raw = JSON.stringify({ version: 1, activeIndex: 0, tabs: [{ requestId: null, collectionId: null, folderId: null, draft: { name: 'x', auth: { type: 'bearer', params: { token: 'tok-123' } }, body: 'nope', headers: 'nope' } }] });
    const parsed = parsePersistedTabs(raw);
    expect(JSON.stringify(parsed)).not.toContain('tok-123');
    expect(parsed?.tabs[0]?.draft?.body).toEqual({ mode: 'none' });
    expect(parsed?.tabs[0]?.draft?.headers).toEqual([]);
  });
  it('re-attaches saved secret references to a restored dirty draft when the auth type is unchanged', () => {
    const persisted = emptyRequestDraft({ name: 'edited', auth: { type: 'basic', params: { username: 'u2' } } });
    const saved = emptyRequestDraft({ name: 'saved', auth: { type: 'basic', params: { username: 'u', password: 'secretref:auth:r1:password' } } });
    const merged = mergeRestoredDraft(persisted, saved);
    expect(merged.name).toBe('edited');
    expect(merged.auth.params).toEqual({ username: 'u2', password: 'secretref:auth:r1:password' });
    // auth type changed: nothing is re-attached
    const switched = mergeRestoredDraft(emptyRequestDraft({ auth: { type: 'bearer', params: {} } }), saved);
    expect(switched.auth).toEqual({ type: 'bearer', params: {} });
    expect(mergeRestoredDraft(persisted, null)).toBe(persisted);
  });
});
