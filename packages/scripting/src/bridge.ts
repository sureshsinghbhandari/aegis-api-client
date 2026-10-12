import type {
  ConsoleEntry,
  HeaderPair,
  ScriptCookie,
  ScriptCookieInput,
  ScriptCookieJarOp,
  ScriptCookieJarResult,
  ScriptRunInput,
  ScriptSendRequest,
  ScriptSendResponse,
} from '@aegis/core';
import { redactText, redactUrl } from '@aegis/security';
import { createDefaultDynamicRegistry } from '@aegis/variables';
import { randomBytes } from 'node:crypto';
import type { QuickJSContext, QuickJSDeferredPromise, QuickJSHandle } from 'quickjs-emscripten';
import { SANDBOX_LIBS } from './generated/libs-bundle';
import {
  MAX_CONSOLE_ENTRIES,
  MAX_CONSOLE_MESSAGE_CHARS,
  MAX_COOKIE_OPS,
  MAX_PENDING_TIMERS,
  MAX_RANDOM_BYTES_PER_CALL,
  MAX_RANDOM_CALLS,
  MAX_STACK_BYTES,
} from './limits';

const dynamicRegistry = createDefaultDynamicRegistry();
const LEVELS = new Set<ConsoleEntry['level']>(['log', 'info', 'warn', 'error', 'debug']);
/** Messages are cut to this size BEFORE redaction (bounds regex work); the final cut happens after. */
const PRE_REDACTION_CHARS = 64 * 1024;
const TRUNCATION_SUFFIX = '... [truncated]';
const MAX_ERROR_MESSAGE_CHARS = 2048;
const MAX_COOKIE_URL_CHARS = 8192;
const MAX_COOKIE_NAME_CHARS = 4096;
const MAX_COOKIE_VALUE_CHARS = 64 * 1024;

export interface GuestErrorInfo {
  name: string;
  message: string;
  stack: string;
}

export interface BridgeCallbacks {
  /** A guest exception escaped a callback. Takes ownership of (and must dispose) the handle. */
  onGuestException(error: QuickJSHandle): void;
  /** Guest reported an uncaught async error (JSON describing it). */
  onUncaught(info: GuestErrorInfo): void;
  /** A VM call made from a host callback threw (native stack overflow, trap): the interpreter state is unusable. */
  onHostFailure(error: unknown): void;
  /** Something happened that the run loop should look at. */
  wake(): void;
  remainingMs(): number;
}

interface TimerEntry {
  timer: ReturnType<typeof setTimeout>;
  callback: QuickJSHandle;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function headerPairs(v: unknown): HeaderPair[] {
  if (!Array.isArray(v)) throw new Error('Invalid request: "headers" must be an array');
  const out: HeaderPair[] = [];
  for (const h of v) {
    if (!isRecord(h) || typeof h.name !== 'string' || typeof h.value !== 'string') throw new Error('Invalid request header');
    out.push({ name: h.name, value: h.value });
  }
  return out;
}

function formEntries(v: unknown): Array<{ key: string; value: string }> {
  if (!Array.isArray(v)) throw new Error('Invalid request body entries');
  const out: Array<{ key: string; value: string }> = [];
  for (const e of v) {
    if (!isRecord(e) || typeof e.key !== 'string' || typeof e.value !== 'string') throw new Error('Invalid request body entry');
    out.push({ key: e.key, value: e.value });
  }
  return out;
}

/** Validate the (untrusted) request object produced by the guest. */
export function parseSendRequest(json: string): ScriptSendRequest {
  const raw: unknown = JSON.parse(json);
  if (!isRecord(raw) || typeof raw.url !== 'string' || raw.url === '' || typeof raw.method !== 'string') {
    throw new Error('Invalid pm.sendRequest request');
  }
  const request: ScriptSendRequest = { url: raw.url, method: raw.method, headers: headerPairs(raw.headers) };
  if (raw.body !== undefined) {
    const b = raw.body;
    if (!isRecord(b)) throw new Error('Invalid request body');
    if (b.mode === 'raw' && typeof b.raw === 'string') request.body = { mode: 'raw', raw: b.raw };
    else if (b.mode === 'urlencoded') request.body = { mode: 'urlencoded', urlencoded: formEntries(b.urlencoded) };
    else if (b.mode === 'formdata') request.body = { mode: 'formdata', formdata: formEntries(b.formdata) };
    else throw new Error('Invalid request body mode');
  }
  if (typeof raw.timeoutMs === 'number' && Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0) request.timeoutMs = raw.timeoutMs;
  return request;
}

function boundedString(v: unknown, what: string, max: number): string {
  if (typeof v !== 'string') throw new Error(`Invalid cookie jar operation: "${what}" must be a string`);
  if (v.length > max) throw new Error(`Invalid cookie jar operation: "${what}" is too long (limit ${max} characters)`);
  return v;
}

function parseCookieInput(v: unknown): ScriptCookieInput {
  if (!isRecord(v)) throw new Error('Invalid cookie jar operation: "cookie" must be an object');
  const cookie: ScriptCookieInput = {
    name: boundedString(v.name, 'cookie.name', MAX_COOKIE_NAME_CHARS),
    value: boundedString(v.value, 'cookie.value', MAX_COOKIE_VALUE_CHARS),
  };
  if (cookie.name === '') throw new Error('Invalid cookie jar operation: cookie name is required');
  if (v.httpOnly === true) throw new Error('Scripts cannot set httpOnly cookies');
  if (v.domain !== undefined) cookie.domain = boundedString(v.domain, 'cookie.domain', MAX_COOKIE_NAME_CHARS);
  if (v.path !== undefined) cookie.path = boundedString(v.path, 'cookie.path', MAX_COOKIE_NAME_CHARS);
  if (v.expires !== undefined) cookie.expires = boundedString(v.expires, 'cookie.expires', 64);
  if (v.sameSite !== undefined) cookie.sameSite = boundedString(v.sameSite, 'cookie.sameSite', 16);
  if (v.maxAge !== undefined) {
    if (typeof v.maxAge !== 'number' || !Number.isFinite(v.maxAge)) throw new Error('Invalid cookie jar operation: "cookie.maxAge" must be a number');
    cookie.maxAge = v.maxAge;
  }
  if (v.secure !== undefined) cookie.secure = v.secure === true;
  return cookie;
}

/** Validate the (untrusted) cookie-jar operation produced by the guest. */
export function parseCookieJarOp(json: string): ScriptCookieJarOp {
  const raw: unknown = JSON.parse(json);
  if (!isRecord(raw)) throw new Error('Invalid cookie jar operation');
  const url = boundedString(raw.url, 'url', MAX_COOKIE_URL_CHARS);
  if (url === '') throw new Error('Invalid cookie jar operation: "url" is required');
  switch (raw.op) {
    case 'get':
      return { op: 'get', url, name: boundedString(raw.name, 'name', MAX_COOKIE_NAME_CHARS) };
    case 'getAll':
      return { op: 'getAll', url };
    case 'set':
      return { op: 'set', url, cookie: parseCookieInput(raw.cookie) };
    case 'unset':
      return { op: 'unset', url, name: boundedString(raw.name, 'name', MAX_COOKIE_NAME_CHARS) };
    case 'clear':
      return { op: 'clear', url };
    default:
      throw new Error('Invalid cookie jar operation');
  }
}

function sanitizeCookies(cookies: readonly ScriptCookie[] | undefined): ScriptCookie[] {
  return (cookies ?? [])
    .filter((c) => isRecord(c) && c.httpOnly !== true)
    .map((c) => ({
      name: String(c.name),
      value: String(c.value),
      domain: String(c.domain ?? ''),
      path: String(c.path ?? '/'),
      ...(typeof c.expires === 'string' ? { expires: c.expires } : {}),
      secure: c.secure === true,
      httpOnly: false,
      ...(typeof c.sameSite === 'string' ? { sameSite: c.sameSite } : {}),
    }));
}

function sanitizeResponse(res: ScriptSendResponse): ScriptSendResponse {
  return {
    code: Number(res.code),
    status: String(res.status ?? ''),
    headers: (res.headers ?? []).map((h) => ({ name: String(h.name), value: String(h.value) })),
    bodyText: String(res.bodyText ?? ''),
    responseTimeMs: Number(res.responseTimeMs) || 0,
    responseSizeBytes: Number(res.responseSizeBytes) || 0,
    cookies: sanitizeCookies(res.cookies),
  };
}

/**
 * Host functions exposed to the prelude (only the prelude receives them; it
 * keeps them in a closure). Every argument is untrusted guest data.
 */
export class HostBridge {
  readonly consoleEntries: ConsoleEntry[] = [];
  /** Outstanding timers and nested requests; the run is not complete while > 0. */
  pendingOps = 0;
  private finished = false;
  private disposed = false;
  private requestCount = 0;
  private cookieOpCount = 0;
  private randomCalls = 0;
  private nextTimerId = 0;
  private consoleTruncated = false;
  private readonly timers = new Map<number, TimerEntry>();
  private readonly deferreds: QuickJSDeferredPromise[] = [];
  private readonly secrets: string[];

  constructor(
    private readonly ctx: QuickJSContext,
    private readonly input: ScriptRunInput,
    private readonly abort: AbortController,
    private readonly maxSendRequests: number,
    private readonly maxStackSizeBytes: number,
    private readonly callbacks: BridgeCallbacks,
  ) {
    this.secrets = (input.secretValues ?? []).filter((s) => s.length > 0);
  }

  redact(text: string): string {
    return redactText(text, this.secrets, []);
  }

  private readString(h: QuickJSHandle, maxChars: number): string | undefined {
    if (this.ctx.typeof(h) !== 'string') return undefined;
    const s = this.ctx.getString(h);
    return s.length > maxChars ? s.slice(0, maxChars) : s;
  }

  /** Builds the `host` object handed to the prelude. The caller owns (and must dispose) the returned handle. */
  install(): QuickJSHandle {
    const ctx = this.ctx;
    const host = ctx.newObject();
    const define = (name: string, fn: (...args: QuickJSHandle[]) => QuickJSHandle | undefined): void => {
      const handle = ctx.newFunction(name, fn);
      ctx.setProp(host, name, handle);
      handle.dispose();
    };

    define('log', (levelH, messageH) => {
      const level = levelH ? this.readString(levelH, 16) : undefined;
      const message = messageH ? this.readString(messageH, 10 * PRE_REDACTION_CHARS) : undefined;
      if (level !== undefined && message !== undefined) this.addConsole(level, message);
      return undefined;
    });

    define('dynamic', (nameH) => {
      const name = nameH ? this.readString(nameH, 256) : undefined;
      if (!name) return undefined;
      const value = dynamicRegistry.resolve(name);
      return value === undefined ? undefined : ctx.newString(value);
    });

    define('uncaught', (jsonH) => {
      const json = jsonH ? this.readString(jsonH, 64 * 1024) : undefined;
      if (json === undefined) return undefined;
      try {
        const parsed: unknown = JSON.parse(json);
        if (isRecord(parsed)) {
          this.callbacks.onUncaught({
            name: typeof parsed.name === 'string' ? parsed.name : 'Error',
            message: typeof parsed.message === 'string' ? parsed.message : '',
            stack: typeof parsed.stack === 'string' ? parsed.stack : '',
          });
        }
      } catch {
        /* ignore malformed report */
      }
      return undefined;
    });

    define('setTimeout', (fnH, msH) => {
      if (!fnH || ctx.typeof(fnH) !== 'function') throw new TypeError('setTimeout() requires a function');
      if (this.timers.size >= MAX_PENDING_TIMERS) throw new Error('Too many pending timers');
      const requested = msH && ctx.typeof(msH) === 'number' ? ctx.getNumber(msH) : 0;
      const ms = Math.max(0, Math.min(Number.isFinite(requested) ? requested : 0, this.callbacks.remainingMs()));
      const id = ++this.nextTimerId;
      const callback = fnH.dup();
      const timer = setTimeout(() => this.fireTimer(id), ms);
      this.timers.set(id, { timer, callback });
      this.pendingOps++;
      return ctx.newNumber(id);
    });

    define('clearTimeout', (idH) => {
      const id = idH && ctx.typeof(idH) === 'number' ? ctx.getNumber(idH) : -1;
      const entry = this.timers.get(id);
      if (entry) {
        clearTimeout(entry.timer);
        entry.callback.dispose();
        this.timers.delete(id);
        this.pendingOps--;
        this.callbacks.wake();
      }
      return undefined;
    });

    define('sendRequest', (jsonH) => this.sendRequest(jsonH ? this.readString(jsonH, 8 * 1024 * 1024) : undefined));
    define('cookieJar', (jsonH) => this.cookieJar(jsonH ? this.readString(jsonH, 256 * 1024) : undefined));

    // Library loader: evaluates a committed, esbuild-generated bundle (see scripts/build-sandbox-libs.mjs) at
    // global scope and returns its factory function. The bundle never sees `host`; the prelude calls the
    // factory with a minimal `crypto.getRandomValues` shim. Only names from the generated allow-list load.
    define('requireLib', (nameH) => {
      const name = nameH ? this.readString(nameH, 64) : undefined;
      const source = name !== undefined && Object.hasOwn(SANDBOX_LIBS, name) ? SANDBOX_LIBS[name] : undefined;
      if (source === undefined) throw new Error(`Unknown sandbox library "${String(name)}"`);
      // QuickJS parses recursively; the minified bundles need more stack than the deliberately small
      // default. Use the clamped maximum (still safe for the host stack) only while the bundle is evaluated.
      ctx.runtime.setMaxStackSize(MAX_STACK_BYTES);
      let result: ReturnType<QuickJSContext['evalCode']>;
      try {
        result = ctx.evalCode(source, `aegis-lib-${name}.js`);
      } finally {
        ctx.runtime.setMaxStackSize(this.maxStackSizeBytes);
      }
      if (result.error) {
        const detail = ctx.dump(result.error) as { message?: string } | undefined;
        result.error.dispose();
        throw new Error(`The "${name}" library could not be loaded: ${detail?.message ?? 'unknown error'}`);
      }
      return result.value;
    });

    define('randomBytes', (nH) => {
      const requested = nH && ctx.typeof(nH) === 'number' ? ctx.getNumber(nH) : NaN;
      if (!Number.isInteger(requested) || requested < 0 || requested > MAX_RANDOM_BYTES_PER_CALL) {
        throw new RangeError(`randomBytes: length must be an integer between 0 and ${MAX_RANDOM_BYTES_PER_CALL}`);
      }
      if (++this.randomCalls > MAX_RANDOM_CALLS) throw new Error(`Random number generation limit exceeded (max ${MAX_RANDOM_CALLS} calls per script)`);
      return ctx.newString(randomBytes(requested).toString('hex'));
    });
    return host;
  }

  private addConsole(level: string, message: string): void {
    if (!LEVELS.has(level as ConsoleEntry['level'])) return;
    if (this.consoleEntries.length >= MAX_CONSOLE_ENTRIES) {
      if (!this.consoleTruncated) {
        this.consoleTruncated = true;
        this.consoleEntries[MAX_CONSOLE_ENTRIES - 1] = {
          level: 'warn',
          message: `Console output truncated: only the first ${MAX_CONSOLE_ENTRIES - 1} entries are kept.`,
          timestamp: Date.now(),
          origin: this.input.origin,
        };
      }
      return;
    }
    const bounded = message.length > PRE_REDACTION_CHARS ? message.slice(0, PRE_REDACTION_CHARS) : message;
    let text = this.redact(bounded);
    if (text.length > MAX_CONSOLE_MESSAGE_CHARS) {
      text = text.slice(0, MAX_CONSOLE_MESSAGE_CHARS - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX;
    }
    this.consoleEntries.push({ level: level as ConsoleEntry['level'], message: text, timestamp: Date.now(), origin: this.input.origin });
  }

  private fireTimer(id: number): void {
    const entry = this.timers.get(id);
    if (!entry || this.finished) return;
    this.timers.delete(id);
    this.pendingOps--;
    // Runs on a bare Node timer: nothing may escape or it would become an uncaught exception of the host.
    try {
      const result = this.ctx.callFunction(entry.callback, this.ctx.undefined);
      if (result.error) this.callbacks.onGuestException(result.error);
      else result.value.dispose();
    } catch (e) {
      this.callbacks.onHostFailure(e);
    } finally {
      try {
        entry.callback.dispose();
      } catch {
        /* interpreter already unusable */
      }
    }
    this.callbacks.wake();
  }

  private sendRequest(json: string | undefined): QuickJSHandle {
    const deferred = this.ctx.newPromise();
    this.deferreds.push(deferred);
    let request: ScriptSendRequest;
    try {
      if (json === undefined) throw new Error('Invalid pm.sendRequest request');
      request = parseSendRequest(json);
    } catch (e) {
      this.settle(deferred, { ok: false, error: e instanceof Error ? e.message : 'Invalid pm.sendRequest request' });
      return deferred.handle;
    }
    if (this.requestCount >= this.maxSendRequests) {
      this.settle(deferred, { ok: false, error: `pm.sendRequest limit exceeded (max ${this.maxSendRequests} per script)` });
      return deferred.handle;
    }
    this.requestCount++;
    this.pendingOps++;
    // Network trace in the console (like Postman's console), with sensitive query parameters masked.
    const label = `${request.method} ${redactUrl(request.url)}`;
    const started = Date.now();
    this.addConsole('info', `-> ${label}`);
    let pending: Promise<ScriptSendResponse>;
    try {
      pending = Promise.resolve(this.input.host.sendRequest(request, this.abort.signal));
    } catch (e) {
      pending = Promise.reject(e);
    }
    void pending.then(
      (res) => {
        this.pendingOps--;
        const response = sanitizeResponse(res);
        this.addConsole('info', `<- ${response.code} ${response.status} ${label} (${response.responseTimeMs || Date.now() - started} ms, ${response.responseSizeBytes} B)`);
        this.settle(deferred, { ok: true, response });
      },
      (err: unknown) => {
        this.pendingOps--;
        const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : 'Request failed';
        const error = this.redact(raw).slice(0, MAX_ERROR_MESSAGE_CHARS);
        this.addConsole('error', `<- ${label} failed after ${Date.now() - started} ms: ${error}`);
        this.settle(deferred, { ok: false, error });
      },
    );
    return deferred.handle;
  }

  private cookieJar(json: string | undefined): QuickJSHandle {
    const deferred = this.ctx.newPromise();
    this.deferreds.push(deferred);
    let op: ScriptCookieJarOp;
    try {
      if (json === undefined) throw new Error('Invalid cookie jar operation');
      op = parseCookieJarOp(json);
    } catch (e) {
      this.settle(deferred, { ok: false, error: e instanceof Error ? e.message : 'Invalid cookie jar operation' });
      return deferred.handle;
    }
    const jar = this.input.host.cookieJar;
    if (typeof jar !== 'function') {
      this.settle(deferred, { ok: false, error: 'The cookie jar is not available in this context' });
      return deferred.handle;
    }
    if (this.cookieOpCount >= MAX_COOKIE_OPS) {
      this.settle(deferred, { ok: false, error: `pm.cookies.jar() limit exceeded (max ${MAX_COOKIE_OPS} operations per script)` });
      return deferred.handle;
    }
    this.cookieOpCount++;
    this.pendingOps++;
    let pending: Promise<ScriptCookieJarResult>;
    try {
      pending = Promise.resolve(jar.call(this.input.host, op, this.abort.signal));
    } catch (e) {
      pending = Promise.reject(e);
    }
    void pending.then(
      (res) => {
        this.pendingOps--;
        this.settle(deferred, { ok: true, result: { cookies: sanitizeCookies(isRecord(res) ? (res.cookies as ScriptCookie[] | undefined) : undefined) } });
      },
      (err: unknown) => {
        this.pendingOps--;
        const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : 'Cookie jar operation failed';
        this.settle(deferred, { ok: false, error: this.redact(raw).slice(0, MAX_ERROR_MESSAGE_CHARS) });
      },
    );
    return deferred.handle;
  }

  private settle(
    deferred: QuickJSDeferredPromise,
    envelope: { ok: true; response: ScriptSendResponse } | { ok: true; result: ScriptCookieJarResult } | { ok: false; error: string },
  ): void {
    if (this.finished || !deferred.alive) return;
    try {
      const value = this.ctx.newString(JSON.stringify(envelope));
      try {
        deferred.resolve(value);
      } finally {
        value.dispose();
      }
    } catch (e) {
      this.callbacks.onHostFailure(e);
    }
    this.callbacks.wake();
  }

  /** Stop everything: cancel timers and in-flight requests, release handles. Safe to call twice. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.finished = true;
    this.abort.abort();
    for (const entry of this.timers.values()) {
      clearTimeout(entry.timer);
      try {
        entry.callback.dispose();
      } catch {
        /* context may already be torn down */
      }
    }
    this.timers.clear();
    for (const d of this.deferreds) {
      try {
        d.dispose();
      } catch {
        /* ignore */
      }
    }
    this.deferreds.length = 0;
  }
}
