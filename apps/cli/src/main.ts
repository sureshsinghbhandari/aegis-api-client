import { EXIT, HELP, UsageError, parseCliArgs } from './args';
import { CLI_NAME, cliVersion } from './bootstrap';
import { ImportError, runCommand, type RunIo } from './run';

function flush(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => stream.write('', () => resolve()));
}

async function main(argv: string[]): Promise<number> {
  const io: RunIo = {
    stdout: (t) => void process.stdout.write(t),
    stderr: (t) => void process.stderr.write(t),
    env: process.env,
    isTty: process.stdout.isTTY === true,
    onInterrupt(handler) {
      const once = () => handler();
      process.once('SIGINT', once);
      return () => process.off('SIGINT', once);
    },
  };
  try {
    const args = parseCliArgs(argv);
    if (args.command === 'help') {
      io.stdout(HELP);
      return EXIT.OK;
    }
    if (args.command === 'version') {
      io.stdout(`${CLI_NAME} ${cliVersion()}\n`);
      return EXIT.OK;
    }
    return await runCommand(args, io);
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`${CLI_NAME}: ${error.message}\nRun "${CLI_NAME} --help" for usage.\n`);
      return EXIT.USAGE;
    }
    if (error instanceof ImportError) {
      io.stderr(`${CLI_NAME}: ${error.message}\n`);
      return EXIT.IMPORT;
    }
    io.stderr(`${CLI_NAME}: unexpected error: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT.FAILED;
  }
}

void main(process.argv.slice(2)).then(async (code) => {
  await Promise.all([flush(process.stdout), flush(process.stderr)]);
  // Let the event loop drain on its own: calling process.exit() while libuv is still closing handles
  // (sqlite, undici sockets) trips a libuv assertion on Windows.
  process.exitCode = code;
});
