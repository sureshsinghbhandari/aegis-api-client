import { readFile, stat, writeFile } from 'node:fs/promises';
import {
  AppError,
  type AegisApi,
  type OAuth2DeviceInput,
  type SearchResult,
  type VariableEntry,
  type VariableOwner,
} from '@aegis/core';
import {
  buildAuthorizationUrl,
  decodeJwt,
  exchangeAuthorizationCode,
  fetchClientCredentialsToken,
  fetchPasswordToken,
  generatePkce,
  generateState,
  pollDeviceTokenOnce,
  resolveEffectiveAuth,
  startDeviceFlow,
  tokenToParams,
  type AuthContext,
} from '@aegis/authentication';
import { exportPostmanCollection, exportPostmanEnvironment } from '@aegis/postman';
import { assertSafeFilePath, isSecretRef, secretRefKey } from '@aegis/security';
import { schema } from '@aegis/storage';
import { VariableResolver, scopeFromEntries } from '@aegis/variables';
import type { AppContext } from '../context';
import type { RequestExecutor } from '../executor';
import { PROXY_PASSWORD_KEY } from '../network';
import { runFindReplace } from './find-replace';
import { likeEscape, likeSql } from './util';

type Handlers<N extends keyof AegisApi> = AegisApi[N];

/** Upper bound for a PKCS#12 client certificate bundle (certificate chain + key). */
const MAX_PFX_BYTES = 2 * 1024 * 1024;

export function createCoreServices(ctx: AppContext, executor: RequestExecutor) {
  const repos = () => ctx.storage.repos;
  const { audit, policy, platform } = ctx.deps;

  const variableStore = (owner: VariableOwner) => {
    const r = repos();
    switch (owner.scope) {
      case 'environment':
        return { list: (mode: 'refs' | 'resolve') => r.environments.variables(owner.ownerId, mode), set: (e: VariableEntry[]) => r.environments.setVariables(owner.ownerId, e) };
      case 'global':
        return { list: (mode: 'refs' | 'resolve') => r.vars.global.list(owner.ownerId, mode), set: (e: VariableEntry[]) => r.vars.global.replaceAll(owner.ownerId, e) };
      case 'collection':
        return { list: (mode: 'refs' | 'resolve') => r.vars.collection.list(owner.ownerId, mode), set: (e: VariableEntry[]) => r.vars.collection.replaceAll(owner.ownerId, e) };
      case 'folder':
        return { list: (mode: 'refs' | 'resolve') => r.vars.folder.list(owner.ownerId, mode), set: (e: VariableEntry[]) => r.vars.folder.replaceAll(owner.ownerId, e) };
    }
  };

  const workspaces: Handlers<'workspaces'> = {
    list: async () => repos().workspaces.list(),
    create: async ({ name, description }) => repos().workspaces.create(name.trim(), description ?? ''),
    update: async ({ id, name, description }) => repos().workspaces.update(id, { ...(name !== undefined ? { name: name.trim() } : {}), ...(description !== undefined ? { description } : {}) }),
    delete: async ({ id }) => {
      if (repos().workspaces.list().length <= 1) throw new AppError('VALIDATION_FAILED', 'You cannot delete the last workspace.');
      repos().workspaces.delete(id);
      ctx.cookies.invalidate(id);
    },
    search: async ({ query }) => repos().workspaces.search(query),
    export: async ({ id, includeSecrets }) => {
      const workspace = repos().workspaces.require(id);
      if (includeSecrets) {
        policy.assertCanExportSecrets();
        audit.log('EXPORT_SECRETS', { target: 'workspace', workspace: workspace.name });
      }
      const target = await platform.saveFile({ title: 'Export workspace', defaultName: `${workspace.name}.aegis-workspace.json`, filters: [{ name: 'JSON', extensions: ['json'] }] });
      if (!target) return null;
      const mode = includeSecrets ? 'resolve' : 'blank';
      const collections = repos().collections.listCollections(id).map((c) => exportPostmanCollection(repos().collections.loadBundle(c.id, mode), { includeSecrets }));
      const environments = repos().environments.list(id).map((e) =>
        exportPostmanEnvironment({ name: e.name, description: e.description, variables: repos().environments.variables(e.id, mode) }, { includeSecrets }),
      );
      const globals = exportPostmanEnvironment({ name: 'Globals', variables: repos().vars.global.list(id, mode) }, { includeSecrets });
      await writeFile(target, JSON.stringify({ format: 'aegis-workspace', version: 1, workspace: { name: workspace.name, description: workspace.description }, collections, environments, globals }, null, 2));
      audit.log('EXPORT_COLLECTION', { target: 'workspace', workspace: workspace.name, collections: collections.length, includeSecrets });
      return target;
    },
  };

  const collections: Handlers<'collections'> = {
    list: async ({ workspaceId }) => repos().collections.listCollections(workspaceId),
    get: async ({ id }) => repos().collections.requireCollection(id),
    create: async ({ workspaceId, name, description }) => {
      const c = repos().collections.createCollection(workspaceId, { name: name.trim(), description: description ?? '' });
      audit.log('CREATE_COLLECTION', { name: c.name });
      return c;
    },
    update: async ({ id, ...patch }) => repos().collections.updateCollection(id, patch),
    delete: async ({ id }) => {
      const c = repos().collections.requireCollection(id);
      repos().collections.deleteCollection(id);
      audit.log('DELETE_COLLECTION', { name: c.name });
    },
    duplicate: async ({ id }) => repos().collections.requireCollection(ctx.storage.transaction((r) => r.collections.duplicateCollection(id))),
    reorder: async ({ workspaceId, orderedIds }) => repos().collections.reorderCollections(workspaceId, orderedIds),
    tree: async ({ collectionId }) => repos().collections.getTreeRows(collectionId),
    search: async ({ workspaceId, query }) => {
      const out: SearchResult[] = repos().workspaces.search(query).map((w) => ({ kind: 'workspace', id: w.id, name: w.name, subtitle: 'Workspace' }));
      out.push(...repos().collections.search(workspaceId, query));
      const pattern = likeEscape(query);
      if (query.trim()) {
        const db = ctx.storage.opened.db;
        const { environmentVariables, globalVariables, collectionVariables } = schema;
        const envHits = db.select({ key: environmentVariables.key, owner: environmentVariables.environmentId }).from(environmentVariables).where(likeSql(environmentVariables.key, pattern)).limit(20).all();
        const colHits = db.select({ key: collectionVariables.key, owner: collectionVariables.collectionId }).from(collectionVariables).where(likeSql(collectionVariables.key, pattern)).limit(20).all();
        const globalHits = db.select({ key: globalVariables.key, owner: globalVariables.workspaceId }).from(globalVariables).where(likeSql(globalVariables.key, pattern)).limit(20).all();
        for (const h of envHits) out.push({ kind: 'variable', id: h.owner, name: h.key, subtitle: 'Environment variable' });
        for (const h of colHits) out.push({ kind: 'variable', id: h.owner, name: h.key, subtitle: 'Collection variable', collectionId: h.owner });
        for (const h of globalHits) out.push({ kind: 'variable', id: h.owner, name: h.key, subtitle: 'Global variable' });
      }
      return out;
    },
    // Preview or apply in one transaction; audited with counts only (see services/find-replace.ts).
    findReplace: async (input) => runFindReplace(ctx, input),
  };

  const folders: Handlers<'folders'> = {
    get: async ({ id }) => repos().collections.requireFolder(id),
    create: async ({ collectionId, parentFolderId, name }) => repos().collections.createFolder(collectionId, parentFolderId, { name: name.trim() }),
    update: async ({ id, ...patch }) => repos().collections.updateFolder(id, patch),
    delete: async ({ id }) => repos().collections.deleteFolder(id),
    // Deep copy (sub-folders, requests, scripts, variables, examples); auth secrets are re-vaulted under the new owner ids.
    duplicate: async ({ id }) => repos().collections.requireFolder(ctx.storage.transaction((r) => r.collections.duplicateFolder(id))),
  };

  const requests: Handlers<'requests'> = {
    get: async ({ id }) => repos().collections.requireRequest(id),
    create: async ({ collectionId, folderId, draft }) => repos().collections.createRequest(collectionId, folderId, draft),
    save: async ({ id, draft }) => repos().collections.updateRequest(id, draft),
    delete: async ({ id }) => repos().collections.deleteRequest(id),
    duplicate: async ({ id }) => repos().collections.duplicateRequest(id),
    /**
     * Reorder / re-parent inside a collection, or (with `collectionId`) move into another collection.
     * Cross-collection moves re-vault nothing: auth and variables are keyed by request/folder id. What
     * changes is the inherited context (collection auth, scripts and variables of the new collection).
     */
    move: async ({ kind, id, parentFolderId, index, collectionId }) =>
      ctx.storage.transaction((r) => (collectionId ? r.collections.moveToCollection(kind, id, collectionId, parentFolderId, index) : r.collections.move(kind, id, parentFolderId, index))),
    effectiveAuth: async ({ id }) => {
      const req = repos().collections.requireRequest(id);
      const chain = repos().collections.getFolderChain(req.folderId, 'refs');
      const collection = repos().collections.requireCollection(req.collectionId);
      const eff = resolveEffectiveAuth(
        req.auth,
        chain.map((f) => ({ auth: f.auth, folderId: f.id, name: f.name })),
        collection.auth,
      );
      const source = eff.source.level === 'folder' ? `Folder "${eff.source.name}"` : eff.source.level === 'collection' ? `Collection "${collection.name}"` : eff.source.level === 'request' ? 'This request' : 'None';
      return { auth: eff.auth, source };
    },
  };

  const environments: Handlers<'environments'> = {
    list: async ({ workspaceId }) => repos().environments.list(workspaceId),
    create: async ({ workspaceId, name, description, isProduction }) =>
      repos().environments.create(workspaceId, { name: name.trim(), ...(description !== undefined ? { description } : {}), ...(isProduction !== undefined ? { isProduction } : {}) }),
    update: async ({ id, ...patch }) => repos().environments.update(id, patch),
    duplicate: async ({ id }) => ctx.storage.transaction((r) => r.environments.duplicate(id)),
    delete: async ({ id }) => repos().environments.delete(id),
    setActive: async ({ workspaceId, id }) => {
      repos().environments.setActive(workspaceId, id);
      audit.log('CHANGE_ENVIRONMENT', { environment: id ? repos().environments.require(id).name : null });
    },
  };

  const variables: Handlers<'variables'> = {
    get: async (owner) => variableStore(owner).list('refs'),
    set: async ({ entries, ...owner }) => {
      const cleaned = entries.filter((e) => e.key.trim() !== '' || e.initialValue !== '').map((e) => ({ ...e, key: e.key.trim() }));
      return variableStore(owner).set(cleaned);
    },
    revealSecret: async ({ ref }) => {
      if (!isSecretRef(ref)) throw new AppError('IPC_INVALID_ARGUMENT', 'Not a secret reference.');
      const key = secretRefKey(ref);
      if (!/^(var|auth):/.test(key)) throw new AppError('IPC_INVALID_ARGUMENT', 'This secret cannot be revealed.');
      audit.log('EXPORT_SECRETS', { action: 'reveal', kind: key.split(':')[0] });
      return repos().vault.storage.getSync(key) ?? '';
    },
  };

  const cookies: Handlers<'cookies'> = {
    list: async ({ workspaceId, domain }) => repos().cookies.list(workspaceId, domain ? { domain } : {}),
    reveal: async ({ id }) => {
      for (const w of repos().workspaces.list()) {
        const c = repos().cookies.list(w.id, { revealValues: true }).find((x) => x.id === id);
        if (c) return c.value;
      }
      throw new AppError('NOT_FOUND', 'Cookie not found.');
    },
    delete: async ({ id }) => {
      repos().cookies.delete(id);
      for (const w of repos().workspaces.list()) ctx.cookies.invalidate(w.id);
    },
    clear: async ({ workspaceId, domain }) => {
      const n = repos().cookies.clear(workspaceId, domain);
      ctx.cookies.invalidate(workspaceId);
      return n;
    },
    // Manual add/edit from the cookie manager. Attributes are validated in the repository; the value goes to the vault.
    add: async (input) => {
      repos().workspaces.require(input.workspaceId);
      const c = repos().cookies.add(input);
      ctx.cookies.invalidate(input.workspaceId);
      return c;
    },
    update: async ({ id, ...patch }) => {
      const c = repos().cookies.update(id, patch);
      ctx.cookies.invalidate(c.workspaceId);
      return c;
    },
  };

  const certificates: Handlers<'certificates'> = {
    list: async () => repos().certificates.list().map(({ certPem: _p, ...rest }) => rest),
    add: async ({ kind, name, hostPattern, certPem, keyPem, passphrase, pfxBase64, pfxPath }) => {
      if (certPem && !/-----BEGIN [A-Z ]*CERTIFICATE-----/.test(certPem)) throw new AppError('VALIDATION_FAILED', 'The certificate must be PEM encoded.');
      if (keyPem && !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(keyPem)) throw new AppError('VALIDATION_FAILED', 'The private key must be PEM encoded.');
      // PKCS#12 (PFX) client certificates: given inline (base64) or as a local file read here (never by the renderer).
      let pfx: string | undefined;
      if (kind === 'client' && (pfxBase64 || pfxPath)) {
        if (certPem || keyPem) throw new AppError('VALIDATION_FAILED', 'Provide either a PEM certificate + key or a PKCS#12 (PFX) bundle, not both.');
        let bytes: Buffer;
        if (pfxPath) {
          const safe = assertSafeFilePath(pfxPath);
          const info = await stat(safe).catch(() => undefined);
          if (!info?.isFile()) throw new AppError('VALIDATION_FAILED', 'The PFX file could not be read.');
          if (info.size > MAX_PFX_BYTES) throw new AppError('VALIDATION_FAILED', 'The file is too large to be a PKCS#12 bundle.');
          bytes = await readFile(safe);
        } else {
          bytes = Buffer.from(pfxBase64!, 'base64');
          if (bytes.length === 0 || bytes.length > MAX_PFX_BYTES) throw new AppError('VALIDATION_FAILED', 'The PFX data is empty, not base64, or too large.');
        }
        // A PKCS#12 bundle is a DER SEQUENCE (0x30 ...); reject PEM/text pasted by mistake.
        if (bytes[0] !== 0x30) throw new AppError('VALIDATION_FAILED', 'The file does not look like a PKCS#12 (.pfx / .p12) bundle.');
        pfx = bytes.toString('base64');
      }
      if (kind === 'client' && !pfx && (!certPem || !keyPem)) throw new AppError('VALIDATION_FAILED', 'A client certificate needs a certificate and a private key (PEM), or a PKCS#12 bundle.');
      if (kind === 'ca' && !certPem) throw new AppError('VALIDATION_FAILED', 'A CA certificate must be PEM encoded.');
      const created = repos().certificates.add({
        kind,
        name,
        ...(hostPattern ? { hostPattern } : {}),
        ...(certPem ? { certPem } : {}),
        ...(keyPem ? { keyPem } : {}),
        ...(pfx ? { pfxBase64: pfx } : {}),
        ...(passphrase ? { passphrase } : {}),
      });
      audit.log('CHANGE_SECURITY_SETTING', { setting: 'certificates', action: 'add', kind, name, format: pfx ? 'pkcs12' : 'pem' });
      const { certPem: _c, ...view } = created;
      return view;
    },
    pickFile: async ({ purpose }) => {
      const picked = await platform.pickFile({
        title: purpose === 'certificate' ? 'Select certificate (PEM)' : 'Select private key (PEM)',
        filters: [{ name: 'PEM files', extensions: ['pem', 'crt', 'cer', 'key'] }],
      });
      if (!picked) return null;
      if (picked.size > 1024 * 1024) throw new AppError('VALIDATION_FAILED', 'The file is too large to be a certificate or key.');
      return { name: picked.name, content: await readFile(picked.path, 'utf8') };
    },
    setEnabled: async ({ id, enabled }) => repos().certificates.setEnabled(id, enabled),
    delete: async ({ id }) => {
      repos().certificates.delete(id);
      audit.log('CHANGE_SECURITY_SETTING', { setting: 'certificates', action: 'delete', id });
    },
  };

  const settings: Handlers<'settings'> = {
    get: async () => ctx.settings(),
    update: async ({ patch }) => {
      const before = ctx.rawSettings();
      const network = (patch.network ?? {}) as { verifyTls?: unknown };
      if (network.verifyTls === false) policy.assertCanDisableTlsVerification();
      const next = repos().settings.update(patch);
      const sensitive: Array<[string, unknown, unknown]> = [
        ['network.verifyTls', before.network.verifyTls, next.network.verifyTls],
        ['security.localOnly', before.security.localOnly, next.security.localOnly],
        ['security.auditLogEnabled', before.security.auditLogEnabled, next.security.auditLogEnabled],
        ['network.proxy.mode', before.network.proxy.mode, next.network.proxy.mode],
        ['scripting.timeoutMs', before.scripting.timeoutMs, next.scripting.timeoutMs],
        ['history.enabled', before.history.enabled, next.history.enabled],
      ];
      for (const [setting, from, to] of sensitive) if (from !== to) audit.log('CHANGE_SECURITY_SETTING', { setting, from, to });
      if (next.history.retention !== before.history.retention) repos().history.prune(next.history.retention);
      return ctx.settings();
    },
    setProxyPassword: async ({ password }) => {
      if (password) repos().vault.storage.setSync(PROXY_PASSWORD_KEY, password);
      else repos().vault.storage.deleteSync(PROXY_PASSWORD_KEY);
      repos().settings.update({ network: { proxy: { hasPassword: password !== '' } } });
      audit.log('CHANGE_SECURITY_SETTING', { setting: 'network.proxy.password', changed: true });
    },
  };

  const audits: Handlers<'audit'> = {
    list: async ({ action, limit, offset }) => repos().audit.list({ ...(action ? { action } : {}), ...(limit ? { limit } : {}), ...(offset ? { offset } : {}) }),
  };

  const tools: Handlers<'tools'> = {
    decodeJwt: async ({ token }) => {
      const d = decodeJwt(token);
      return { header: d.header, payload: d.payload, ...(d.expiresAt !== undefined ? { expiresAt: d.expiresAt } : {}), ...(d.expired !== undefined ? { expired: d.expired } : {}) };
    },
    pickFile: async ({ purpose }) =>
      platform.pickFile({
        title: purpose === 'upload' ? 'Select file' : 'Select data file',
        filters: purpose === 'upload' ? [{ name: 'All files', extensions: ['*'] }] : [{ name: 'CSV or JSON', extensions: ['csv', 'json'] }],
      }),
    oauth2GetToken: async ({ auth, environmentId, workspaceId, requestId, collectionId, folderId, cancelId }) => {
      const r = repos();
      const env = environmentId !== undefined ? environmentId : (r.environments.getActive(workspaceId)?.id ?? null);
      // Same scope chain as the executor: environment > folders (innermost first) > collection > globals,
      // so `{{clientId}}` defined on the collection or a folder resolves exactly like at send time.
      const stored = requestId ? r.collections.requireRequest(requestId, 'refs') : undefined;
      const effectiveCollectionId = stored?.collectionId ?? collectionId;
      const effectiveFolderId = stored ? stored.folderId : (folderId ?? null);
      const folderChain = effectiveCollectionId ? r.collections.getFolderChain(effectiveFolderId, 'refs') : [];
      const resolver = new VariableResolver({
        environment: scopeFromEntries(env ? r.environments.variables(env, 'resolve') : []),
        folders: folderChain.map((f) => scopeFromEntries(r.vars.folder.list(f.id, 'resolve'))),
        collection: scopeFromEntries(effectiveCollectionId ? r.vars.collection.list(effectiveCollectionId, 'resolve') : []),
        global: scopeFromEntries(r.vars.global.list(workspaceId, 'resolve')),
      });
      const opened = r.vault.openAuth(auth, 'resolve');
      const params = Object.fromEntries(Object.entries(opened.params).map(([k, v]) => [k, typeof v === 'string' ? resolver.resolveString(v) : v]));
      const grant = String(params.grant_type ?? 'authorization_code');
      // Cancellable through `execution.cancel({ executionId: cancelId })`.
      const flowId = cancelId ?? `oauth:${Date.now()}`;
      const ac = executor.track(flowId);
      const authCtx: AuthContext = {
        method: 'POST',
        url: String(params.accessTokenUrl ?? ''),
        headers: [],
        body: { kind: 'none' },
        now: () => ctx.now(),
        send: (req) => executor.sendTokenRequest(req, flowId, ac.signal),
      };
      const cancelled = new Promise<never>((_, reject) => ac.signal.addEventListener('abort', () => reject(ac.signal.reason instanceof Error ? ac.signal.reason : new AppError('REQUEST_CANCELLED', 'The token request was cancelled.')), { once: true }));
      try {
        let token;
        if (grant === 'client_credentials') token = await Promise.race([fetchClientCredentialsToken(params, authCtx), cancelled]);
        else if (grant === 'password_credentials') token = await Promise.race([fetchPasswordToken(params, authCtx), cancelled]);
        else {
          const usePkce = grant === 'authorization_code_with_pkce';
          const pkce = usePkce ? generatePkce(params.challengeAlgorithm === 'plain' ? 'plain' : 'S256') : undefined;
          const state = generateState();
          const url = buildAuthorizationUrl(params, pkce, state);
          const redirectUri = String(params.redirect_uri ?? '');
          if (!redirectUri) throw new AppError('VALIDATION_FAILED', 'A callback URL is required for the authorization code flow.');
          const granted = await Promise.race([platform.authorize({ authUrl: url, redirectUri }), cancelled]);
          if (granted.state !== state) throw new AppError('AUTH_FAILED', 'The authorization response had an unexpected state value (possible CSRF). Try again.');
          token = await Promise.race([exchangeAuthorizationCode(params, authCtx, granted.code, pkce), cancelled]);
        }
        return { params: tokenToParams(token) };
      } finally {
        executor.untrack(flowId);
      }
    },
    // OAuth 2.0 device authorization grant (RFC 8628). Stateless on purpose: the renderer keeps the
    // device code in memory, polls with the returned interval and cancels by not polling again.
    oauth2DeviceStart: async (input) => {
      const { params, authCtx } = deviceFlowSetup(input);
      return startDeviceFlow(params, authCtx);
    },
    oauth2DevicePoll: async (input) => {
      const { params, authCtx } = deviceFlowSetup(input);
      const outcome = await pollDeviceTokenOnce(params, authCtx, input.deviceCode, input.interval);
      return outcome.status === 'done' ? { status: 'done', params: tokenToParams(outcome.token) } : outcome;
    },
  };

  /** Resolve `{{variables}}` of an auth config with the executor's scope chain and build a token-endpoint context (policy host check included). */
  function deviceFlowSetup({ auth, environmentId, workspaceId, requestId, collectionId, folderId }: OAuth2DeviceInput): { params: Record<string, string | number | boolean>; authCtx: AuthContext } {
    const r = repos();
    const env = environmentId !== undefined ? environmentId : (r.environments.getActive(workspaceId)?.id ?? null);
    const stored = requestId ? r.collections.requireRequest(requestId, 'refs') : undefined;
    const effectiveCollectionId = stored?.collectionId ?? collectionId;
    const effectiveFolderId = stored ? stored.folderId : (folderId ?? null);
    const folderChain = effectiveCollectionId ? r.collections.getFolderChain(effectiveFolderId, 'refs') : [];
    const resolver = new VariableResolver({
      environment: scopeFromEntries(env ? r.environments.variables(env, 'resolve') : []),
      folders: folderChain.map((f) => scopeFromEntries(r.vars.folder.list(f.id, 'resolve'))),
      collection: scopeFromEntries(effectiveCollectionId ? r.vars.collection.list(effectiveCollectionId, 'resolve') : []),
      global: scopeFromEntries(r.vars.global.list(workspaceId, 'resolve')),
    });
    const opened = r.vault.openAuth(auth, 'resolve');
    const params = Object.fromEntries(Object.entries(opened.params).map(([k, v]) => [k, typeof v === 'string' ? resolver.resolveString(v) : v]));
    const ac = new AbortController();
    const authCtx: AuthContext = {
      method: 'POST',
      url: String(params.accessTokenUrl ?? ''),
      headers: [],
      body: { kind: 'none' },
      now: () => ctx.now(),
      send: (req) => executor.sendTokenRequest(req, `oauth-device:${Date.now()}`, ac.signal),
    };
    return { params, authCtx };
  }

  return { workspaces, collections, folders, requests, environments, variables, cookies, certificates, settings, audit: audits, tools };
}
