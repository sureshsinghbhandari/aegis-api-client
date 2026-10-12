import { describe, expect, it } from 'vitest';
import { emptyRequestDraft, type CollectionBundle, type RequestDraft } from '@aegis/core';
import { buildHttpRequestSpec, graphqlBodyText } from '@aegis/http-client';
import { collectDraftStrings, draftToSnapshot } from '@aegis/app';
import { VariableResolver, scopeFromRecord } from '@aegis/variables';
import { exportPostmanCollection } from '@aegis/postman';
import { createTestStorage } from '../helpers/storage';

const limits = { timeoutMs: 1000, followRedirects: true, maxRedirects: 5, maxResponseBytes: 1e6, maxRequestBytes: 1e6 };
const opts = { id: 'x', limits, tls: { rejectUnauthorized: true } };

const gqlDraft = (overrides: Partial<RequestDraft> = {}): RequestDraft =>
  emptyRequestDraft({
    method: 'POST',
    url: 'http://h/graphql',
    body: { mode: 'graphql', graphql: { query: 'query User($id: ID!) { user(id: $id) { name } }', variables: '{ "id": "{{userId}}" }', operationName: 'User' } },
    ...overrides,
  });

describe('GraphQL body mode', () => {
  it('toBodySpec sends {query, variables, operationName} as JSON with Content-Type application/json', () => {
    const spec = buildHttpRequestSpec(gqlDraft(), opts);
    expect(spec.body.kind).toBe('text');
    expect(JSON.parse((spec.body as { text: string }).text)).toEqual({ query: 'query User($id: ID!) { user(id: $id) { name } }', variables: { id: '{{userId}}' }, operationName: 'User' });
    expect(spec.headers.find((h) => h.name === 'Content-Type')!.value).toBe('application/json');
  });

  it('omits empty variables/operationName, honours the Content-Type override and rejects invalid variables JSON', () => {
    expect(JSON.parse(graphqlBodyText({ query: '{ ping }', variables: '  ', operationName: ' ' }))).toEqual({ query: '{ ping }' });
    expect(JSON.parse(graphqlBodyText(undefined))).toEqual({ query: '' });
    const spec = buildHttpRequestSpec(gqlDraft({ body: { mode: 'graphql', contentType: 'application/graphql+json', graphql: { query: '{ ping }', variables: '' } } }), opts);
    expect(spec.headers.find((h) => h.name === 'Content-Type')!.value).toBe('application/graphql+json');
    expect(() => buildHttpRequestSpec(gqlDraft({ body: { mode: 'graphql', graphql: { query: '{ ping }', variables: '{ not json' } } }), opts)).toThrow(/variables are not valid JSON/);
  });

  it('scripts see a raw JSON snapshot; unresolved-variable scan covers query and variables', () => {
    const snap = draftToSnapshot(gqlDraft());
    expect(snap.body.mode).toBe('raw');
    expect(snap.body.rawLanguage).toBe('json');
    expect(JSON.parse(snap.body.raw!)).toMatchObject({ operationName: 'User', variables: { id: '{{userId}}' } });
    expect(collectDraftStrings(gqlDraft({ body: { mode: 'graphql', graphql: { query: '{ a(x: "{{q}}") }', variables: '{{vars}}' } } }))).toEqual(['{ a(x: "{{q}}") }', '{{vars}}']);
  });

  it('variables are resolved inside the query, the variables JSON and the operation name', () => {
    const resolver = new VariableResolver({ environment: scopeFromRecord({ userId: '42', op: 'User', field: 'name' }) });
    const out = resolver.resolveRequest(gqlDraft({ body: { mode: 'graphql', graphql: { query: '{ user { {{field}} } }', variables: '{"id":"{{userId}}"}', operationName: '{{op}}' } } }));
    expect(out.body.graphql).toEqual({ query: '{ user { name } }', variables: '{"id":"42"}', operationName: 'User' });
  });

  it('round-trips through storage save/load', () => {
    const storage = createTestStorage();
    const ws = storage.repos.workspaces.create('WS');
    const bundle: CollectionBundle = { name: 'C', description: '', variables: [], auth: { type: 'inherit', params: {} }, scripts: [], sourceMetadata: {}, items: [{ kind: 'request', request: gqlDraft({ name: 'GQL' }) }] };
    const { collectionId } = storage.repos.collections.insertBundle(ws.id, bundle);
    const loaded = storage.repos.collections.listRequests(collectionId)[0]!;
    expect(loaded.body).toEqual(gqlDraft().body);
    const saved = storage.repos.collections.updateRequest(loaded.id, { ...loaded, body: { mode: 'graphql', graphql: { query: '{ ping }', variables: '' } } });
    expect(saved.body).toEqual({ mode: 'graphql', graphql: { query: '{ ping }', variables: '' } });
  });

  it('exports natively as a Postman graphql body', () => {
    const bundle: CollectionBundle = { name: 'C', description: '', variables: [], auth: { type: 'inherit', params: {} }, scripts: [], sourceMetadata: {}, items: [{ kind: 'request', request: gqlDraft({ name: 'GQL' }) }] };
    const doc = exportPostmanCollection(bundle) as unknown as { item: Array<{ request: { body: unknown; header: unknown[] } }> };
    expect(doc.item[0]!.request.body).toEqual({ mode: 'graphql', graphql: { query: 'query User($id: ID!) { user(id: $id) { name } }', variables: '{ "id": "{{userId}}" }', operationName: 'User' } });
  });
});
