import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emptyRequestDraft } from '@aegis/core';
import { HttpProtocolClient, buildHttpRequestSpec } from '@aegis/http-client';
import { VariableResolver, scopeFromRecord } from '@aegis/variables';
import { startServer, type TestServer } from '../helpers/http-server';

let server: TestServer;
const client = new HttpProtocolClient();
const limits = { timeoutMs: 10_000, followRedirects: true, maxRedirects: 5, maxResponseBytes: 50e6, maxRequestBytes: 50e6 };

beforeAll(async () => {
  server = await startServer();
});
afterAll(async () => {
  await server.close();
});

describe('GraphQL body mode (integration)', () => {
  it('sends a JSON POST with query, variables and operationName; variables are substituted first', async () => {
    const draft = emptyRequestDraft({
      method: 'POST',
      url: `${server.url}/echo`,
      body: { mode: 'graphql', graphql: { query: 'query Customer($id: ID!) { customer(id: $id) { email } }', variables: '{ "id": "{{customerId}}" }', operationName: 'Customer' } },
    });
    const resolved = new VariableResolver({ environment: scopeFromRecord({ customerId: '1042' }) }).resolveRequest(draft);
    const res = await client.send(buildHttpRequestSpec(resolved, { id: 'gql-1', limits, tls: { rejectUnauthorized: true } }));
    expect(res.status).toBe(200);
    const echo = JSON.parse(Buffer.from(res.body).toString('utf8'));
    expect(echo.method).toBe('POST');
    expect(echo.headers['content-type']).toBe('application/json');
    expect(JSON.parse(echo.body)).toEqual({ query: 'query Customer($id: ID!) { customer(id: $id) { email } }', variables: { id: '1042' }, operationName: 'Customer' });
    expect(Number(echo.headers['content-length'])).toBe(echo.bodyLength);
  });
});
