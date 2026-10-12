import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isAppError, type AegisEvents, type CollectionBundle, type EnvironmentBundle, type ImportWarningModel, type RunnerDoneEvent, type RunnerItemEvent } from '@aegis/core';
import { detectPostmanFormat, exportPostmanEnvironment, parsePostmanCollection, parsePostmanEnvironment, parsePostmanGlobals, serializePostmanJson } from '@aegis/postman';
import { formatCliItem, formatCliSummary, parseIterationData, renderReport, type ReportMeta, type ReporterName, type RunItem, type RunReport } from '@aegis/testing';
import { EXIT, UsageError, type RunArgs } from './args';
import { CLI_NAME, cliVersion, createCliApp, type CliApp } from './bootstrap';

export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportError';
  }
}

const MAX_INPUT_BYTES = 256 * 1024 * 1024;

export interface RunIo {
  stdout(text: string): void;
  stderr(text: string): void;
  env: NodeJS.ProcessEnv;
  isTty: boolean;
  /** Resolves when the user asked to stop (Ctrl+C). Optional. */
  onInterrupt?(handler: () => void): () => void;
}

function readInput(file: string, what: string): string {
  if (!existsSync(file)) throw new UsageError(`${what} file not found: ${file}`);
  const buf = readFileSync(file);
  if (buf.length > MAX_INPUT_BYTES) throw new ImportError(`${what} file is larger than ${MAX_INPUT_BYTES / 1024 / 1024} MB: ${file}`);
  return buf.toString('utf8');
}

function parseJsonInput(text: string, what: string, file: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new ImportError(`${what} file is not valid JSON: ${file}`);
  }
}

function importError(error: unknown, what: string, file: string): ImportError {
  const message = isAppError(error) || error instanceof Error ? error.message : String(error);
  return new ImportError(`${what} file could not be imported (${file}): ${message}`);
}

function useColor(args: RunArgs, io: RunIo): boolean {
  if (args.color !== undefined) return args.color;
  if (io.env.NO_COLOR !== undefined && io.env.NO_COLOR !== '') return false;
  return io.isTty;
}

function reportWarnings(io: RunIo, what: string, warnings: ImportWarningModel[], verbose: boolean): void {
  const errors = warnings.filter((w) => w.severity === 'ERROR');
  const others = warnings.length - errors.length;
  if (!warnings.length) return;
  io.stderr(`[${CLI_NAME}] ${what}: ${errors.length} import error(s), ${others} warning(s)${verbose ? '' : ' (use --verbose for details)'}\n`);
  if (verbose) for (const w of warnings) io.stderr(`  ${w.severity}${w.path ? ` at ${w.path}` : ''}: ${w.message}\n`);
}

export function itemFromEvent(i: RunnerItemEvent): RunItem {
  return {
    index: i.index,
    iteration: i.iteration,
    request: { id: i.requestId ?? '', name: i.name, method: i.method, url: i.url },
    statusCode: i.statusCode,
    durationMs: i.durationMs,
    method: i.method,
    url: i.url,
    passed: i.passed,
    ...(i.error ? { error: i.error } : {}),
    tests: i.tests,
  };
}

/** Turn the streamed runner events back into the pure `RunReport` the reporters consume. */
export function reportFromEvents(items: RunnerItemEvent[], done: RunnerDoneEvent): RunReport {
  const runItems = items.map(itemFromEvent);
  return {
    status: done.status,
    items: runItems,
    totalRequests: done.totalRequests,
    passedTests: done.passedTests,
    failedTests: done.failedTests,
    failedRequests: runItems.filter((i) => !i.passed).length,
    durationMs: done.durationMs,
    iterationCount: runItems.reduce((n, i) => Math.max(n, i.iteration + 1), 0),
  };
}

export function exitCodeFor(report: RunReport): number {
  return report.status === 'completed' && report.failedTests === 0 && report.failedRequests === 0 ? EXIT.OK : EXIT.FAILED;
}

function writeExport(file: string, content: string): void {
  mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  writeFileSync(file, content, 'utf8');
}

/** The `run` command. Returns the process exit code; throws UsageError / ImportError for the caller to map. */
export async function runCommand(args: RunArgs, io: RunIo): Promise<number> {
  // ----- inputs (validated before anything heavy is loaded)
  const collectionText = readInput(args.collection, 'Collection');
  const environmentText = args.environment ? readInput(args.environment, 'Environment') : undefined;
  const globalsText = args.globals ? readInput(args.globals, 'Globals') : undefined;
  const dataText = args.data ? readInput(args.data, 'Data') : undefined;
  if (args.exportEnvironment && !args.environment) throw new UsageError('--export-environment requires an environment (-e).');

  let bundle: CollectionBundle;
  try {
    const res = parsePostmanCollection(collectionText);
    bundle = res.bundle;
    reportWarnings(io, 'collection', res.warnings, args.verbose);
  } catch (error) {
    throw importError(error, 'Collection', args.collection);
  }

  const parseValues = (text: string, what: string, file: string, kind: 'environment' | 'globals'): EnvironmentBundle => {
    const json = parseJsonInput(text, what, file);
    const fmt = detectPostmanFormat(json);
    if (fmt === 'collection-v2.0' || fmt === 'collection-v2.1') throw new ImportError(`${what} file looks like a collection, not ${kind === 'environment' ? 'an environment' : 'globals'}: ${file}`);
    try {
      const res = kind === 'globals' ? parsePostmanGlobals(json as object) : parsePostmanEnvironment(json as object);
      reportWarnings(io, kind, res.warnings, args.verbose);
      return res.bundle;
    } catch (error) {
      throw importError(error, what, file);
    }
  };
  const environment = environmentText !== undefined ? parseValues(environmentText, 'Environment', args.environment!, 'environment') : undefined;
  const globals = globalsText !== undefined ? parseValues(globalsText, 'Globals', args.globals!, 'globals') : undefined;
  if (dataText !== undefined) {
    try {
      const rows = parseIterationData(path.basename(args.data!), dataText);
      if (rows.length === 0) throw new Error('the file contains no data rows');
    } catch (error) {
      throw importError(error, 'Data', args.data!);
    }
  }

  // ----- engine
  const cli: CliApp = createCliApp({ ...(args.policy ? { policyFile: args.policy } : {}), verbose: args.verbose, env: io.env });
  try {
    return await runWithApp(cli, args, io, { bundle, environment, globals, dataText });
  } finally {
    await cli.close();
  }
}

async function runWithApp(
  cli: CliApp,
  args: RunArgs,
  io: RunIo,
  inputs: { bundle: CollectionBundle; environment?: EnvironmentBundle; globals?: EnvironmentBundle; dataText?: string },
): Promise<number> {
  const { policy, storage, api, events } = cli;
  const color = useColor(args, io);

  // ----- policy gates that must be explicit in a non-interactive tool
  if (args.insecure && !policy.current.allowInsecureTls) {
    throw new UsageError('--insecure was refused: organization policy does not allow disabling certificate validation (allowInsecureTls is false).');
  }
  if (args.production && policy.productionGate(true) === 'block') {
    throw new UsageError('--production was refused: organization policy blocks requests to production environments (blockProductionRequests is true).');
  }
  if (args.verbose && cli.policyFile) io.stderr(`[${CLI_NAME}] policy loaded from ${cli.policyFile}\n`);

  const settingsPatch: Record<string, unknown> = {};
  if (args.timeoutMs !== undefined) settingsPatch.timeoutMs = args.timeoutMs;
  if (args.insecure) settingsPatch.verifyTls = false;
  if (Object.keys(settingsPatch).length) storage.repos.settings.update({ network: settingsPatch });

  // ----- import into the in-memory workspace (same repositories the desktop import uses)
  const workspace = storage.repos.workspaces.list()[0]!;
  const imported = storage.transaction((r) => {
    const { collectionId } = r.collections.insertBundle(workspace.id, inputs.bundle);
    const env = inputs.environment ? r.environments.create(workspace.id, { name: inputs.environment.name, description: inputs.environment.description ?? '', isProduction: args.production }, inputs.environment.variables) : null;
    if (inputs.globals) r.vars.global.replaceAll(workspace.id, inputs.globals.variables);
    return { collectionId, env };
  });

  let folderId: string | null = null;
  if (args.folder) {
    const folders = storage.repos.collections.getTreeRows(imported.collectionId).filter((r) => r.kind === 'folder');
    const exact = folders.filter((f) => f.name === args.folder);
    const matches = exact.length ? exact : folders.filter((f) => f.name.toLowerCase() === args.folder!.toLowerCase());
    if (!matches.length) throw new UsageError(`Folder "${args.folder}" was not found in collection "${inputs.bundle.name}".`);
    if (matches.length > 1) io.stderr(`[${CLI_NAME}] warning: ${matches.length} folders are named "${args.folder}"; running the first one in tree order.\n`);
    folderId = matches[0]!.id;
  }

  // ----- run through the same RunnerService the desktop uses, streaming items as they complete
  // This process owns exactly one run, so every runner event belongs to it (checked again by runId below).
  const items: RunnerItemEvent[] = [];
  const printLive = args.reporters.includes('cli');
  const startedAt = new Date().toISOString();
  const done = new Promise<RunnerDoneEvent>((resolve) => {
    const onItem = (e: AegisEvents['runner:item']) => {
      items.push(e);
      if (printLive) io.stdout(`${formatCliItem(itemFromEvent(e), { color })}\n`);
    };
    const onDone = (e: AegisEvents['runner:done']) => {
      events.off('runner:item', onItem);
      events.off('runner:done', onDone);
      resolve(e);
    };
    events.on('runner:item', onItem);
    events.on('runner:done', onDone);
  });

  if (printLive) {
    const envLabel = imported.env ? ` with environment "${imported.env.name}"` : '';
    io.stdout(`${CLI_NAME} ${cliVersion()}\nRunning "${inputs.bundle.name}"${args.folder ? ` / folder "${args.folder}"` : ''}${envLabel}\n\n`);
  }

  const started = await api.runner.start({
    workspaceId: workspace.id,
    collectionId: imported.collectionId,
    folderId,
    environmentId: imported.env ? imported.env.id : null,
    iterations: args.iterations,
    delayMs: args.delayMs,
    stopOnFailure: args.bail,
    ...(inputs.dataText !== undefined ? { dataFile: { name: path.basename(args.data!), content: inputs.dataText } } : {}),
    ...(args.production ? { confirmProduction: true } : {}),
  });
  const stopOnInterrupt = io.onInterrupt?.(() => {
    io.stderr(`\n[${CLI_NAME}] stopping the run...\n`);
    void api.runner.stop({ runId: started.runId });
  });
  const doneEvent = await done;
  stopOnInterrupt?.();

  // ----- reports
  const report = reportFromEvents(items.filter((i) => i.runId === started.runId), doneEvent);
  const meta: ReportMeta = {
    name: inputs.bundle.name,
    environment: imported.env?.name ?? null,
    startedAt,
    finishedAt: new Date().toISOString(),
    generator: `Aegis API Client CLI ${cliVersion()}`,
  };
  for (const name of args.reporters as ReporterName[]) {
    const target = args.exports[name];
    if (name === 'cli') {
      io.stdout(`${formatCliSummary(report, meta, { color })}\n`);
      if (target) writeExport(target, `${renderReport('cli', report, meta, { cli: { color: false } })}\n`);
      continue;
    }
    const rendered = renderReport(name, report, meta);
    if (target) writeExport(target, rendered);
    else io.stdout(rendered);
  }
  if (args.exportEnvironment && imported.env) {
    const includeSecrets = policy.current.allowSecretExport;
    const variables = storage.repos.environments.variables(imported.env.id, includeSecrets ? 'resolve' : 'blank');
    const doc = exportPostmanEnvironment({ name: imported.env.name, description: imported.env.description, variables, ...(inputs.environment?.sourceMetadata ? { sourceMetadata: inputs.environment.sourceMetadata } : {}) }, { includeSecrets });
    writeExport(args.exportEnvironment, serializePostmanJson(doc));
    if (!includeSecrets) io.stderr(`[${CLI_NAME}] secret values were left blank in ${args.exportEnvironment} (policy allowSecretExport is false).\n`);
  }
  return exitCodeFor(report);
}
