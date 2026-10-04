import { AppError, DEFAULT_SETTINGS, type AegisApi, type ApiChannel, type AppInfo, type AppSettings } from '@aegis/core';
import type { AppContext, AppDeps } from './context';
import { CookieJarService } from './cookie-jar';
import { RequestExecutor } from './executor';
import { ResponseStore } from './response-store';
import { createCoreServices } from './services/core-services';
import { createHistoryService, createRunnerService } from './services/history-runner';
import { createImportExportService } from './services/import-export';

export type HandlerMap = Record<ApiChannel, (args: never) => Promise<unknown>>;

export interface AegisApp {
  api: Omit<AegisApi, 'events'>;
  /** Channel -> handler table used by the Electron IPC layer. */
  handlers: HandlerMap;
  executor: RequestExecutor;
  ctx: AppContext;
  dispose(): Promise<void>;
}

/** Composition root of the application services. Contains no Electron code, so it is fully testable. */
export function createApp(deps: AppDeps): AegisApp {
  const repos = () => deps.storage.repos;
  const ctx: AppContext = {
    deps,
    storage: deps.storage,
    cookies: new CookieJarService(deps.storage.repos.cookies),
    responses: new ResponseStore(),
    rawSettings: (): AppSettings => repos().settings.getAll(),
    settings: (): AppSettings => deps.policy.effectiveSettings(repos().settings.getAll()),
    now: deps.now ?? (() => Date.now()),
    progress: (p, token) => deps.emit('import:progress', { ...p, ...(token ? { token } : {}) }),
  };

  // First run: make sure there is a workspace, and apply history retention.
  if (repos().workspaces.list().length === 0) repos().workspaces.create('Personal', 'Default workspace');
  repos().history.prune(ctx.rawSettings().history.retention);

  const executor = new RequestExecutor(ctx);
  const core = createCoreServices(ctx, executor);

  const api: Omit<AegisApi, 'events'> = {
    app: {
      info: async (): Promise<AppInfo> => ({
        name: deps.info.name,
        version: deps.info.version,
        platform: deps.info.platform,
        dataDir: deps.paths.dataDir,
        secretStorage: deps.storage.secrets.description,
        secretStorageAvailable: deps.secretStorageAvailable,
        policy: deps.policy.current,
        settings: ctx.settings(),
        localOnly: ctx.settings().security.localOnly,
      }),
    },
    ...core,
    execution: {
      send: async (input) => (await executor.execute(input)).result,
      cancel: ({ executionId }) => executor.cancel(executionId),
    },
    responses: {
      readChunk: ({ responseId, offset, length }) => ctx.responses.readChunk(responseId, offset, length),
      saveAs: async ({ responseId, suggestedName }) => {
        const target = await deps.platform.saveFile({ title: 'Save response body', defaultName: suggestedName, filters: [{ name: 'All files', extensions: ['*'] }] });
        if (!target) return null;
        await ctx.responses.saveTo(responseId, target);
        return target;
      },
      release: ({ responseId }) => ctx.responses.release(responseId),
    },
    history: createHistoryService(ctx, executor),
    runner: createRunnerService(ctx, executor),
    importExport: createImportExportService(ctx),
  };

  const handlers = {} as HandlerMap;
  for (const [ns, methods] of Object.entries(api)) {
    for (const [method, fn] of Object.entries(methods as Record<string, (a: unknown) => Promise<unknown>>)) {
      handlers[`${ns}.${method}` as ApiChannel] = ((args: unknown) => fn(args ?? {})) as never;
    }
  }

  return {
    api,
    handlers,
    executor,
    ctx,
    async dispose() {
      await ctx.responses.releaseAll();
    },
  };
}

export { DEFAULT_SETTINGS, AppError };
