import { runScript as defaultRunScript } from '@aegis/scripting';
import {
  AppError,
  buildRequestUrl,
  isAppError,
  toSerializedError,
  headerValue,
  type AuthConfig,
  type ConsoleEntry,
  type Environment,
  type ExecuteRequestInput,
  type ExecutionResult,
  type Folder,
  type HeaderPair,
  type HttpRequestSpec,
  type HttpResponse,
  type RequestDraft,
  type RequestModel,
  type ScopeChanges,
  type ScriptCookie,
  type ScriptEntry,
  type ScriptHost,
  type ScriptPhase,
  type ScriptRequestSnapshot,
  type ScriptResponseSnapshot,
  type ScriptSendRequest,
  type ScriptSendResponse,
  type ScriptVariableState,
  type TestResult,
  type VariableEntry,
  type VariableScopeName,
} from '@aegis/core';
import { resolveEffectiveAuth, createDefaultAuthRegistry, type AuthContext } from '@aegis/authentication';
import { HttpProtocolClient, applyAuthToSpec, buildHttpRequestSpec } from '@aegis/http-client';
import { redactHeaders, redactText, redactUrl } from '@aegis/security';
import { VariableResolver, scopeFromRecord, type ScopeMap, type VariableScopes } from '@aegis/variables';
import type { AppContext } from './context';
import {
  applySnapshot,
  collectDraftStrings,
  draftToSnapshot,
  emptyChanges,
  entriesToRecord,
  hasChanges,
  historySnapshot,
  mergeChanges,
  secretValuesOf,
} from './executor-support';
import { buildNetworkConfig } from './network';
import { buildResponseView } from './response-store';

export interface ExecuteExtra {
  /** Runtime ("local") variables, carried across requests inside a collection run. */
  localVariables?: Record<string, string>;
  iterationData?: Record<string, string>;
  iteration?: { index: number; count: number };
  /** Persist variable changes made by scripts. Default true. */
  persist?: boolean;
  recordHistory?: boolean;
  signal?: AbortSignal;
}

export interface ExecuteOutput {
  result: ExecutionResult;
  localVariables: Record<string, string>;
}

const SCRIPT_BODY_LIMIT = 10 * 1024 * 1024;
const SCOPES: VariableScopeName[] = ['globals', 'environment', 'collectionVariables', 'variables', 'iterationData'];

interface LoadedContext {
  stored?: RequestModel;
  draft: RequestDraft;
  collectionId?: string;
  collectionAuth: AuthConfig;
  collectionScripts: ScriptEntry[];
  folderChain: Folder[]; // innermost first
  environment: Environment | null;
  globals: VariableEntry[];
  envVars: VariableEntry[];
  collectionVars: VariableEntry[];
  folderVars: VariableEntry[][]; // aligned with folderChain
  requestName: string;
}

export class RequestExecutor {
  readonly http: HttpProtocolClient;
  private readonly controllers = new Map<string, AbortController>();
  private readonly authRegistry;
  private readonly runScript;

  constructor(private readonly ctx: AppContext) {
    this.http = ctx.deps.httpClient ?? new HttpProtocolClient();
    this.authRegistry = ctx.deps.authRegistry ?? createDefaultAuthRegistry();
    this.runScript = ctx.deps.runScript ?? defaultRunScript;
  }

  async cancel(executionId: string): Promise<void> {
    this.controllers.get(executionId)?.abort(new AppError('REQUEST_CANCELLED', 'The request was cancelled.'));
    await this.http.cancel(executionId);
  }

  // ------------------------------------------------------------------ loading

  private load(input: ExecuteRequestInput): LoadedContext {
    const repos = this.ctx.storage.repos;
    const stored = input.requestId ? repos.collections.requireRequest(input.requestId, 'resolve') : undefined;
    const collectionId = stored?.collectionId ?? input.collectionId;
    const folderId = stored ? stored.folderId : (input.folderId ?? null);

    let draft: RequestDraft | undefined;
    if (input.draft) {
      // The UI holds secrets only as references; resolve them from the vault.
      draft = { ...input.draft, auth: repos.vault.openAuth(input.draft.auth, 'resolve') };
    } else if (stored) {
      const { id: _i, collectionId: _c, folderId: _f, sortOrder: _s, createdAt: _ca, updatedAt: _u, ...rest } = stored;
      draft = rest;
    }
    if (!draft) throw new AppError('VALIDATION_FAILED', 'Nothing to send: provide a request.');

    const collection = collectionId ? repos.collections.getCollection(collectionId, 'resolve') : null;
    const folderChain = repos.collections.getFolderChain(folderId, 'resolve');

    const envId = input.environmentId !== undefined ? input.environmentId : (repos.environments.getActive(input.workspaceId)?.id ?? null);
    const environment = envId ? repos.environments.get(envId) : null;

    return {
      ...(stored ? { stored } : {}),
      draft,
      ...(collectionId ? { collectionId } : {}),
      collectionAuth: collection?.auth ?? { type: 'none', params: {} },
      collectionScripts: collection?.scripts ?? [],
      folderChain,
      environment,
      globals: repos.vars.global.list(input.workspaceId, 'resolve'),
      envVars: environment ? repos.environments.variables(environment.id, 'resolve') : [],
      collectionVars: collectionId ? repos.vars.collection.list(collectionId, 'resolve') : [],
      folderVars: folderChain.map((f) => repos.vars.folder.list(f.id, 'resolve')),
      requestName: draft.name || stored?.name || 'Request',
    };
  }

  // ------------------------------------------------------------------ execute

  async execute(input: ExecuteRequestInput, extra: ExecuteExtra = {}): Promise<ExecuteOutput> {
    const settings = this.ctx.settings();
    const policy = this.ctx.deps.policy;
    const result: ExecutionResult = {
      executionId: input.executionId,
      ok: false,
      tests: [],
      console: [],
      warnings: [],
      unresolvedVariables: [],
      variableChanges: {},
    };
    const controller = new AbortController();
    this.controllers.set(input.executionId, controller);
    extra.signal?.addEventListener('abort', () => controller.abort(extra.signal?.reason), { once: true });

    const loaded = this.load(input);
    result.environment = loaded.environment ? { id: loaded.environment.id, name: loaded.environment.name, isProduction: loaded.environment.isProduction } : null;

    // Production safety gate
    const gate = policy.productionGate(loaded.environment?.isProduction ?? false);
    if (gate === 'block') {
      this.controllers.delete(input.executionId);
      throw new AppError('POLICY_VIOLATION', 'Organization policy blocks sending requests while a production environment is active.', { environment: loaded.environment?.name });
    }
    if (gate === 'confirm' && !input.confirmProduction) {
      this.controllers.delete(input.executionId);
      throw new AppError('CONFIRMATION_REQUIRED', `Production environment "${loaded.environment?.name}" is active. Confirm to send this request.`, { environment: loaded.environment?.name, production: true });
    }

    // ----- variable state
    const state: ScriptVariableState = {
      globals: entriesToRecord(loaded.globals),
      environment: entriesToRecord(loaded.envVars),
      collectionVariables: {
        ...entriesToRecord(loaded.collectionVars),
        // folder variables behave like narrower collection variables; outermost first so inner folders win
        ...Object.assign({}, ...[...loaded.folderVars].reverse().map(entriesToRecord)),
      },
      variables: { ...(extra.localVariables ?? {}) },
      iterationData: { ...(extra.iterationData ?? {}) },
    };
    const secretValues = new Set<string>([
      ...secretValuesOf(loaded.globals),
      ...secretValuesOf(loaded.envVars),
      ...secretValuesOf(loaded.collectionVars),
      ...loaded.folderVars.flatMap(secretValuesOf),
    ]);
    const changes: Record<VariableScopeName, ScopeChanges> = {
      globals: emptyChanges(),
      environment: emptyChanges(),
      collectionVariables: emptyChanges(),
      variables: emptyChanges(),
      iterationData: emptyChanges(),
    };

    let draft = loaded.draft;
    const startedAt = Date.now();
    let skip = false;
    let nextRequest: string | null | undefined;
    const sendCounter = { n: 0 };

    const host: ScriptHost = {
      sendRequest: (req, signal) => this.scriptSend(req, signal, input, sendCounter, controller),
    };

    const scriptsFor = (type: ScriptPhase): Array<{ origin: string; source: string }> => {
      const pick = (list: ScriptEntry[], origin: string) => list.filter((s) => s.type === type && s.enabled && s.source.trim()).map((s) => ({ origin, source: s.source }));
      return [
        ...pick(loaded.collectionScripts, 'collection'),
        ...[...loaded.folderChain].reverse().flatMap((f) => pick(f.scripts, `folder "${f.name}"`)),
        ...pick(draft.scripts, 'request'),
      ];
    };

    const runPhase = async (phase: ScriptPhase, snapshotRef: { current: ScriptRequestSnapshot }, response?: ScriptResponseSnapshot, cookies: ScriptCookie[] = []): Promise<boolean> => {
      let ok = true;
      for (const s of scriptsFor(phase)) {
        if (controller.signal.aborted) break;
        const before = snapshotRef.current;
        const out = await this.runScript({
          phase,
          origin: `${s.origin} ${phase === 'prerequest' ? 'pre-request' : 'post-response'} script`,
          source: s.source,
          variables: state,
          request: before,
          ...(response ? { response } : {}),
          cookies,
          info: {
            eventName: phase,
            iteration: extra.iteration?.index ?? 0,
            iterationCount: extra.iteration?.count ?? 1,
            requestName: loaded.requestName,
            requestId: loaded.stored?.id ?? input.executionId,
          },
          limits: { timeoutMs: settings.scripting.timeoutMs, memoryLimitBytes: settings.scripting.memoryLimitMb * 1024 * 1024 },
          secretValues: [...secretValues],
          host,
          signal: controller.signal,
        });
        result.console.push(...out.console.map((c: ConsoleEntry) => ({ ...c, origin: s.origin })));
        result.tests.push(...out.tests.map((t: TestResult) => ({ ...t, origin: s.origin })));
        for (const scope of SCOPES) {
          state[scope] = out.variables[scope];
          changes[scope] = mergeChanges(changes[scope], out.changes[scope]);
        }
        if (phase === 'prerequest') snapshotRef.current = out.request;
        if (out.skipRequest) skip = true;
        if (out.nextRequest !== undefined) nextRequest = out.nextRequest;
        if (!out.ok && out.error) {
          ok = false;
          const message = `${s.origin} script failed: ${out.error.message}`;
          result.warnings.push(message);
          if (phase === 'test') result.tests.push({ name: 'Script error', passed: false, durationMs: out.durationMs, error: out.error.message, origin: s.origin });
          if (phase === 'prerequest') {
            result.error = { code: out.error.code, message, details: {} };
            return false;
          }
        }
      }
      return ok;
    };

    let response: HttpResponse | undefined;
    let finalSpec: HttpRequestSpec | undefined;
    try {
      // ----- pre-request scripts
      const snapshotRef = { current: draftToSnapshot(draft) };
      const initialSnapshot = snapshotRef.current;
      const preOk = await runPhase('prerequest', snapshotRef);
      if (!preOk) {
        await this.finish(input, extra, result, loaded, changes, undefined, undefined, startedAt, draft, secretValues);
        return { result, localVariables: state.variables };
      }
      draft = applySnapshot(draft, initialSnapshot, snapshotRef.current);
      if (skip) {
        result.skipped = true;
        result.ok = true;
        await this.persistChanges(input, extra, loaded, changes);
        return { result, localVariables: state.variables };
      }

      // ----- resolve variables
      const resolver = new VariableResolver(this.scopesFrom(state, loaded, secretValues));
      const unresolved = new Set<string>();
      for (const text of collectDraftStrings(draft)) for (const name of resolver.unresolved(text)) unresolved.add(name);
      result.unresolvedVariables = [...unresolved];
      if (unresolved.size) result.warnings.push(`Unresolved variables: ${[...unresolved].map((n) => `{{${n}}}`).join(', ')}`);
      const resolved = resolver.resolveRequest(draft);

      // ----- build spec, then authentication
      const net = await buildNetworkConfig(this.ctx, buildRequestUrl(resolved.url, resolved.queryParams, resolved.pathVariables));
      const specId = input.executionId;
      let spec = buildHttpRequestSpec(resolved, {
        id: specId,
        limits: net.limits,
        tls: net.tls,
        ...(net.proxy ? { proxy: net.proxy } : {}),
        spillDirectory: this.ctx.deps.paths.responsesDir,
      });
      if (!net.tls.rejectUnauthorized) result.warnings.push('TLS certificate validation is disabled by settings.');

      const effective = resolveEffectiveAuth(
        draft.auth,
        loaded.folderChain.map((f) => ({ auth: f.auth, folderId: f.id, name: f.name })),
        loaded.collectionAuth,
      );
      const authParams: AuthConfig = {
        type: effective.auth.type,
        params: Object.fromEntries(Object.entries(effective.auth.params).map(([k, v]) => [k, typeof v === 'string' ? resolver.resolveString(v) : v])),
      };
      for (const v of Object.values(authParams.params)) if (typeof v === 'string' && v.length >= 3 && effective.auth.type !== 'none') secretValues.add(v);
      secretValues.delete(authParams.params.username as string);

      const authContext: AuthContext = {
        method: spec.method,
        url: spec.url,
        headers: spec.headers,
        body: spec.body,
        now: () => this.ctx.now(),
        send: (req) => this.sendTokenRequest(req, specId, controller.signal),
      };
      const authResult = await this.authRegistry.apply(authParams, authContext);
      spec = applyAuthToSpec(spec, authResult);
      result.warnings.push(...authResult.notes.filter((n) => n.startsWith('WARNING')));
      if (authResult.updatedParams) this.persistAuthParams(effective.source, loaded, input, authResult.updatedParams);

      // ----- send
      const policy2 = this.ctx.deps.policy;
      const cookieHook = this.ctx.cookies.hookFor(input.workspaceId);
      finalSpec = spec;
      result.request = {
        method: spec.method,
        url: redactUrl(spec.url),
        headers: redactHeaders(spec.headers),
        bodyPreview: spec.body.kind === 'text' ? redactText(spec.body.text.slice(0, 4096), [...secretValues]) : `[${spec.body.kind}]`,
      };
      response = await this.http.send(spec, {
        cookies: cookieHook,
        beforeRequest: (url) => policy2.assertHostAllowed(url.hostname),
      });
      const entry = this.ctx.responses.put(response);
      result.response = await buildResponseView(response, entry.id);
      result.response.notes = [...response.notes, ...authResult.notes.filter((n) => !n.startsWith('WARNING'))];
      result.ok = true;

      // ----- post-response scripts
      const cookies = await this.ctx.cookies.cookiesForScripts(input.workspaceId, response.url);
      const responseSnapshot = await this.responseSnapshot(response, entry.id, cookies);
      await runPhase('test', { current: snapshotRef.current }, responseSnapshot, cookies);
      if (nextRequest !== undefined) result.nextRequest = nextRequest;
    } catch (error) {
      result.ok = false;
      result.error = result.error ?? toSerializedError(error);
      if (isAppError(error) && error.code === 'CONFIRMATION_REQUIRED') throw error;
      this.ctx.deps.logger.warn('request failed', { code: result.error.code, message: result.error.message });
    } finally {
      this.controllers.delete(input.executionId);
    }

    await this.finish(input, extra, result, loaded, changes, response, finalSpec, startedAt, draft, secretValues);
    return { result, localVariables: state.variables };
  }

  // ------------------------------------------------------------------ helpers

  private scopesFrom(state: ScriptVariableState, loaded: LoadedContext, secrets: Set<string>): VariableScopes {
    const toScope = (record: Record<string, string>): ScopeMap => {
      const map = scopeFromRecord(record);
      for (const [k, v] of map) if (secrets.has(v.value)) map.set(k, { value: v.value, secret: true });
      return map;
    };
    return {
      local: toScope(state.variables),
      iteration: toScope(state.iterationData),
      environment: toScope(state.environment),
      folders: [], // folder variables are folded into `collectionVariables` for scripts and resolution alike
      collection: toScope(state.collectionVariables),
      global: toScope(state.globals),
    };
  }

  private async responseSnapshot(response: HttpResponse, responseId: string, cookies: ScriptCookie[]): Promise<ScriptResponseSnapshot> {
    const head = await this.ctx.responses.head(responseId, SCRIPT_BODY_LIMIT);
    return {
      code: response.status,
      status: response.statusText,
      headers: response.headers,
      bodyText: head.toString('utf8'),
      responseTimeMs: response.timings.totalMs,
      responseSizeBytes: response.size,
      cookies: response.setCookies
        .map((c) => parseCookie(c))
        .filter((c) => !c.httpOnly)
        .concat(cookies.filter((c) => !response.setCookies.some((s) => s.startsWith(`${c.name}=`)))),
    };
  }

  /** `pm.sendRequest`: same TLS/proxy/limits/policy/cookies as a normal request. */
  private async scriptSend(req: ScriptSendRequest, signal: AbortSignal, input: ExecuteRequestInput, counter: { n: number }, parent: AbortController): Promise<ScriptSendResponse> {
    const settings = this.ctx.settings();
    const net = await buildNetworkConfig(this.ctx, req.url);
    const id = `${input.executionId}:script:${++counter.n}`;
    const headers: HeaderPair[] = [...req.headers];
    let body: HttpRequestSpec['body'] = { kind: 'none' };
    if (req.body?.mode === 'raw') body = { kind: 'text', text: req.body.raw ?? '' };
    else if (req.body?.mode === 'urlencoded') body = { kind: 'urlencoded', entries: (req.body.urlencoded ?? []).map((e) => ({ name: e.key, value: e.value })) };
    else if (req.body?.mode === 'formdata') body = { kind: 'multipart', parts: (req.body.formdata ?? []).map((e) => ({ kind: 'text' as const, name: e.key, value: e.value })) };
    if (!headerValue(headers, 'user-agent')) headers.push({ name: 'User-Agent', value: 'AegisApiClient/0.1' });
    if (!headerValue(headers, 'accept')) headers.push({ name: 'Accept', value: '*/*' });
    if (!headerValue(headers, 'accept-encoding')) headers.push({ name: 'Accept-Encoding', value: 'gzip, deflate, br' });
    const spec: HttpRequestSpec = {
      id,
      method: (req.method || 'GET').toUpperCase(),
      url: new URL(req.url).toString(),
      headers,
      body,
      timeoutMs: Math.min(req.timeoutMs ?? net.limits.timeoutMs, net.limits.timeoutMs, settings.scripting.timeoutMs),
      followRedirects: net.limits.followRedirects,
      maxRedirects: net.limits.maxRedirects,
      maxResponseBytes: Math.min(net.limits.maxResponseBytes, SCRIPT_BODY_LIMIT),
      maxRequestBytes: net.limits.maxRequestBytes,
      tls: net.tls,
      ...(net.proxy ? { proxy: net.proxy } : {}),
    };
    const onAbort = () => void this.http.cancel(id);
    signal.addEventListener('abort', onAbort, { once: true });
    parent.signal.addEventListener('abort', onAbort, { once: true });
    try {
      const policy = this.ctx.deps.policy;
      const res = await this.http.send(spec, { cookies: this.ctx.cookies.hookFor(input.workspaceId), beforeRequest: (u) => policy.assertHostAllowed(u.hostname) });
      return {
        code: res.status,
        status: res.statusText,
        headers: res.headers,
        bodyText: Buffer.from(res.body.subarray(0, SCRIPT_BODY_LIMIT)).toString('utf8'),
        responseTimeMs: res.timings.totalMs,
        responseSizeBytes: res.size,
        cookies: res.setCookies.map(parseCookie).filter((c) => !c.httpOnly),
      };
    } finally {
      signal.removeEventListener('abort', onAbort);
      parent.signal.removeEventListener('abort', onAbort);
    }
  }

  /** HTTP for OAuth token endpoints: identical policy/TLS/proxy as user traffic. */
  async sendTokenRequest(req: { method: string; url: string; headers: HeaderPair[]; body?: string; timeoutMs?: number }, id: string, signal: AbortSignal) {
    const tokenNet = await buildNetworkConfig(this.ctx, req.url);
    const spec: HttpRequestSpec = {
      id: `${id}:auth`,
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: req.body !== undefined ? { kind: 'text', text: req.body } : { kind: 'none' },
      timeoutMs: req.timeoutMs ?? 30_000,
      followRedirects: true,
      maxRedirects: 5,
      maxResponseBytes: 5 * 1024 * 1024,
      maxRequestBytes: 1024 * 1024,
      tls: tokenNet.tls,
      ...(tokenNet.proxy ? { proxy: tokenNet.proxy } : {}),
    };
    const onAbort = () => void this.http.cancel(spec.id);
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const policy = this.ctx.deps.policy;
      const res = await this.http.send(spec, { beforeRequest: (u) => policy.assertHostAllowed(u.hostname) });
      return { status: res.status, bodyText: Buffer.from(res.body).toString('utf8') };
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  /** Persist refreshed OAuth tokens into the auth config that provided the credentials. */
  private persistAuthParams(source: ReturnType<typeof resolveEffectiveAuth>['source'], loaded: LoadedContext, input: ExecuteRequestInput, updated: Record<string, string | number | boolean>): void {
    const repos = this.ctx.storage.repos;
    try {
      const merge = (auth: AuthConfig): AuthConfig => ({ type: auth.type, params: { ...auth.params, ...updated } });
      if (source.level === 'request' && loaded.stored) {
        const { id, collectionId: _c, folderId: _f, sortOrder: _s, createdAt: _ca, updatedAt: _u, ...draft } = loaded.stored;
        repos.collections.updateRequest(id, { ...draft, auth: merge(loaded.stored.auth) });
      } else if (source.level === 'folder') {
        const folder = loaded.folderChain.find((f) => f.id === source.folderId);
        if (folder) repos.collections.updateFolder(folder.id, { auth: merge(folder.auth) });
      } else if (source.level === 'collection' && loaded.collectionId) {
        repos.collections.updateCollection(loaded.collectionId, { auth: merge(loaded.collectionAuth) });
      }
    } catch (error) {
      this.ctx.deps.logger.warn('could not persist refreshed token', { message: (error as Error).message, workspaceId: input.workspaceId });
    }
  }

  private async persistChanges(input: ExecuteRequestInput, extra: ExecuteExtra, loaded: LoadedContext, changes: Record<VariableScopeName, ScopeChanges>): Promise<void> {
    if (extra.persist === false) return;
    this.ctx.storage.transaction((r) => {
      if (hasChanges(changes.environment)) {
        if (loaded.environment) r.vars.environment.setCurrentValues(loaded.environment.id, changes.environment);
      }
      if (hasChanges(changes.collectionVariables) && loaded.collectionId) r.vars.collection.setCurrentValues(loaded.collectionId, changes.collectionVariables);
      if (hasChanges(changes.globals)) r.vars.global.setCurrentValues(input.workspaceId, changes.globals);
    });
  }

  private async finish(
    input: ExecuteRequestInput,
    extra: ExecuteExtra,
    result: ExecutionResult,
    loaded: LoadedContext,
    changes: Record<VariableScopeName, ScopeChanges>,
    response: HttpResponse | undefined,
    spec: HttpRequestSpec | undefined,
    startedAt: number,
    draft: RequestDraft,
    secretValues: Set<string>,
  ): Promise<void> {
    const settings = this.ctx.settings();
    const { audit } = this.ctx.deps;
    const repos = this.ctx.storage.repos;

    // variable changes summary (never values)
    for (const scope of SCOPES) {
      const c = changes[scope];
      if (hasChanges(c)) result.variableChanges[scope] = { set: Object.keys(c.set), unset: c.unset };
    }
    if (loaded.environment === null && (hasChanges(changes.environment))) {
      result.warnings.push('A script changed environment variables but no environment is active; the changes were discarded.');
      changes.environment = emptyChanges();
    }
    try {
      await this.persistChanges(input, extra, loaded, changes);
    } catch (error) {
      result.warnings.push(`Could not save variable changes: ${(error as Error).message}`);
    }

    // history
    if (settings.history.enabled && extra.recordHistory !== false) {
      try {
        const url = spec ? redactUrl(spec.url, settings.security.redactionPatterns) : redactUrl(draft.url, settings.security.redactionPatterns);
        const snapshot = historySnapshot(draft, settings.history.storeRequestBodies);
        let responseMetadata: Record<string, unknown> | undefined;
        if (response) {
          responseMetadata = {
            contentType: headerValue(response.headers, 'content-type') ?? '',
            headers: redactHeaders(response.headers, settings.security.redactionPatterns),
            timings: response.timings,
            httpVersion: response.httpVersion,
            redirects: response.redirects.length,
          };
          if (settings.history.storeResponseBodies && !response.bodyFilePath) {
            responseMetadata.body = redactText(Buffer.from(response.body.subarray(0, 256 * 1024)).toString('utf8'), [...secretValues], settings.security.redactionPatterns);
          }
        }
        const historyId = repos.history.add({
          workspaceId: input.workspaceId,
          requestId: loaded.stored?.id ?? input.requestId ?? null,
          environmentId: loaded.environment?.id ?? null,
          environmentName: loaded.environment?.name ?? null,
          requestName: loaded.requestName,
          method: (spec?.method ?? draft.method).toUpperCase(),
          url,
          statusCode: response?.status ?? null,
          statusText: response?.statusText ?? null,
          errorCode: result.error?.code ?? null,
          durationMs: response?.timings.totalMs ?? Date.now() - startedAt,
          requestSize: response?.requestSize ?? null,
          responseSize: response?.size ?? null,
          requestSnapshot: snapshot,
          ...(responseMetadata ? { responseMetadata } : {}),
        });
        result.historyId = historyId;
        repos.history.addTestResults(result.tests.map((t) => ({ historyId, requestId: loaded.stored?.id ?? null, name: t.name, passed: t.passed, durationMs: t.durationMs, error: t.error ?? null })));
      } catch (error) {
        this.ctx.deps.logger.warn('could not record history', { message: (error as Error).message });
      }
    }

    // audit
    audit.log('EXECUTE_REQUEST', {
      method: (spec?.method ?? draft.method).toUpperCase(),
      url: spec ? redactUrl(spec.url) : redactUrl(draft.url),
      status: response?.status ?? null,
      error: result.error?.code ?? null,
      environment: loaded.environment?.name ?? null,
    });
    if (result.console.length || result.tests.length || Object.keys(result.variableChanges).length) {
      audit.log('EXECUTE_SCRIPT', { request: loaded.requestName, tests: result.tests.length, variableChanges: Object.keys(result.variableChanges) });
    }
  }
}

function parseCookie(raw: string): ScriptCookie {
  const [pair, ...attrs] = raw.split(';').map((p) => p.trim());
  const eq = pair!.indexOf('=');
  const c: ScriptCookie = { name: eq === -1 ? pair! : pair!.slice(0, eq), value: eq === -1 ? '' : pair!.slice(eq + 1), domain: '', path: '/', secure: false, httpOnly: false };
  for (const a of attrs) {
    const [k, ...v] = a.split('=');
    const key = k!.toLowerCase();
    const val = v.join('=');
    if (key === 'domain') c.domain = val;
    else if (key === 'path') c.path = val;
    else if (key === 'expires') c.expires = val;
    else if (key === 'secure') c.secure = true;
    else if (key === 'httponly') c.httpOnly = true;
    else if (key === 'samesite') c.sameSite = val;
  }
  return c;
}
