/**
 * Open tabs are remembered across restarts in `localStorage`. Only request ids and NON-SECRET
 * draft fields are written: every secret authorization parameter (password, token, client secret,
 * private key, ...) is removed before serialisation and re-attached from the saved request on
 * restore. Responses are never persisted.
 */
import { AUTH_SECRET_PARAMS, emptyRequestDraft, isVariableReferenceOnly, type AuthConfig, type RequestDraft } from '@aegis/core';

export const TABS_STORAGE_KEY = 'aegis.tabs';
export const TABS_STORAGE_VERSION = 1;
/** Above this size the drafts are dropped and only request ids are kept (localStorage quota). */
export const MAX_PERSISTED_BYTES = 2 * 1024 * 1024;

export interface PersistedTab {
  requestId: string | null;
  collectionId: string | null;
  folderId: string | null;
  /** Present for unsaved tabs and dirty tabs only; secrets stripped. */
  draft?: RequestDraft;
}

export interface PersistedTabs {
  version: typeof TABS_STORAGE_VERSION;
  activeIndex: number;
  tabs: PersistedTab[];
}

export interface PersistableTab {
  requestId: string | null;
  collectionId: string | null;
  folderId: string | null;
  draft: RequestDraft;
  savedJson: string;
}

const SENSITIVE_PARAM = /pass(word|wd|phrase)?$|secret|token|private[-_]?key|api[-_]?key|^key$|^value$|credential|signature/i;

/** True when `key` of an auth config of `type` holds a credential. */
export function isSecretAuthParam(type: string, key: string): boolean {
  const known = AUTH_SECRET_PARAMS[type];
  if (known) return known.includes(key);
  return SENSITIVE_PARAM.test(key);
}

/** Remove credential parameters (values that are only `{{variable}}` references are kept). */
export function stripSecretAuth(auth: AuthConfig): AuthConfig {
  const params: AuthConfig['params'] = {};
  for (const [k, v] of Object.entries(auth.params)) {
    if (isSecretAuthParam(auth.type, k) && !(typeof v === 'string' && (v === '' || isVariableReferenceOnly(v)))) continue;
    params[k] = v;
  }
  return { type: auth.type, params };
}

export function stripSecretsFromDraft(draft: RequestDraft): RequestDraft {
  return { ...draft, auth: stripSecretAuth(draft.auth) };
}

const isDirty = (t: PersistableTab): boolean => JSON.stringify(t.draft) !== t.savedJson;

export function serializeTabs(tabs: readonly PersistableTab[], activeTabIndex: number): PersistedTabs {
  return {
    version: TABS_STORAGE_VERSION,
    activeIndex: Math.max(0, Math.min(activeTabIndex, tabs.length - 1)),
    tabs: tabs.map((t) => {
      const keepDraft = t.requestId === null || isDirty(t);
      return {
        requestId: t.requestId,
        collectionId: t.collectionId,
        folderId: t.folderId,
        ...(keepDraft ? { draft: stripSecretsFromDraft(t.draft) } : {}),
      };
    }),
  };
}

/** JSON for localStorage; falls back to ids only when the payload would be too large. */
export function serializeTabsForStorage(tabs: readonly PersistableTab[], activeTabIndex: number): string {
  const full = serializeTabs(tabs, activeTabIndex);
  const json = JSON.stringify(full);
  if (json.length <= MAX_PERSISTED_BYTES) return json;
  const slim: PersistedTabs = { ...full, tabs: full.tabs.filter((t) => t.requestId !== null || t.draft).map((t) => (t.requestId ? { requestId: t.requestId, collectionId: t.collectionId, folderId: t.folderId } : t)) };
  const slimJson = JSON.stringify(slim);
  return slimJson.length <= MAX_PERSISTED_BYTES ? slimJson : JSON.stringify({ ...slim, tabs: slim.tabs.filter((t) => t.requestId !== null) });
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const optId = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 && v.length <= 200 ? v : null);

function sanitizeDraft(v: unknown): RequestDraft | undefined {
  if (!isRecord(v)) return undefined;
  const base = emptyRequestDraft();
  const out: Record<string, unknown> = { ...base };
  for (const key of Object.keys(base) as Array<keyof RequestDraft>) {
    const incoming = v[key];
    if (incoming === undefined) continue;
    const expected = base[key];
    if (Array.isArray(expected)) {
      if (Array.isArray(incoming)) out[key] = incoming;
    } else if (typeof expected === 'object') {
      if (isRecord(incoming)) out[key] = incoming;
    } else if (typeof incoming === typeof expected) out[key] = incoming;
  }
  const draft = out as unknown as RequestDraft;
  if (!isRecord(draft.auth) || typeof draft.auth.type !== 'string' || !isRecord(draft.auth.params)) draft.auth = { type: 'inherit', params: {} };
  if (!isRecord(draft.body) || typeof draft.body.mode !== 'string') draft.body = { mode: 'none' };
  // Defense in depth: never trust secrets coming back from storage either.
  return stripSecretsFromDraft(draft);
}

/** Parse what was stored; tolerant of garbage (returns null). */
export function parsePersistedTabs(json: string | null | undefined): PersistedTabs | null {
  if (!json) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isRecord(raw) || raw.version !== TABS_STORAGE_VERSION || !Array.isArray(raw.tabs)) return null;
  const tabs: PersistedTab[] = [];
  for (const t of raw.tabs.slice(0, 100)) {
    if (!isRecord(t)) continue;
    const draft = sanitizeDraft(t.draft);
    const requestId = optId(t.requestId);
    if (!requestId && !draft) continue;
    tabs.push({ requestId, collectionId: optId(t.collectionId), folderId: optId(t.folderId), ...(draft ? { draft } : {}) });
  }
  if (tabs.length === 0) return null;
  const activeIndex = typeof raw.activeIndex === 'number' && Number.isInteger(raw.activeIndex) ? Math.max(0, Math.min(raw.activeIndex, tabs.length - 1)) : 0;
  return { version: TABS_STORAGE_VERSION, activeIndex, tabs };
}

/**
 * Combine a persisted (secret-stripped) draft with the saved request: secret auth parameters come
 * back from the saved version when the auth type is unchanged, so an edited-but-unsaved request
 * keeps its stored credentials (as `secretref:` references, never plaintext).
 */
export function mergeRestoredDraft(persisted: RequestDraft, saved: RequestDraft | null): RequestDraft {
  if (!saved || saved.auth.type !== persisted.auth.type) return persisted;
  const params = { ...persisted.auth.params };
  for (const [k, v] of Object.entries(saved.auth.params)) {
    if (isSecretAuthParam(saved.auth.type, k) && params[k] === undefined) params[k] = v;
  }
  return { ...persisted, auth: { type: persisted.auth.type, params } };
}
