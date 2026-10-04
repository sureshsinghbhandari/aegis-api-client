import type {
  ScriptCookie,
  ScriptHost,
  ScriptRequestSnapshot,
  ScriptResponseSnapshot,
  ScriptRunInput,
  ScriptRunResult,
  ScriptSendRequest,
  ScriptSendResponse,
  ScriptVariableState,
  VariableScopeName,
} from '@aegis/core';

export type SendHandler = (request: ScriptSendRequest, signal: AbortSignal) => Promise<ScriptSendResponse>;

export function okResponse(partial: Partial<ScriptSendResponse> = {}): ScriptSendResponse {
  return {
    code: 200,
    status: 'OK',
    headers: [{ name: 'Content-Type', value: 'application/json' }],
    bodyText: '{"ok":true}',
    responseTimeMs: 12,
    responseSizeBytes: 11,
    cookies: [],
    ...partial,
  };
}

export interface FakeHost extends ScriptHost {
  calls: ScriptSendRequest[];
}

export function fakeHost(handler: SendHandler = async () => okResponse()): FakeHost {
  const calls: ScriptSendRequest[] = [];
  return {
    calls,
    sendRequest: (request, signal) => {
      calls.push(request);
      return handler(request, signal);
    },
  };
}

export function emptyVariables(): ScriptVariableState {
  return { globals: {}, environment: {}, collectionVariables: {}, variables: {}, iterationData: {} };
}

export function makeResponse(partial: Partial<ScriptResponseSnapshot> = {}): ScriptResponseSnapshot {
  return {
    code: 200,
    status: 'OK',
    headers: [
      { name: 'Content-Type', value: 'application/json; charset=utf-8' },
      { name: 'X-Request-Id', value: 'abc-123' },
    ],
    bodyText: '{"id":7,"name":"Ada","tags":["a","b"],"nested":{"x":1}}',
    responseTimeMs: 42,
    responseSizeBytes: 55,
    cookies: [],
    ...partial,
  };
}

export function makeRequest(partial: Partial<ScriptRequestSnapshot> = {}): ScriptRequestSnapshot {
  return {
    method: 'GET',
    url: 'https://api.example.com/users/1?active=true&q=a%20b',
    headers: [{ key: 'Accept', value: 'application/json', enabled: true }],
    body: { mode: 'none' },
    ...partial,
  };
}

export interface MakeInputOptions extends Partial<Omit<ScriptRunInput, 'variables' | 'limits'>> {
  variables?: Partial<Record<VariableScopeName, Record<string, string>>>;
  limits?: Partial<ScriptRunInput['limits']>;
}

export function makeInput(source: string, options: MakeInputOptions = {}): ScriptRunInput {
  const { variables, limits, ...rest } = options;
  const phase = rest.phase ?? 'prerequest';
  const cookies: ScriptCookie[] = rest.cookies ?? [];
  return {
    phase,
    origin: 'test script',
    source,
    variables: { ...emptyVariables(), ...variables },
    request: makeRequest(),
    response: phase === 'test' ? makeResponse() : undefined,
    cookies,
    info: { eventName: phase, iteration: 0, iterationCount: 1, requestName: 'Get user', requestId: 'req-1' },
    limits: { timeoutMs: 5000, memoryLimitBytes: 32 * 1024 * 1024, ...limits },
    host: fakeHost(),
    ...rest,
  };
}

export function testPhase(source: string, options: MakeInputOptions = {}): ScriptRunInput {
  return makeInput(source, { ...options, phase: 'test' });
}

export function expectOk(result: ScriptRunResult): void {
  if (!result.ok) throw new Error(`script failed: ${JSON.stringify(result.error)}`);
}

export function testByName(result: ScriptRunResult, name: string) {
  const t = result.tests.find((x) => x.name === name);
  if (!t) throw new Error(`no test named "${name}" in ${JSON.stringify(result.tests.map((x) => x.name))}`);
  return t;
}
