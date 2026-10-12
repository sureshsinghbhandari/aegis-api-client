/**
 * Editor support for scripts: `pm` typings for autocomplete and the snippet list.
 * The typings mirror the surface documented in docs/features/scripting.md (keep both in sync).
 */

export const PM_TYPINGS = {
  name: 'aegis-pm.d.ts',
  content: `
interface PmItem { key: string; value: string; disabled?: boolean; description?: string }
interface PmPropertyList<T = PmItem> {
  get(name: string): string | undefined;
  one(name: string): T | undefined;
  has(name: string, value?: string): boolean;
  add(item: T | string): void;
  append(item: T | string): void;
  prepend(item: T | string): void;
  insert(item: T | string, before?: string): void;
  upsert(item: T | string): void;
  remove(nameOrPredicate: string | ((item: T) => boolean)): void;
  clear(): void;
  populate(items: Array<T | string>): void;
  each(fn: (item: T) => void): void;
  forEach(fn: (item: T) => void): void;
  map<R>(fn: (item: T) => R): R[];
  filter(fn: (item: T) => boolean): T[];
  find(fn: (item: T) => boolean): T | undefined;
  count(): number;
  readonly length: number;
  idx(index: number): T | undefined;
  all(): T[];
  toObject(excludeDisabled?: boolean): Record<string, string>;
  toJSON(): T[];
  toString(): string;
  [Symbol.iterator](): Iterator<T>;
}
interface PmQueryItem { key: string; value: string | null; disabled?: boolean }
interface PmScope {
  get(key: string): string | undefined;
  set(key: string, value: unknown): void;
  unset(key: string): void;
  has(key: string): boolean;
  clear(): void;
  toObject(): Record<string, string>;
  toJSON(): Record<string, string>;
  replaceIn(template: string): string;
}
interface PmEnvironment extends PmScope {
  /** Name of the active environment; undefined when none is active. */
  readonly name: string | undefined;
}
interface PmIterationData {
  get(key: string): string | undefined;
  has(key: string): boolean;
  unset(key: string): void;
  toObject(): Record<string, string>;
  toJSON(): Record<string, string>;
  replaceIn(template: string): string;
}
interface PmUrl {
  protocol: string;
  auth: string;
  host: string[] | string;
  port: string;
  path: string[] | string;
  hash: string;
  query: PmPropertyList<PmQueryItem>;
  update(url: string | Partial<{ raw: string; protocol: string; auth: string; host: string | string[]; port: string; path: string | string[]; hash: string; query: string | Array<PmQueryItem | string> }>): void;
  getHost(): string;
  getPath(): string;
  getQueryString(): string;
  getPathWithQuery(): string;
  getRemote(): string;
  toString(): string;
  toJSON(): { raw: string; protocol: string; host: string[]; port: string; path: string[]; query: PmQueryItem[]; hash: string };
}
interface PmFormItem extends PmItem { type?: string }
interface PmBody {
  mode: 'none' | 'raw' | 'urlencoded' | 'formdata' | 'binary' | string;
  raw?: string;
  options: { raw?: { language?: string } };
  urlencoded: PmPropertyList<PmFormItem>;
  formdata: PmPropertyList<PmFormItem>;
  update(body: string | { mode?: string; raw?: string; options?: unknown; urlencoded?: Array<PmFormItem | string>; formdata?: Array<PmFormItem | string> }): void;
  isEmpty(): boolean;
  toString(): string;
  toJSON(): unknown;
}
interface PmAuthParam { key: string; value: string | number | boolean; type: 'string' | 'number' | 'boolean' }
/** Read-only view of the request's auth; credential parameters read as "[REDACTED]". */
interface PmRequestAuth {
  readonly type: 'noauth' | 'basic' | 'bearer' | 'apikey' | 'oauth2' | 'oauth1' | 'jwt' | 'awsv4' | 'custom' | 'inherit' | string;
  parameters(): PmPropertyList;
  toJSON(): { type: string } & Record<string, PmAuthParam[]>;
  [type: string]: unknown;
}
interface PmRequest {
  method: string;
  url: PmUrl & { toString(): string };
  headers: PmPropertyList;
  body: PmBody;
  /** Present when the request defines its own auth. */
  readonly auth: PmRequestAuth | undefined;
  getHeaders(options?: { ignoreCase?: boolean; enabled?: boolean }): Record<string, string>;
  addHeader(header: PmItem | string): void;
  removeHeader(name: string): void;
  toJSON(): { method: string; url: unknown; header: PmItem[]; body: unknown };
}
interface PmCookie { name: string; value: string; domain: string; path: string; expires?: string; secure: boolean; httpOnly: boolean; sameSite?: string }
interface PmCookieInput { name?: string; key?: string; value: unknown; domain?: string; path?: string; expires?: string | number | Date; maxAge?: number; secure?: boolean; sameSite?: string }
type PmCallback<T> = (error: Error | null, value: T) => void;
/** Workspace cookie jar. httpOnly cookies are invisible and cannot be changed by scripts; every write is audited. */
interface PmCookieJar {
  get(url: string, name: string): Promise<string | undefined>;
  get(url: string, name: string, callback: PmCallback<string | undefined>): void;
  getAll(url: string, options?: unknown): Promise<PmCookie[]>;
  getAll(url: string, callback: PmCallback<PmCookie[]>): void;
  getAll(url: string, options: unknown, callback: PmCallback<PmCookie[]>): void;
  set(url: string, name: string, value: unknown): Promise<PmCookie | undefined>;
  set(url: string, name: string, value: unknown, callback: PmCallback<PmCookie | undefined>): void;
  set(url: string, cookie: PmCookieInput): Promise<PmCookie | undefined>;
  set(url: string, cookie: PmCookieInput, callback: PmCallback<PmCookie | undefined>): void;
  unset(url: string, name: string): Promise<void>;
  unset(url: string, name: string, callback: PmCallback<void>): void;
  clear(url: string): Promise<void>;
  clear(url: string, callback: PmCallback<void>): void;
}
interface PmCookies {
  get(name: string): string | undefined;
  one(name: string): PmCookie | undefined;
  has(name: string): boolean;
  count(): number;
  all(): PmCookie[];
  each(fn: (cookie: PmCookie) => void): void;
  map<R>(fn: (cookie: PmCookie) => R): R[];
  filter(fn: (cookie: PmCookie) => boolean): PmCookie[];
  toObject(): Record<string, string>;
  toJSON(): PmCookie[];
  jar(): PmCookieJar;
  [Symbol.iterator](): Iterator<PmCookie>;
}
interface PmResponseAssertion {
  readonly not: PmResponseAssertion;
  readonly to: PmResponseAssertion;
  readonly be: PmResponseAssertion;
  readonly have: PmResponseAssertion;
  readonly been: PmResponseAssertion;
  readonly is: PmResponseAssertion;
  readonly that: PmResponseAssertion;
  readonly which: PmResponseAssertion;
  readonly and: PmResponseAssertion;
  readonly has: PmResponseAssertion;
  readonly with: PmResponseAssertion;
  readonly at: PmResponseAssertion;
  readonly of: PmResponseAssertion;
  readonly same: PmResponseAssertion;
  readonly does: PmResponseAssertion;
  status(codeOrReason: number | string): PmResponseAssertion;
  header(name: string, value?: string): PmResponseAssertion;
  body(expected?: string | RegExp): PmResponseAssertion;
  jsonBody(): PmResponseAssertion;
  jsonBody(path: string, value?: unknown): PmResponseAssertion;
  jsonBody(deepEqual: unknown): PmResponseAssertion;
  /** Draft-06/07 via ajv (incl. $ref and format); draft-04 via tv4. options are ajv options. */
  jsonSchema(schema: object, options?: object): PmResponseAssertion;
  readonly withBody: PmResponseAssertion;
  readonly json: PmResponseAssertion;
  readonly ok: PmResponseAssertion;
  readonly success: PmResponseAssertion;
  readonly error: PmResponseAssertion;
  readonly info: PmResponseAssertion;
  readonly redirection: PmResponseAssertion;
  readonly clientError: PmResponseAssertion;
  readonly serverError: PmResponseAssertion;
  readonly accepted: PmResponseAssertion;
  readonly badRequest: PmResponseAssertion;
  readonly unauthorized: PmResponseAssertion;
  readonly forbidden: PmResponseAssertion;
  readonly notFound: PmResponseAssertion;
  readonly rateLimited: PmResponseAssertion;
}
interface PmResponse {
  code: number;
  status: string;
  responseTime: number;
  responseSize: number;
  headers: PmPropertyList;
  cookies: Omit<PmCookies, 'jar'>;
  json(): any;
  text(): string;
  reason(): string;
  size(): { body: number; header: number; total: number };
  readonly to: PmResponseAssertion;
  toJSON(): { code: number; status: string; header: PmItem[]; responseTime: number; responseSize: number };
}
interface PmSendRequestAuth {
  type: 'basic' | 'bearer' | 'apikey' | 'noauth';
  username?: string; password?: string; token?: string; key?: string; value?: string; in?: 'header' | 'query';
  basic?: PmItem[] | Record<string, string>; bearer?: PmItem[] | Record<string, string>; apikey?: PmItem[] | Record<string, string>;
}
interface PmSendRequestOptions {
  url: string | { raw: string } | PmUrl;
  method?: string;
  header?: Record<string, string> | Array<PmItem | string>;
  headers?: Record<string, string> | Array<PmItem | string>;
  body?: string | { mode: 'raw'; raw: string } | { mode: 'urlencoded'; urlencoded: Array<PmFormItem | string> | Record<string, string> } | { mode: 'formdata'; formdata: Array<PmFormItem | string> | Record<string, string> };
  /** Applied inside the sandbox: basic, bearer or apikey (header/query). */
  auth?: PmSendRequestAuth;
  timeout?: number;
}
interface PmTest {
  (name: string, fn: (() => void | Promise<unknown>) | ((done: (error?: unknown) => void) => void)): void;
  skip(name: string, fn?: unknown): void;
  index(): number;
}
interface PmVisualizer {
  /** Render a Handlebars template (shown in the Visualize tab; scripts never run there). Output is capped at 2 MiB. */
  set(template: string, data?: unknown, options?: object): void;
  clear(): void;
}
declare const pm: {
  info: { eventName: 'prerequest' | 'test'; iteration: number; iterationCount: number; requestName: string; requestId: string };
  variables: PmScope;
  environment: PmEnvironment;
  collectionVariables: PmScope;
  globals: PmScope;
  iterationData: PmIterationData;
  request: PmRequest;
  /** Only defined in post-response (test) scripts. */
  response: PmResponse;
  cookies: PmCookies;
  test: PmTest;
  expect: Chai.ExpectStatic;
  sendRequest(request: string | PmSendRequestOptions): Promise<PmResponse>;
  sendRequest(request: string | PmSendRequestOptions, callback: (error: Error | null, response: PmResponse) => void): void;
  execution: { setNextRequest(name: string | null): void; skipRequest(): void; location: string[] & { current: string } };
  visualizer: PmVisualizer;
  /** Postman package library: not supported in Aegis (throws). Use require() for bundled libraries. */
  require(name: string): never;
};
declare const expect: Chai.ExpectStatic;
declare namespace Chai {
  interface Assertion {
    to: Assertion; be: Assertion; been: Assertion; is: Assertion; that: Assertion; which: Assertion; and: Assertion; has: Assertion; have: Assertion; with: Assertion; at: Assertion; of: Assertion; same: Assertion; but: Assertion; does: Assertion; still: Assertion; also: Assertion;
    not: Assertion; deep: Assertion; nested: Assertion; own: Assertion; ordered: Assertion; any: Assertion; all: Assertion;
    ok: Assertion; true: Assertion; false: Assertion; null: Assertion; undefined: Assertion; NaN: Assertion; exist: Assertion; empty: Assertion; arguments: Assertion; finite: Assertion;
    a(type: string, message?: string): Assertion; an(type: string, message?: string): Assertion;
    equal(value: unknown, message?: string): Assertion; equals(value: unknown): Assertion; eq(value: unknown): Assertion; eql(value: unknown, message?: string): Assertion; eqls(value: unknown): Assertion;
    above(n: number | Date): Assertion; gt(n: number): Assertion; greaterThan(n: number): Assertion; least(n: number | Date): Assertion; gte(n: number): Assertion;
    below(n: number | Date): Assertion; lt(n: number): Assertion; lessThan(n: number): Assertion; most(n: number | Date): Assertion; lte(n: number): Assertion;
    within(start: number, finish: number): Assertion; closeTo(expected: number, delta: number): Assertion; approximately(expected: number, delta: number): Assertion;
    include(value: unknown, message?: string): Assertion; includes(value: unknown): Assertion; contain(value: unknown): Assertion; contains(value: unknown): Assertion;
    property(name: string, value?: unknown): Assertion; ownProperty(name: string): Assertion; haveOwnProperty(name: string): Assertion; ownPropertyDescriptor(name: string): Assertion;
    length(n: number): Assertion; lengthOf(n: number): Assertion; match(re: RegExp): Assertion; matches(re: RegExp): Assertion; string(s: string): Assertion;
    keys(...keys: Array<string | string[] | object>): Assertion; key(key: string): Assertion;
    throw(error?: unknown, message?: string | RegExp): Assertion; throws(error?: unknown): Assertion; Throw(error?: unknown): Assertion;
    respondTo(method: string): Assertion; itself: Assertion; satisfy(fn: (value: unknown) => boolean): Assertion; members(set: unknown[]): Assertion; oneOf(list: unknown[]): Assertion;
    instanceof(ctor: unknown): Assertion; instanceOf(ctor: unknown): Assertion; change(target: object, prop?: string): Assertion; increase(target: object, prop?: string): Assertion; decrease(target: object, prop?: string): Assertion;
    extensible: Assertion; sealed: Assertion; frozen: Assertion; by(delta: number): Assertion;
  }
  interface ExpectStatic { (value: unknown, message?: string): Assertion; fail(message?: string): never }
}
/** Legacy Postman API (still supported). */
declare const postman: {
  setEnvironmentVariable(key: string, value: unknown): void; getEnvironmentVariable(key: string): string | undefined; clearEnvironmentVariable(key: string): void; clearEnvironmentVariables(): void;
  setGlobalVariable(key: string, value: unknown): void; getGlobalVariable(key: string): string | undefined; clearGlobalVariable(key: string): void; clearGlobalVariables(): void;
  setNextRequest(name: string | null): void; getResponseHeader(name: string): string | null;
};
declare const tests: Record<string, unknown>;
declare const responseBody: string;
declare const responseCode: { code: number; name: string; detail: string };
declare const responseHeaders: Record<string, string>;
declare const responseTime: number;
declare function setTimeout(fn: (...args: any[]) => void, ms?: number, ...args: any[]): number;
declare function clearTimeout(id: number): void;
declare function queueMicrotask(fn: () => void): void;
declare function atob(data: string): string;
declare function btoa(data: string): string;
declare class TextEncoder { readonly encoding: 'utf-8'; encode(input?: string): Uint8Array }
declare class TextDecoder { constructor(label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean }); readonly encoding: 'utf-8'; decode(input?: ArrayBuffer | ArrayBufferView): string }
declare class URLSearchParams {
  constructor(init?: string | URLSearchParams | Record<string, string> | Iterable<[string, string]>);
  readonly size: number; append(name: string, value: string): void; delete(name: string): void; get(name: string): string | null; getAll(name: string): string[]; has(name: string): boolean; set(name: string, value: string): void; sort(): void;
  forEach(fn: (value: string, key: string) => void): void; keys(): Iterator<string>; values(): Iterator<string>; entries(): Iterator<[string, string]>; toString(): string; [Symbol.iterator](): Iterator<[string, string]>;
}
declare class URL {
  constructor(url: string, base?: string);
  readonly protocol: string; readonly username: string; readonly password: string; readonly hostname: string; readonly port: string; readonly host: string; readonly origin: string;
  pathname: string; search: string; hash: string; readonly searchParams: URLSearchParams; readonly href: string; toString(): string; toJSON(): string;
}
interface Console { log(...args: unknown[]): void; info(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void; debug(...args: unknown[]): void; dir(...args: unknown[]): void; trace(...args: unknown[]): void }
declare const console: Console;

// ---- Libraries (bundled, loaded on first use) ----
type BufferEncoding = 'utf8' | 'utf-8' | 'hex' | 'base64' | 'base64url' | 'latin1' | 'binary' | 'ascii' | 'ucs2' | 'utf16le';
/** Node-compatible subset: from/alloc/concat/byteLength/isBuffer, toString(encoding), slice, equals, readUInt*, writeUInt*, indexOf. */
declare class Buffer extends Uint8Array {
  static from(value: string | ArrayBuffer | ArrayBufferView | number[] | { type: 'Buffer'; data: number[] }, encodingOrOffset?: BufferEncoding | number, length?: number): Buffer;
  static alloc(size: number, fill?: string | number, encoding?: BufferEncoding): Buffer;
  static allocUnsafe(size: number): Buffer;
  static isBuffer(value: unknown): value is Buffer;
  static isEncoding(encoding: string): boolean;
  static byteLength(value: string | ArrayBuffer | ArrayBufferView, encoding?: BufferEncoding): number;
  static concat(list: Uint8Array[], totalLength?: number): Buffer;
  static compare(a: Uint8Array, b: Uint8Array): number;
  toString(encoding?: BufferEncoding, start?: number, end?: number): string;
  toJSON(): { type: 'Buffer'; data: number[] };
  equals(other: Uint8Array): boolean;
  compare(other: Uint8Array): number;
  slice(start?: number, end?: number): Buffer;
  subarray(start?: number, end?: number): Buffer;
  write(string: string, offset?: number, length?: number, encoding?: BufferEncoding): number;
  fill(value: string | number | Uint8Array, offset?: number, end?: number, encoding?: BufferEncoding): this;
  indexOf(value: string | number | Uint8Array, byteOffset?: number, encoding?: BufferEncoding): number;
  includes(value: string | number | Uint8Array, byteOffset?: number, encoding?: BufferEncoding): boolean;
  readUInt8(offset?: number): number; readUInt16BE(offset?: number): number; readUInt16LE(offset?: number): number; readUInt32BE(offset?: number): number; readUInt32LE(offset?: number): number;
  readInt8(offset?: number): number; readInt16BE(offset?: number): number; readInt16LE(offset?: number): number; readInt32BE(offset?: number): number; readInt32LE(offset?: number): number;
  writeUInt8(value: number, offset?: number): number; writeUInt16BE(value: number, offset?: number): number; writeUInt16LE(value: number, offset?: number): number; writeUInt32BE(value: number, offset?: number): number; writeUInt32LE(value: number, offset?: number): number;
}
interface CryptoJSWordArray { words: number[]; sigBytes: number; toString(encoder?: CryptoJSEncoder): string; concat(w: CryptoJSWordArray): CryptoJSWordArray; clone(): CryptoJSWordArray }
interface CryptoJSEncoder { stringify(w: CryptoJSWordArray): string; parse(s: string): CryptoJSWordArray }
type CryptoJSHasher = ((message: string | CryptoJSWordArray, options?: object) => CryptoJSWordArray) & { create(options?: object): { update(m: string | CryptoJSWordArray): any; finalize(m?: string | CryptoJSWordArray): CryptoJSWordArray } };
type CryptoJSHmac = (message: string | CryptoJSWordArray, key: string | CryptoJSWordArray) => CryptoJSWordArray;
interface CryptoJSCipher {
  encrypt(message: string | CryptoJSWordArray, key: string | CryptoJSWordArray, options?: { iv?: CryptoJSWordArray; mode?: unknown; padding?: unknown; format?: unknown }): { toString(formatter?: unknown): string; ciphertext: CryptoJSWordArray; key: CryptoJSWordArray; iv: CryptoJSWordArray; salt?: CryptoJSWordArray };
  decrypt(ciphertext: string | { ciphertext: CryptoJSWordArray }, key: string | CryptoJSWordArray, options?: { iv?: CryptoJSWordArray; mode?: unknown; padding?: unknown; format?: unknown }): CryptoJSWordArray;
}
/** crypto-js 4.2 (full build). SHA3 is Keccak, as in upstream crypto-js. */
interface CryptoJSStatic {
  MD5: CryptoJSHasher; SHA1: CryptoJSHasher; SHA224: CryptoJSHasher; SHA256: CryptoJSHasher; SHA384: CryptoJSHasher; SHA512: CryptoJSHasher; SHA3: CryptoJSHasher; RIPEMD160: CryptoJSHasher;
  HmacMD5: CryptoJSHmac; HmacSHA1: CryptoJSHmac; HmacSHA224: CryptoJSHmac; HmacSHA256: CryptoJSHmac; HmacSHA384: CryptoJSHmac; HmacSHA512: CryptoJSHmac; HmacSHA3: CryptoJSHmac; HmacRIPEMD160: CryptoJSHmac;
  PBKDF2(password: string | CryptoJSWordArray, salt: string | CryptoJSWordArray, options?: { keySize?: number; iterations?: number; hasher?: unknown }): CryptoJSWordArray;
  EvpKDF(password: string | CryptoJSWordArray, salt: string | CryptoJSWordArray, options?: { keySize?: number; iterations?: number; hasher?: unknown }): CryptoJSWordArray;
  AES: CryptoJSCipher; DES: CryptoJSCipher; TripleDES: CryptoJSCipher; Rabbit: CryptoJSCipher; RabbitLegacy: CryptoJSCipher; RC4: CryptoJSCipher; RC4Drop: CryptoJSCipher; Blowfish: CryptoJSCipher;
  enc: { Hex: CryptoJSEncoder; Latin1: CryptoJSEncoder; Utf8: CryptoJSEncoder; Utf16: CryptoJSEncoder; Utf16BE: CryptoJSEncoder; Utf16LE: CryptoJSEncoder; Base64: CryptoJSEncoder; Base64url: CryptoJSEncoder };
  mode: { CBC: unknown; CFB: unknown; CTR: unknown; CTRGladman: unknown; OFB: unknown; ECB: unknown };
  pad: { Pkcs7: unknown; AnsiX923: unknown; Iso10126: unknown; Iso97971: unknown; ZeroPadding: unknown; NoPadding: unknown };
  format: { OpenSSL: unknown; Hex: unknown };
  algo: Record<string, unknown>;
  lib: { WordArray: { create(words?: number[] | ArrayBuffer | ArrayBufferView, sigBytes?: number): CryptoJSWordArray; random(nBytes: number): CryptoJSWordArray }; [k: string]: unknown };
}
declare const CryptoJS: CryptoJSStatic;
/** lodash 4 (see lodash.com/docs). */
declare const _: LoDashStatic;
interface LoDashStatic {
  (value: unknown): any;
  VERSION: string;
  [fn: string]: any;
}
/** moment 2 (see momentjs.com/docs). */
declare const moment: MomentStatic;
interface Moment {
  format(format?: string): string; toISOString(): string; toDate(): Date; valueOf(): number; unix(): number; isValid(): boolean; utc(): Moment; local(): Moment; clone(): Moment;
  add(amount: number, unit: string): Moment; subtract(amount: number, unit: string): Moment; startOf(unit: string): Moment; endOf(unit: string): Moment;
  diff(other: Moment | Date | string | number, unit?: string, precise?: boolean): number; isBefore(other: unknown, unit?: string): boolean; isAfter(other: unknown, unit?: string): boolean; isSame(other: unknown, unit?: string): boolean; isBetween(a: unknown, b: unknown, unit?: string, inclusivity?: string): boolean;
  fromNow(withoutSuffix?: boolean): string; from(other: unknown, withoutSuffix?: boolean): string; calendar(): string;
  year(): number; month(): number; date(): number; day(): number; hour(): number; minute(): number; second(): number; millisecond(): number;
  [fn: string]: any;
}
interface MomentStatic {
  (input?: string | number | Date | Moment, format?: string | string[], strict?: boolean): Moment;
  (input: string, format: string, locale: string, strict?: boolean): Moment;
  utc(input?: string | number | Date | Moment, format?: string | string[], strict?: boolean): Moment;
  unix(seconds: number): Moment;
  duration(amount?: number | string | object, unit?: string): { asMilliseconds(): number; asSeconds(): number; asMinutes(): number; asHours(): number; asDays(): number; humanize(withSuffix?: boolean): string; toISOString(): string; [fn: string]: any };
  isMoment(value: unknown): value is Moment;
  version: string;
  [fn: string]: any;
}
/** tv4 (JSON schema draft-04 validator) with the common formats pre-registered. */
declare const tv4: {
  validate(data: unknown, schema: object, checkRecursive?: boolean, banUnknownProperties?: boolean): boolean;
  validateResult(data: unknown, schema: object): { valid: boolean; error: { message: string; dataPath: string; schemaPath: string } | null; missing: string[] };
  validateMultiple(data: unknown, schema: object, checkRecursive?: boolean, banUnknownProperties?: boolean): { valid: boolean; errors: Array<{ message: string; dataPath: string; schemaPath: string }>; missing: string[] };
  addSchema(uri: string, schema: object): void; addFormat(name: string, validator: (data: unknown) => string | null): void;
  error: { message: string; dataPath: string; schemaPath: string } | null;
  [fn: string]: any;
};
/** Parses XML into an xml2js-shaped object (attributes under "$", text of mixed nodes under "_", values as strings). Throws on malformed XML. */
declare function xml2Json(xml: string | Uint8Array): any;
interface Xml2JsOptions { explicitArray?: boolean; explicitRoot?: boolean; ignoreAttrs?: boolean; attrkey?: string; charkey?: string; trim?: boolean; normalizeTags?: boolean }
interface AjvOptions { allErrors?: boolean; strict?: boolean; validateFormats?: boolean; coerceTypes?: boolean | 'array'; useDefaults?: boolean | 'empty'; removeAdditional?: boolean | 'all' | 'failing'; [option: string]: unknown }
interface AjvValidateFunction { (data: unknown): boolean; errors?: Array<{ instancePath: string; schemaPath: string; keyword: string; params: Record<string, unknown>; message?: string }> | null }
/** ajv 8 with draft-06/07 meta-schemas and the common formats pre-registered. */
declare class Ajv {
  constructor(options?: AjvOptions);
  compile(schema: object): AjvValidateFunction;
  validate(schema: object | string, data: unknown): boolean;
  addSchema(schema: object | object[], key?: string): this;
  addFormat(name: string, format: RegExp | ((data: string) => boolean) | { type?: 'string' | 'number'; validate: RegExp | ((data: any) => boolean) }): this;
  addKeyword(definition: object): this;
  errors?: AjvValidateFunction['errors'];
  errorsText(errors?: AjvValidateFunction['errors'], options?: { separator?: string; dataVar?: string }): string;
}
interface CsvParseOptions {
  delimiter?: string; quote?: string | false; escape?: string | false; comment?: string;
  columns?: boolean | Array<string | { name: string }>; skip_empty_lines?: boolean; trim?: boolean; ltrim?: boolean; rtrim?: boolean;
  relax_column_count?: boolean; from_line?: number; to_line?: number; bom?: boolean;
  cast?: (value: string, context: { lines: number; column: string | number; index: number; records: number }) => unknown;
}
interface UuidStatic {
  v1(): string; v4(): string; v6(): string; v7(): string;
  NIL: string; MAX: string; parse(uuid: string): Uint8Array; stringify(bytes: Uint8Array): string; validate(uuid: string): boolean; version(uuid: string): number;
  v3: { DNS: string; URL: string } & ((name: string | Uint8Array, namespace: string | Uint8Array) => string);
  v5: { DNS: string; URL: string } & ((name: string | Uint8Array, namespace: string | Uint8Array) => string);
}
/**
 * Loads one of the bundled libraries. Anything else (fs, child_process, cheerio, http, ...) throws
 * "Cannot find module". Modules are evaluated on first use and cached for the run.
 */
declare function require(name: 'lodash'): LoDashStatic;
declare function require(name: 'moment'): MomentStatic;
declare function require(name: 'crypto-js'): CryptoJSStatic;
declare function require(name: 'uuid'): UuidStatic;
declare function require(name: 'ajv'): typeof Ajv;
declare function require(name: 'tv4'): typeof tv4;
declare function require(name: 'xml2js'): {
  parseString(xml: string | Uint8Array, callback: (error: Error | null, result: any) => void): void;
  parseString(xml: string | Uint8Array, options: Xml2JsOptions, callback: (error: Error | null, result: any) => void): void;
  parseStringPromise(xml: string | Uint8Array, options?: Xml2JsOptions): Promise<any>;
  Parser: new (options?: Xml2JsOptions) => { parseString(xml: string | Uint8Array, callback: (error: Error | null, result: any) => void): void; parseStringPromise(xml: string | Uint8Array): Promise<any> };
  Builder: new (options?: { attrkey?: string; charkey?: string; renderOpts?: { pretty?: boolean } }) => { buildObject(value: unknown): string };
};
declare function require(name: 'chai'): { expect: Chai.ExpectStatic; Assertion: unknown; AssertionError: new (message: string) => Error; use(plugin: unknown): void };
declare function require(name: 'atob'): typeof atob;
declare function require(name: 'btoa'): typeof btoa;
declare function require(name: 'buffer'): { Buffer: typeof Buffer };
declare function require(name: 'csv-parse/lib/sync'): (input: string | Uint8Array, options?: CsvParseOptions) => any[];
declare function require(name: 'csv-parse/sync'): { parse(input: string | Uint8Array, options?: CsvParseOptions): any[] };
declare function require(name: string): never;
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
  // --- Postman-style variable snippets (added by the script-experience work; keep titles unique) ---
  { title: 'Unset environment variable', phases: ['prerequest', 'test'], code: "pm.environment.unset('variable_key');\n" },
  { title: 'Get global variable', phases: ['prerequest', 'test'], code: "const value = pm.globals.get('variable_key');\n" },
  { title: 'Unset global variable', phases: ['prerequest', 'test'], code: "pm.globals.unset('variable_key');\n" },
  { title: 'Get collection variable', phases: ['prerequest', 'test'], code: "const value = pm.collectionVariables.get('variable_key');\n" },
  { title: 'Unset collection variable', phases: ['prerequest', 'test'], code: "pm.collectionVariables.unset('variable_key');\n" },
  { title: 'Get a variable (any scope)', phases: ['prerequest', 'test'], code: "const value = pm.variables.get('variable_key');\n" },
  { title: 'Set local variable (this run only)', phases: ['prerequest', 'test'], code: "pm.variables.set('variable_key', 'variable_value');\n" },
  { title: 'Unset local variable', phases: ['prerequest', 'test'], code: "pm.variables.unset('variable_key');\n" },
  { title: 'Replace variables in string', phases: ['prerequest', 'test'], code: "const resolved = pm.variables.replaceIn('{{baseUrl}}/users/{{$guid}}');\n" },
  { title: 'Dynamic variable ($guid / $timestamp)', phases: ['prerequest', 'test'], code: "const id = pm.variables.replaceIn('{{$guid}}');\nconst now = pm.variables.replaceIn('{{$timestamp}}');\n" },
  { title: 'Set environment variable from JSON response', phases: ['test'], code: "const json = pm.response.json();\npm.environment.set('userId', json.data.id);\n" },
  { title: 'Save token from response', phases: ['test'], code: "const json = pm.response.json();\nif (json.token) {\n  pm.environment.set('token', json.token);\n} else {\n  console.warn('No token in response');\n}\n" },
  { title: 'Send request (pm.sendRequest) and save result', phases: ['prerequest', 'test'], code: "pm.sendRequest({ url: pm.variables.replaceIn('{{baseUrl}}/auth/token'), method: 'POST', header: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: 'name' }) }, function (err, res) {\n  if (!err) pm.environment.set('token', res.json().token);\n});\n" },
  { title: 'Test: status code', phases: ['test'], code: "pm.test('Status code is 201', function () {\n  pm.response.to.have.status(201);\n});\n" },
  { title: 'Test: response time', phases: ['test'], code: "pm.test('Response time is below 1000 ms', function () {\n  pm.expect(pm.response.responseTime).to.be.below(1000);\n});\n" },
  { title: 'Test: header value', phases: ['test'], code: "pm.test('Header is present', function () {\n  pm.response.to.have.header('Content-Type');\n});\n" },
  { title: 'Test: JSON value', phases: ['test'], code: "pm.test('JSON value matches', function () {\n  const json = pm.response.json();\n  pm.expect(json.status).to.eql('ok');\n});\n" },
  { title: 'Test: JSON schema', phases: ['test'], code: "const schema = {\n  type: 'object',\n  required: ['id'],\n  properties: { id: { type: 'number' } },\n};\npm.test('Body matches schema', function () {\n  pm.response.to.have.jsonSchema(schema);\n});\n" },
  // --- Postman parity snippets (libraries, cookie jar, visualizer, sendRequest auth); titles follow Postman's list where one exists ---
  { title: 'Status code: Successful POST request', phases: ['test'], code: "pm.test('Successful POST request', () => {\n  pm.expect(pm.response.code).to.be.oneOf([201, 202]);\n});\n" },
  { title: 'Status code: Code name has string', phases: ['test'], code: "pm.test('Status code name has string', () => {\n  pm.response.to.have.status('Created');\n});\n" },
  { title: 'Response body: Contains string', phases: ['test'], code: "pm.test('Body matches string', () => {\n  pm.expect(pm.response.text()).to.include('string_you_want_to_search');\n});\n" },
  { title: 'Response body: Is equal to a string', phases: ['test'], code: "pm.test('Body is correct', () => {\n  pm.response.to.have.body('response_body_string');\n});\n" },
  { title: 'Response body: Convert XML body to a JSON Object', phases: ['test'], code: 'const jsonObject = xml2Json(pm.response.text());\n' },
  {
    title: 'Use Tiny Validator for JSON data',
    phases: ['test'],
    code: "const schema = {\n  items: {\n    type: 'boolean',\n  },\n};\n\nconst data1 = [true, false];\nconst data2 = [true, 123];\n\npm.test('Schema is valid', () => {\n  pm.expect(tv4.validate(data1, schema)).to.be.true;\n  pm.expect(tv4.validate(data2, schema)).to.be.true;\n});\n",
  },
  {
    title: 'Response body: validate JSON schema ($ref, format)',
    phases: ['test'],
    code: "const schema = {\n  definitions: { id: { type: 'integer', minimum: 1 } },\n  type: 'object',\n  required: ['id'],\n  properties: {\n    id: { $ref: '#/definitions/id' },\n    email: { type: 'string', format: 'email' },\n  },\n};\n\npm.test('Response matches schema', () => {\n  pm.response.to.have.jsonSchema(schema);\n});\n",
  },
  {
    title: 'Visualize response (Handlebars)',
    phases: ['test'],
    code: "const template = `\n<table>\n  <tr><th>Name</th><th>Value</th></tr>\n  {{#each items}}\n  <tr><td>{{name}}</td><td>{{value}}</td></tr>\n  {{/each}}\n</table>`;\n\npm.visualizer.set(template, { items: pm.response.json() });\n",
  },
  {
    title: 'Sign a payload (HMAC-SHA256)',
    phases: ['prerequest'],
    code: "const signature = CryptoJS.HmacSHA256(pm.request.body.toString(), pm.environment.get('signingSecret')).toString();\npm.request.headers.upsert({ key: 'X-Signature', value: signature });\n",
  },
  { title: 'Hash a value (SHA-256 / Base64)', phases: ['prerequest', 'test'], code: "const digest = CryptoJS.SHA256('text').toString();\nconst base64 = CryptoJS.enc.Base64.stringify(CryptoJS.enc.Utf8.parse('text'));\n" },
  { title: 'Generate a UUID', phases: ['prerequest', 'test'], code: "const { v4: uuidv4 } = require('uuid');\npm.variables.set('requestId', uuidv4());\n" },
  { title: 'Format a date (moment)', phases: ['prerequest', 'test'], code: "const moment = require('moment');\npm.variables.set('today', moment().utc().format('YYYY-MM-DD'));\n" },
  { title: 'Lodash helper', phases: ['prerequest', 'test'], code: "const ids = _.map(pm.response.json().items, 'id');\nconsole.log(_.uniq(ids));\n" },
  { title: 'Parse CSV data', phases: ['prerequest', 'test'], code: "const parse = require('csv-parse/lib/sync');\nconst rows = parse(pm.response.text(), { columns: true, skip_empty_lines: true });\n" },
  { title: 'Encode / decode Base64 (Buffer)', phases: ['prerequest', 'test'], code: "const encoded = Buffer.from('user:password', 'utf8').toString('base64');\nconst decoded = Buffer.from(encoded, 'base64').toString('utf8');\n" },
  {
    title: 'Set a cookie in the jar',
    phases: ['prerequest', 'test'],
    code: "const jar = pm.cookies.jar();\nawait jar.set(pm.environment.get('baseUrl'), { name: 'session', value: pm.environment.get('sessionId'), secure: true });\n",
  },
  { title: 'Read cookies from the jar', phases: ['prerequest', 'test'], code: "const jar = pm.cookies.jar();\nconst cookies = await jar.getAll(pm.environment.get('baseUrl'));\nconsole.log(cookies.map((c) => c.name));\n" },
  {
    title: 'Send a request with auth',
    phases: ['prerequest', 'test'],
    code: "const res = await pm.sendRequest({\n  url: pm.environment.get('baseUrl') + '/me',\n  method: 'GET',\n  auth: { type: 'bearer', token: pm.environment.get('token') },\n});\nconsole.log(res.code, res.json());\n",
  },
  { title: 'Read request auth (masked)', phases: ['prerequest', 'test'], code: "const auth = pm.request.auth;\nconsole.log(auth ? auth.type : 'no auth', auth && auth.parameters().toObject());\n" },
];
