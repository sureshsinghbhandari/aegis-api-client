/** Editor support for scripts: a minimal `pm` typing for autocomplete and a snippet list. */

export const PM_TYPINGS = {
  name: 'aegis-pm.d.ts',
  content: `
interface PmScope {
  get(key: string): string | undefined;
  set(key: string, value: unknown): void;
  unset(key: string): void;
  has(key: string): boolean;
  clear(): void;
  toObject(): Record<string, string>;
  replaceIn(template: string): string;
}
interface PmHeaderList {
  get(name: string): string | undefined;
  has(name: string): boolean;
  add(header: { key: string; value: string }): void;
  upsert(header: { key: string; value: string }): void;
  remove(name: string): void;
  toObject(): Record<string, string>;
}
interface PmResponse {
  code: number;
  status: string;
  responseTime: number;
  responseSize: number;
  headers: PmHeaderList;
  json(): any;
  text(): string;
  size(): number;
  to: {
    not: PmResponse['to'];
    have: { status(code: number | string): void; header(name: string, value?: string): void; body(expected?: string): void; jsonBody(path?: string, value?: unknown): void };
  };
}
interface PmRequest {
  method: string;
  url: { toString(): string; getHost(): string; getPath(): string; getQueryString(): string };
  headers: PmHeaderList;
  body: { mode: string; raw?: string; isEmpty(): boolean; toString(): string };
  addHeader(header: { key: string; value: string }): void;
  removeHeader(name: string): void;
}
declare const pm: {
  info: { eventName: 'prerequest' | 'test'; iteration: number; iterationCount: number; requestName: string; requestId: string };
  variables: PmScope;
  environment: PmScope;
  collectionVariables: PmScope;
  globals: PmScope;
  iterationData: { get(key: string): string | undefined; has(key: string): boolean; toObject(): Record<string, string> };
  request: PmRequest;
  response: PmResponse;
  cookies: { get(name: string): { name: string; value: string } | undefined; has(name: string): boolean };
  test(name: string, fn: () => void | Promise<void>): void;
  expect: (value: unknown) => any;
  sendRequest(request: string | { url: string; method?: string; header?: Record<string, string>; body?: unknown }, callback?: (error: Error | null, response: PmResponse) => void): Promise<PmResponse>;
  execution: { setNextRequest(name: string | null): void; skipRequest(): void };
};
declare const expect: (value: unknown) => any;
`,
};

export interface ScriptSnippet {
  title: string;
  /** Which phases the snippet makes sense in. */
  phases: Array<'prerequest' | 'test'>;
  code: string;
}

export const SNIPPETS: ScriptSnippet[] = [
  { title: 'Set environment variable', phases: ['prerequest', 'test'], code: "pm.environment.set('variable_key', 'variable_value');\n" },
  { title: 'Get environment variable', phases: ['prerequest', 'test'], code: "const value = pm.environment.get('variable_key');\n" },
  { title: 'Set collection variable', phases: ['prerequest', 'test'], code: "pm.collectionVariables.set('variable_key', 'variable_value');\n" },
  { title: 'Set global variable', phases: ['prerequest', 'test'], code: "pm.globals.set('variable_key', 'variable_value');\n" },
  { title: 'Log to console', phases: ['prerequest', 'test'], code: "console.log('message', pm.variables.get('variable_key'));\n" },
  { title: 'Add request header', phases: ['prerequest'], code: "pm.request.headers.upsert({ key: 'X-Request-Id', value: Date.now().toString() });\n" },
  { title: 'Skip this request', phases: ['prerequest'], code: 'pm.execution.skipRequest();\n' },
  { title: 'Status code is 200', phases: ['test'], code: "pm.test('Status code is 200', function () {\n  pm.response.to.have.status(200);\n});\n" },
  { title: 'Response time below 500 ms', phases: ['test'], code: "pm.test('Response time is below 500 ms', function () {\n  pm.expect(pm.response.responseTime).to.be.below(500);\n});\n" },
  { title: 'JSON body has a value', phases: ['test'], code: "pm.test('Body contains expected value', function () {\n  const json = pm.response.json();\n  pm.expect(json.id).to.exist;\n});\n" },
  { title: 'Header is present', phases: ['test'], code: "pm.test('Content-Type is JSON', function () {\n  pm.expect(pm.response.headers.get('Content-Type')).to.include('application/json');\n});\n" },
  { title: 'Save value from JSON body', phases: ['test'], code: "const json = pm.response.json();\npm.environment.set('token', json.token);\n" },
  { title: 'Set next request', phases: ['test'], code: "pm.execution.setNextRequest('Request name');\n" },
  { title: 'Send a request', phases: ['prerequest', 'test'], code: "pm.sendRequest('https://example.com/health', function (err, res) {\n  console.log(err || res.code);\n});\n" },
];
