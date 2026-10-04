import type { ScriptRunInput, ScriptRunResult } from '@aegis/core';
import { redactText } from '@aegis/security';
import {
  newQuickJSWASMModule,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSRuntime,
  type QuickJSWASMModule,
} from 'quickjs-emscripten';
import { HostBridge, type GuestErrorInfo } from './bridge';
import { CHAI_BUNDLE } from './generated/chai-bundle';
import { MAX_SOURCE_CHARS, resolveLimits, type ResolvedLimits } from './limits';
import { BOOTSTRAP_SOURCE, PRELUDE_SOURCE, wrapUserScript } from './prelude';
import { computeChanges, emptyChanges, parseGuestSnapshot, type GuestSnapshot } from './snapshot';

type RunError = NonNullable<ScriptRunResult['error']>;
type Stage = 'setup' | 'run' | 'collect';
type InterruptReason = 'timeout' | 'cancelled';

/** Grace period for reading results back after the script was interrupted. */
const COLLECT_GRACE_MS = 1000;
const MAX_STACK_LINES = 10;
const MAX_NESTING = 256;
const SANDBOX_CRASH_MESSAGE =
  'The script crashed the sandbox interpreter (for example by deeply nested code or data). Simplify the script.';

let modulePromise: Promise<QuickJSWASMModule> | undefined;

/** The WASM module is instantiated once and shared by all runs (each run gets its own runtime). */
function loadModule(): Promise<QuickJSWASMModule> {
  if (!modulePromise) {
    const promise = newQuickJSWASMModule();
    modulePromise = promise;
    promise.catch(() => {
      if (modulePromise === promise) modulePromise = undefined;
    });
  }
  return modulePromise;
}

/**
 * Drop the shared module. Used after the interpreter crashed the host stack:
 * the WASM shadow stack is then inconsistent and must not be reused.
 */
export function discardSandboxModule(): void {
  modulePromise = undefined;
}

function maxBracketDepth(source: string): number {
  let depth = 0;
  let max = 0;
  for (let i = 0; i < source.length; i++) {
    const c = source.charCodeAt(i);
    if (c === 40 || c === 91 || c === 123) {
      if (++depth > max) max = depth;
    } else if ((c === 41 || c === 93 || c === 125) && depth > 0) {
      depth--;
    }
  }
  return max;
}

function failureResult(input: ScriptRunInput, started: number, error: RunError): ScriptRunResult {
  return {
    ok: false,
    error,
    durationMs: Math.round(performance.now() - started),
    console: [],
    tests: [],
    variables: structuredClone(input.variables),
    changes: emptyChanges(),
    request: structuredClone(input.request),
    skipRequest: false,
  };
}

export async function executeScript(input: ScriptRunInput): Promise<ScriptRunResult> {
  const started = performance.now();
  const secrets = input.secretValues ?? [];
  const quick = (code: RunError['code'], name: string, message: string): ScriptRunResult =>
    failureResult(input, started, { code, name, message: redactText(message, secrets, []) });

  if (input.signal?.aborted) return quick('SCRIPT_ERROR', 'ScriptCancelledError', 'Script cancelled');
  if (input.source.length > MAX_SOURCE_CHARS) {
    return quick('SCRIPT_ERROR', 'ScriptTooLargeError', `Script is too large (limit ${MAX_SOURCE_CHARS} characters)`);
  }
  if (maxBracketDepth(input.source) > MAX_NESTING) {
    return quick('SCRIPT_ERROR', 'SyntaxError', `Script is nested too deeply (limit ${MAX_NESTING} levels)`);
  }

  let wasm: QuickJSWASMModule;
  try {
    wasm = await loadModule();
  } catch {
    return quick('SCRIPT_ERROR', 'SandboxError', 'The script sandbox could not be initialised');
  }

  const run = new SandboxRun(wasm, input, resolveLimits(input.limits), started);
  try {
    return await run.execute();
  } finally {
    run.dispose();
  }
}

class SandboxRun {
  private runtime: QuickJSRuntime | undefined;
  private ctx: QuickJSContext | undefined;
  private bridge: HostBridge | undefined;
  private readonly abort = new AbortController();
  private stage: Stage = 'setup';
  private deadline = Number.POSITIVE_INFINITY;
  private collectDeadline = 0;
  private interruptReason: InterruptReason | undefined;
  private fatal: GuestErrorInfo | undefined;
  private crashed = false;
  private memoryCap = 0;
  private memoryRaised = false;
  private snapshotFn: QuickJSHandle | undefined;
  private describeFn: QuickJSHandle | undefined;
  private mainPromise: QuickJSHandle | undefined;
  private mainState: 'pending' | 'fulfilled' | 'rejected' = 'pending';
  private deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  private wakeResolver: (() => void) | undefined;
  private wakePending = false;
  private disposed = false;
  private readonly secrets: string[];
  private readonly onAbort = (): void => {
    this.markInterrupt('cancelled');
    this.wake();
  };

  constructor(
    private readonly wasm: QuickJSWASMModule,
    private readonly input: ScriptRunInput,
    private readonly limits: ResolvedLimits,
    private readonly started: number,
  ) {
    this.secrets = (input.secretValues ?? []).filter((s) => s.length > 0);
  }

  async execute(): Promise<ScriptRunResult> {
    try {
      this.setup();
      this.startClock();
      this.startScript();
      await this.loop();
      return this.finish();
    } catch (e) {
      // A failing bootstrap is a bug in the sandbox itself, not in the script: surface it loudly.
      if (this.stage === 'setup') throw e;
      // Anything else escaping a VM call is a host-level failure (typically a native stack overflow).
      this.crashed = true;
      discardSandboxModule();
      return this.finish();
    }
  }

  private requireCtx(): QuickJSContext {
    if (!this.ctx) throw new Error('Sandbox context is not available');
    return this.ctx;
  }

  private requireRuntime(): QuickJSRuntime {
    if (!this.runtime) throw new Error('Sandbox runtime is not available');
    return this.runtime;
  }

  // ------------------------------------------------------------------ setup
  private setup(): void {
    const runtime = this.wasm.newRuntime();
    this.runtime = runtime;
    runtime.setMaxStackSize(this.limits.maxStackSizeBytes);
    runtime.setInterruptHandler(() => this.shouldInterrupt());
    const ctx = runtime.newContext();
    this.ctx = ctx;

    this.bridge = new HostBridge(ctx, this.input, this.abort, this.limits.maxSendRequests, {
      onGuestException: (error) => this.onGuestException(error),
      onUncaught: (info) => {
        this.fatal ??= info;
        this.wake();
      },
      onHostFailure: () => {
        this.crashed = true;
        discardSandboxModule();
        this.wake();
      },
      wake: () => this.wake(),
      remainingMs: () => Math.max(0, this.deadline - Date.now()),
    });

    this.evalChecked(BOOTSTRAP_SOURCE, 'aegis-bootstrap.js').dispose();
    this.evalChecked(CHAI_BUNDLE, 'aegis-chai.js').dispose();
    const preludeFn = this.evalChecked(PRELUDE_SOURCE, 'aegis-prelude.js');
    const hostObj = this.bridge.install();
    const guestInput = ctx.newString(
      JSON.stringify({
        phase: this.input.phase,
        origin: this.input.origin,
        variables: this.input.variables,
        request: this.input.request,
        response: this.input.phase === 'test' ? this.input.response : undefined,
        cookies: this.input.cookies,
        info: this.input.info,
      }),
    );
    try {
      const called = ctx.callFunction(preludeFn, ctx.undefined, hostObj, guestInput);
      if (called.error) {
        const detail = JSON.stringify(ctx.dump(called.error));
        called.error.dispose();
        throw new Error(`Sandbox prelude failed: ${detail}`);
      }
      const api = called.value;
      try {
        this.snapshotFn = ctx.getProp(api, 'snapshot');
        this.describeFn = ctx.getProp(api, 'describe');
      } finally {
        api.dispose();
      }
    } finally {
      guestInput.dispose();
      hostObj.dispose();
      preludeFn.dispose();
    }

    // The memory budget applies to what the script allocates, not to the prelude/chai baseline.
    const usageHandle = runtime.computeMemoryUsage();
    const usage = ctx.dump(usageHandle) as { memory_used_size?: number };
    usageHandle.dispose();
    this.memoryCap = (usage.memory_used_size ?? 0) + this.limits.memoryLimitBytes;
    runtime.setMemoryLimit(this.memoryCap);
  }

  private evalChecked(code: string, filename: string): QuickJSHandle {
    const ctx = this.requireCtx();
    const result = ctx.evalCode(code, filename);
    if (result.error) {
      const detail = JSON.stringify(ctx.dump(result.error));
      result.error.dispose();
      throw new Error(`Sandbox bootstrap failed (${filename}): ${detail}`);
    }
    return result.value;
  }

  private startClock(): void {
    this.deadline = Date.now() + this.limits.timeoutMs;
    this.stage = 'run';
    this.deadlineTimer = setTimeout(() => {
      this.markInterrupt('timeout');
      this.wake();
    }, this.limits.timeoutMs);
    this.input.signal?.addEventListener('abort', this.onAbort, { once: true });
    if (this.input.signal?.aborted) this.markInterrupt('cancelled');
  }

  private startScript(): void {
    const ctx = this.requireCtx();
    const result = ctx.evalCode(wrapUserScript(this.input.source), 'script.js');
    if (result.error) {
      this.mainState = 'rejected';
      this.onGuestException(result.error);
      return;
    }
    this.mainPromise = result.value;
  }

  // ------------------------------------------------------------------ run loop
  private shouldInterrupt(): boolean {
    if (this.stage === 'collect') return Date.now() > this.collectDeadline;
    if (this.stage === 'setup' || this.disposed) return false;
    if (this.interruptReason) return true;
    if (this.input.signal?.aborted) {
      this.markInterrupt('cancelled');
      return true;
    }
    if (Date.now() >= this.deadline) {
      this.markInterrupt('timeout');
      return true;
    }
    return false;
  }

  private markInterrupt(reason: InterruptReason): void {
    if (this.interruptReason) return;
    this.interruptReason = reason;
    this.abort.abort();
  }

  private wake(): void {
    const resolver = this.wakeResolver;
    if (resolver) {
      this.wakeResolver = undefined;
      resolver();
    } else {
      this.wakePending = true;
    }
  }

  private waitForWake(): Promise<void> {
    if (this.wakePending) {
      this.wakePending = false;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.wakeResolver = resolve;
    });
  }

  private stopped(): boolean {
    return this.interruptReason !== undefined || this.fatal !== undefined || this.crashed;
  }

  private async loop(): Promise<void> {
    const runtime = this.requireRuntime();
    const bridge = this.bridge;
    if (!bridge) return;
    for (;;) {
      this.drainJobs();
      if (this.stopped()) return;
      this.checkMain();
      if (this.stopped()) return;
      if (bridge.pendingOps === 0 && !runtime.hasPendingJob()) {
        if (this.mainState === 'pending') {
          this.fatal = {
            name: 'Error',
            message: 'The script finished while still waiting on a promise that can never settle',
            stack: '',
          };
        }
        return;
      }
      await this.waitForWake();
    }
  }

  /** Run microtasks in bounded chunks so a promise ping-pong cannot starve the host. */
  private drainJobs(): void {
    const runtime = this.requireRuntime();
    while (!this.stopped() && runtime.hasPendingJob()) {
      const result = runtime.executePendingJobs(1000);
      if (result.error) {
        this.onGuestException(result.error);
        return;
      }
      if (this.input.signal?.aborted) this.markInterrupt('cancelled');
      else if (Date.now() >= this.deadline) this.markInterrupt('timeout');
      if (result.value === 0) return;
    }
  }

  private checkMain(): void {
    if (this.mainState !== 'pending' || !this.mainPromise) return;
    const state = this.requireCtx().getPromiseState(this.mainPromise);
    if (state.type === 'fulfilled') {
      state.value.dispose();
      this.mainState = 'fulfilled';
    } else if (state.type === 'rejected') {
      this.mainState = 'rejected';
      this.onGuestException(state.error);
    }
  }

  // ------------------------------------------------------------------ errors
  private raiseMemoryLimit(): void {
    if (this.memoryRaised) return;
    this.memoryRaised = true;
    // Describing an out-of-memory error needs headroom; the script is no longer running at this point.
    this.requireRuntime().setMemoryLimit(this.memoryCap * 2 + 16 * 1024 * 1024);
  }

  private onGuestException(error: QuickJSHandle): void {
    try {
      if (this.interruptReason === undefined && this.fatal === undefined) {
        this.raiseMemoryLimit();
        this.fatal = this.describe(error);
      }
    } finally {
      error.dispose();
      this.wake();
    }
  }

  private describe(error: QuickJSHandle): GuestErrorInfo {
    const ctx = this.requireCtx();
    const generic: GuestErrorInfo = { name: 'Error', message: 'The script threw an error', stack: '' };
    if (!this.describeFn) return generic;
    const result = ctx.callFunction(this.describeFn, ctx.undefined, error);
    if (result.error) {
      result.error.dispose();
      return generic;
    }
    const json = ctx.getString(result.value);
    result.value.dispose();
    try {
      const parsed: unknown = JSON.parse(json);
      if (typeof parsed === 'object' && parsed !== null) {
        const p = parsed as Record<string, unknown>;
        return {
          name: typeof p.name === 'string' ? p.name : 'Error',
          message: typeof p.message === 'string' ? p.message : '',
          stack: typeof p.stack === 'string' ? p.stack : '',
        };
      }
    } catch {
      /* fall through */
    }
    return generic;
  }

  private toRunError(info: GuestErrorInfo): RunError {
    const redact = (s: string): string => redactText(s, this.secrets, []);
    const lines = info.stack
      .split('\n')
      .filter((l) => l.trim() !== '' && !l.includes('aegis-'))
      .slice(0, MAX_STACK_LINES);
    let message = info.message;
    if (info.name === 'SyntaxError') {
      const location = /script\.js:(\d+):(\d+)/.exec(info.stack);
      if (location) message += ` (line ${location[1]}, column ${location[2]})`;
    }
    const isMemory = info.name === 'InternalError' && /out of memory/i.test(info.message);
    const error: RunError = {
      code: isMemory ? 'SCRIPT_MEMORY' : 'SCRIPT_ERROR',
      name: redact(info.name).slice(0, 128),
      message: redact(message).slice(0, 4096),
    };
    if (lines.length > 0) error.stack = redact(lines.join('\n')).slice(0, 8192);
    return error;
  }

  // ------------------------------------------------------------------ results
  private collect(): GuestSnapshot | undefined {
    if (this.crashed || !this.snapshotFn) return undefined;
    const ctx = this.requireCtx();
    this.stage = 'collect';
    this.collectDeadline = Date.now() + COLLECT_GRACE_MS;
    this.raiseMemoryLimit();
    try {
      const result = ctx.callFunction(this.snapshotFn, ctx.undefined);
      if (result.error) {
        result.error.dispose();
        return undefined;
      }
      const json = ctx.getString(result.value);
      result.value.dispose();
      return parseGuestSnapshot(json, this.input, (s) => redactText(s, this.secrets, []));
    } catch {
      return undefined;
    }
  }

  private finish(): ScriptRunResult {
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    this.input.signal?.removeEventListener('abort', this.onAbort);
    this.abort.abort();

    let snapshot: GuestSnapshot | undefined;
    try {
      snapshot = this.collect();
    } catch {
      snapshot = undefined;
    }

    let error: RunError | undefined;
    if (this.interruptReason === 'timeout') {
      error = {
        code: 'SCRIPT_TIMEOUT',
        name: 'ScriptTimeoutError',
        message: `Script execution timed out after ${this.limits.timeoutMs} ms`,
      };
    } else if (this.interruptReason === 'cancelled') {
      error = { code: 'SCRIPT_ERROR', name: 'ScriptCancelledError', message: 'Script cancelled' };
    } else if (this.crashed) {
      error = { code: 'SCRIPT_ERROR', name: 'SandboxError', message: SANDBOX_CRASH_MESSAGE };
    } else if (this.fatal) {
      error = this.toRunError(this.fatal);
    } else if (!snapshot) {
      error = {
        code: 'SCRIPT_ERROR',
        name: 'SandboxError',
        message: 'The script results could not be read back (the script probably modified built-in objects).',
      };
    }

    const input = this.input;
    const result: ScriptRunResult = {
      ok: error === undefined,
      durationMs: Math.round(performance.now() - this.started),
      console: this.bridge?.consoleEntries ?? [],
      tests: snapshot?.tests ?? [],
      variables: snapshot?.variables ?? structuredClone(input.variables),
      changes: snapshot ? computeChanges(input.variables, snapshot.variables, snapshot.cleared) : emptyChanges(),
      request: snapshot?.request ?? structuredClone(input.request),
      skipRequest: snapshot?.skipRequest ?? false,
    };
    if (error) result.error = error;
    if (snapshot?.nextRequest.called) result.nextRequest = snapshot.nextRequest.value;
    return result;
  }

  // ------------------------------------------------------------------ cleanup
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    this.input.signal?.removeEventListener('abort', this.onAbort);
    this.abort.abort();
    if (this.crashed || this.interruptReason !== undefined) {
      // After a host-level crash or an interrupt the interpreter's reference counts are not trustworthy
      // (QuickJS can leak objects when an interrupt lands inside a promise job, which makes
      // JS_FreeRuntime abort). Do not tear it down: drop it together with the whole WASM instance and
      // let the next run start from a fresh module (cheap: a few milliseconds).
      this.bridge?.dispose();
      discardSandboxModule();
      return;
    }
    try {
      this.bridge?.dispose();
      for (const handle of [this.mainPromise, this.snapshotFn, this.describeFn]) {
        if (handle?.alive) handle.dispose();
      }
      this.ctx?.dispose();
      this.runtime?.dispose();
    } catch {
      // A leaked handle trips a QuickJS assertion on dispose; never reuse such a module.
      discardSandboxModule();
    }
  }
}
