import { parseArgs } from 'node:util';
import { REPORTER_NAMES, isReporterName, type ReporterName } from '@aegis/testing';

/** Exit codes of the CLI (documented in docs/features/cli.md). */
export const EXIT = {
  OK: 0,
  /** At least one request or test failed, or the run did not complete. */
  FAILED: 1,
  /** Usage error: unknown option, missing file, option refused by policy. */
  USAGE: 2,
  /** The collection / environment / globals / data file could not be parsed. */
  IMPORT: 3,
} as const;

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export interface RunArgs {
  command: 'run';
  collection: string;
  environment?: string;
  globals?: string;
  data?: string;
  folder?: string;
  iterations: number;
  delayMs: number;
  bail: boolean;
  timeoutMs?: number;
  insecure: boolean;
  production: boolean;
  reporters: ReporterName[];
  exports: Partial<Record<ReporterName, string>>;
  policy?: string;
  exportEnvironment?: string;
  /** undefined = auto-detect (TTY and NO_COLOR), true = force on, false = force off. */
  color?: boolean;
  verbose: boolean;
}

export type CliArgs = { command: 'help' } | { command: 'version' } | RunArgs;

const OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
  environment: { type: 'string', short: 'e' },
  globals: { type: 'string', short: 'g' },
  'iteration-data': { type: 'string', short: 'd' },
  folder: { type: 'string' },
  'iteration-count': { type: 'string', short: 'n' },
  delay: { type: 'string' },
  bail: { type: 'boolean' },
  timeout: { type: 'string' },
  insecure: { type: 'boolean' },
  production: { type: 'boolean' },
  reporters: { type: 'string', short: 'r' },
  'reporter-json-export': { type: 'string' },
  'reporter-junit-export': { type: 'string' },
  'reporter-html-export': { type: 'string' },
  'reporter-cli-export': { type: 'string' },
  policy: { type: 'string' },
  'export-environment': { type: 'string' },
  color: { type: 'boolean' },
  verbose: { type: 'boolean' },
} as const;

export const HELP = `Aegis API Client CLI - run Postman-compatible collections without the desktop app.

Usage:
  aegis-cli run <collection.json> [options]
  aegis-cli --help | --version

Options:
  -e, --environment <file>        Postman environment JSON
  -g, --globals <file>            Postman globals JSON
  -d, --iteration-data <file>     CSV or JSON data file (one iteration per row)
      --folder <name>             Run only this folder (and its sub-folders)
  -n, --iteration-count <n>       Iterations (capped by the data file rows). Default 1
      --delay <ms>                Pause between requests. Default 0
      --bail                      Stop at the first failed request/test
      --timeout <ms>              Request timeout
      --insecure                  Disable TLS certificate validation (only if policy allowInsecureTls is true)
      --production                Treat the environment as production and confirm the production gate
  -r, --reporters <list>          Comma separated: cli,json,junit,html. Default cli
      --reporter-json-export <f>  Write the JSON report to <f>
      --reporter-junit-export <f> Write the JUnit XML report to <f>
      --reporter-html-export <f>  Write the HTML report to <f>
      --reporter-cli-export <f>   Write the plain-text report to <f>
      --policy <file>             Enterprise policy JSON (default: AEGIS_POLICY_FILE, then the OS-wide locations)
      --export-environment <f>    Write the environment (with values changed by scripts) to <f> after the run
      --color / --no-color        Force ANSI colours on/off (NO_COLOR is honoured)
      --verbose                   Print warnings from the engine to stderr
  -h, --help                      Show this help
  -v, --version                   Show the version

Exit codes:
  0  every request and test passed
  1  a request or test failed, or the run did not complete
  2  usage error (bad option, missing file, option refused by policy)
  3  the collection, environment, globals or data file could not be parsed

Environment variables:
  AEGIS_POLICY_FILE      policy file used when --policy is not given
  AEGIS_MIGRATIONS_DIR   folder with the database migrations (packaged installs)
  NO_COLOR               disable colours
`;

function positiveInt(name: string, raw: string | undefined, fallback: number, min = 0): number {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new UsageError(`${name} expects a non-negative integer, got "${raw}".`);
  const n = Number(raw);
  if (n < min) throw new UsageError(`${name} must be at least ${min}.`);
  if (n > 1_000_000_000) throw new UsageError(`${name} is too large.`);
  return n;
}

/** Parse `argv` (without the node/script entries). Throws `UsageError` for anything the user got wrong. */
export function parseCliArgs(argv: readonly string[]): CliArgs {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true; allowNegative: true; strict: true }>>;
  try {
    parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, allowNegative: true, strict: true });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  const { values, positionals } = parsed;
  if (values.help) return { command: 'help' };
  if (values.version) return { command: 'version' };
  const [command, collection, ...rest] = positionals;
  if (!command) throw new UsageError('Missing command. Try: aegis-cli run <collection.json>');
  if (command !== 'run') throw new UsageError(`Unknown command "${command}". The only command is "run".`);
  if (!collection) throw new UsageError('Missing collection file. Usage: aegis-cli run <collection.json>');
  if (rest.length) throw new UsageError(`Unexpected argument "${rest[0]}".`);

  const reporters: ReporterName[] = [];
  for (const r of (values.reporters ?? 'cli').split(',').map((s) => s.trim()).filter(Boolean)) {
    if (!isReporterName(r)) throw new UsageError(`Unknown reporter "${r}". Available: ${REPORTER_NAMES.join(', ')}.`);
    if (!reporters.includes(r)) reporters.push(r);
  }
  const exports: RunArgs['exports'] = {};
  for (const name of REPORTER_NAMES) {
    const file = values[`reporter-${name}-export`];
    if (file) {
      exports[name] = file;
      if (!reporters.includes(name)) reporters.push(name);
    }
  }
  const timeout = values.timeout === undefined ? undefined : positiveInt('--timeout', values.timeout, 0, 1);
  return {
    command: 'run',
    collection,
    ...(values.environment ? { environment: values.environment } : {}),
    ...(values.globals ? { globals: values.globals } : {}),
    ...(values['iteration-data'] ? { data: values['iteration-data'] } : {}),
    ...(values.folder ? { folder: values.folder } : {}),
    iterations: positiveInt('--iteration-count', values['iteration-count'], 1, 1),
    delayMs: positiveInt('--delay', values.delay, 0),
    bail: values.bail === true,
    ...(timeout !== undefined ? { timeoutMs: timeout } : {}),
    insecure: values.insecure === true,
    production: values.production === true,
    reporters,
    exports,
    ...(values.policy ? { policy: values.policy } : {}),
    ...(values['export-environment'] ? { exportEnvironment: values['export-environment'] } : {}),
    ...(values.color !== undefined ? { color: values.color } : {}),
    verbose: values.verbose === true,
  };
}
