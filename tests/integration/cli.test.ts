import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { XMLValidator } from 'fast-xml-parser';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type TestServer } from '../helpers/http-server';

const root = path.resolve(__dirname, '../..');
const BUNDLE = path.join(root, 'dist', 'cli', 'aegis-cli.cjs');

let server: TestServer;
let dir: string;
const file = (name: string) => path.join(dir, name);

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Spawn the bundle asynchronously: the test server lives in this process and must keep serving while the child runs. */
function cli(args: string[], env: Record<string, string> = {}): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BUNDLE, ...args], {
      cwd: dir,
      env: { ...process.env, NO_COLOR: '1', AEGIS_POLICY_FILE: '', AEGIS_MIGRATIONS_DIR: path.join(root, 'database', 'migrations'), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    const timer = setTimeout(() => child.kill(), 60_000);
    child.on('error', reject);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

const XSS_NAME = '<img src=x onerror=alert(1)>';

function fixtureCollection(): unknown {
  const test = (...lines: string[]) => [{ listen: 'test', script: { type: 'text/javascript', exec: lines } }];
  return {
    info: { name: 'CLI fixture', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    item: [
      {
        name: 'Smoke',
        item: [
          {
            name: 'Echo user',
            event: test(
              'const body = pm.response.json();',
              'pm.test("user echoed", () => pm.expect(body.path).to.include("u=" + pm.variables.get("username")));',
              'pm.test("token header", () => pm.expect(body.headers["x-token"]).to.eql(pm.environment.get("apiToken")));',
              'pm.environment.set("lastPath", body.path);',
            ),
            request: { method: 'GET', header: [{ key: 'X-Token', value: '{{apiToken}}' }], url: '{{baseUrl}}/echo?u={{username}}' },
          },
          {
            name: XSS_NAME,
            event: test('pm.test("created <b>", () => pm.response.to.have.status(201));'),
            request: { method: 'POST', url: '{{baseUrl}}/status/201', body: { mode: 'raw', raw: '{"hello":"world"}' } },
          },
        ],
      },
      {
        name: 'Failing',
        item: [
          {
            name: 'Not found',
            event: test('pm.test("is 200", () => pm.response.to.have.status(200));'),
            request: { method: 'GET', url: '{{baseUrl}}/status/404' },
          },
        ],
      },
      {
        name: 'Slow',
        item: [{ name: 'Slow', request: { method: 'GET', url: '{{baseUrl}}/delay/400' } }],
      },
    ],
  };
}

beforeAll(async () => {
  const build = spawnSync(process.execPath, [path.join(root, 'scripts', 'build-cli.mjs')], { cwd: root, encoding: 'utf8', timeout: 120_000 });
  if (build.status !== 0) throw new Error(`build-cli failed:\n${build.stdout}\n${build.stderr}`);
  expect(existsSync(BUNDLE)).toBe(true);

  server = await startServer();
  dir = mkdtempSync(path.join(os.tmpdir(), 'aegis-cli-test-'));
  writeFileSync(file('collection.json'), JSON.stringify(fixtureCollection()));
  writeFileSync(
    file('env.json'),
    JSON.stringify({
      name: 'CLI env',
      values: [
        { key: 'baseUrl', value: server.url, type: 'default', enabled: true },
        { key: 'apiToken', value: 'tok-123', type: 'secret', enabled: true },
      ],
      _postman_variable_scope: 'environment',
    }),
  );
  writeFileSync(file('globals.json'), JSON.stringify({ values: [{ key: 'username', value: 'global-user', enabled: true }], _postman_variable_scope: 'globals' }));
  writeFileSync(file('data.csv'), 'username\nalice\nbob\n');
  writeFileSync(file('broken.json'), '{ not json');
  writeFileSync(file('policy-blocked.json'), JSON.stringify({ blockedHosts: ['127.0.0.1'] }));
  writeFileSync(file('policy-insecure.json'), JSON.stringify({ allowInsecureTls: true }));
  writeFileSync(file('policy-block-prod.json'), JSON.stringify({ blockProductionRequests: true }));
}, 180_000);

afterAll(async () => {
  await server?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('aegis-cli usage', () => {
  it('--help and --version exit 0', async () => {
    const help = await cli(['--help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('Usage:');
    expect(help.stdout).toContain('--reporters');
    const version = await cli(['--version']);
    expect(version.status).toBe(0);
    expect(version.stdout).toMatch(/^aegis-cli \d+\.\d+\.\d+/);
  });

  it('usage errors exit 2 with a message on stderr', async () => {
    expect((await cli([])).status).toBe(2);
    expect((await cli(['run'])).status).toBe(2);
    expect((await cli(['frobnicate', 'collection.json'])).status).toBe(2);
    const unknown = await cli(['run', 'collection.json', '--bogus']);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain('--bogus');
    expect((await cli(['run', 'missing.json'])).status).toBe(2);
    expect((await cli(['run', 'collection.json', '--reporters', 'cli,xunit'])).stderr).toContain('Unknown reporter "xunit"');
    expect((await cli(['run', 'collection.json', '-n', 'many'])).status).toBe(2);
    expect((await cli(['run', 'collection.json', '--export-environment', 'out.json'])).status).toBe(2);
    expect((await cli(['run', 'collection.json', '-e', 'env.json', '--folder', 'Nope'])).stderr).toContain('Folder "Nope" was not found');
  });

  it('import errors exit 3', async () => {
    const broken = await cli(['run', 'broken.json']);
    expect(broken.status).toBe(3);
    expect(broken.stderr).toMatch(/Collection file could not be imported/);
    const envIsCollection = await cli(['run', 'collection.json', '-e', 'collection.json']);
    expect(envIsCollection.status).toBe(3);
    expect(envIsCollection.stderr).toContain('looks like a collection');
    expect((await cli(['run', 'collection.json', '-g', 'broken.json'])).status).toBe(3);
    writeFileSync(file('empty.csv'), 'username\n');
    expect((await cli(['run', 'collection.json', '-d', 'empty.csv'])).status).toBe(3);
  });
});

describe('aegis-cli run', () => {
  it('runs the collection with env, globals and CSV data, prints the cli report and writes json/junit/html', async () => {
    const r = await cli([
      'run', 'collection.json', '-e', 'env.json', '-g', 'globals.json', '-d', 'data.csv', '-n', '5',
      '--reporters', 'cli,json,junit,html',
      '--reporter-json-export', 'out/report.json', '--reporter-junit-export', 'out/report.xml', '--reporter-html-export', 'out/report.html',
    ]);
    expect(r.status, r.stderr).toBe(1); // "Not found" fails in every iteration
    expect(r.stdout).toContain('Running "CLI fixture" with environment "CLI env"');
    expect(r.stdout).toMatch(/^✓ Echo user\s+200\s+\d+ms$/m);
    expect(r.stdout).toMatch(/^✗ Not found\s+404\s+\d+ms$/m);
    expect(r.stdout).toContain('    ✓ user echoed');
    expect(r.stdout).toContain('    ✓ token header');
    expect(r.stdout).toMatch(/    ✗ is 200  .*expected/);
    expect(r.stdout).toMatch(/^\s+requests\s+8 executed, 2 failed$/m);
    expect(r.stdout).toMatch(/^\s+tests\s+6 passed, 2 failed$/m);
    expect(r.stdout).toContain('FAILED');
    expect(r.stdout).not.toContain('\u001b[');
    expect(r.stdout).not.toContain('tok-123'); // secrets never reach the report

    const json = JSON.parse(readFileSync(file('out/report.json'), 'utf8'));
    expect(json.summary).toMatchObject({ iterations: 2, requests: 8, failedRequests: 2, passedTests: 6, failedTests: 2 });
    expect(json.environment).toBe('CLI env');
    expect(json.items[0].url).toContain('u=alice');
    expect(json.items[4].url).toContain('u=bob');
    expect(json.items[1].name).toBe(XSS_NAME);

    const xml = readFileSync(file('out/report.xml'), 'utf8');
    expect(XMLValidator.validate(xml)).toBe(true);
    expect(xml).toContain('<testsuites name="CLI fixture"');
    expect(xml).toContain('name="user echoed"');
    expect(xml).toMatch(/<failure message="AssertionError: expected response to have status code 200 but got 404" type="AssertionError">/);
    expect(xml).not.toContain('<img');
    expect(xml).toContain('&lt;img src=x onerror=alert(1)&gt;');

    const html = readFileSync(file('out/report.html'), 'utf8');
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).not.toContain('<img');
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('created &lt;b&gt;');
    expect(html).toContain('CLI env');
  }, 60_000);

  it('--folder restricts the run, exit 0 when everything passes, json goes to stdout without an export path', async () => {
    const r = await cli(['run', 'collection.json', '-e', 'env.json', '-g', 'globals.json', '--folder', 'smoke', '--reporters', 'json']);
    expect(r.status, r.stderr).toBe(0);
    const json = JSON.parse(r.stdout);
    expect(json.status).toBe('completed');
    expect(json.summary).toMatchObject({ iterations: 1, requests: 2, failedRequests: 0, failedTests: 0, passedTests: 3 });
    expect(json.items[0].url).toContain('u=global-user');
    expect(r.stdout).not.toContain('✓'); // cli reporter not requested
  }, 60_000);

  it('--bail stops at the first failure and --delay/--timeout are applied', async () => {
    const bail = await cli(['run', 'collection.json', '-e', 'env.json', '-g', 'globals.json', '--bail', '--reporters', 'json']);
    expect(bail.status).toBe(1);
    const json = JSON.parse(bail.stdout);
    expect(json.status).toBe('stopped');
    expect(json.summary.requests).toBe(3);

    const slow = await cli(['run', 'collection.json', '-e', 'env.json', '--folder', 'Slow', '--timeout', '50', '--delay', '10']);
    expect(slow.status).toBe(1);
    expect(slow.stdout).toMatch(/^✗ Slow\s+---\s+.*timed out after 50 ms/m);
  }, 60_000);

  it('policy: blocked hosts fail the run, --insecure is refused unless allowed, --production honours the block', async () => {
    const blocked = await cli(['run', 'collection.json', '-e', 'env.json', '-g', 'globals.json', '--folder', 'Smoke', '--policy', 'policy-blocked.json']);
    expect(blocked.status).toBe(1);
    expect(blocked.stdout).toMatch(/^✗ Echo user\s+---\s+.*policy blocks requests to 127\.0\.0\.1/m);

    const viaEnv = await cli(['run', 'collection.json', '-e', 'env.json', '-g', 'globals.json', '--folder', 'Smoke'], { AEGIS_POLICY_FILE: file('policy-blocked.json') });
    expect(viaEnv.status).toBe(1);
    expect(viaEnv.stdout).toContain('policy blocks requests');

    const insecure = await cli(['run', 'collection.json', '-e', 'env.json', '-g', 'globals.json', '--folder', 'Smoke', '--insecure']);
    expect(insecure.status).toBe(2);
    expect(insecure.stderr).toContain('--insecure was refused');
    expect(insecure.stderr).toContain('allowInsecureTls');

    const insecureAllowed = await cli(['run', 'collection.json', '-e', 'env.json', '-g', 'globals.json', '--folder', 'Smoke', '--insecure', '--policy', 'policy-insecure.json']);
    expect(insecureAllowed.status, insecureAllowed.stderr).toBe(0);

    const prodBlocked = await cli(['run', 'collection.json', '-e', 'env.json', '-g', 'globals.json', '--folder', 'Smoke', '--production', '--policy', 'policy-block-prod.json']);
    expect(prodBlocked.status).toBe(2);
    expect(prodBlocked.stderr).toContain('blockProductionRequests');

    const prodConfirmed = await cli(['run', 'collection.json', '-e', 'env.json', '-g', 'globals.json', '--folder', 'Smoke', '--production']);
    expect(prodConfirmed.status, prodConfirmed.stderr).toBe(0);

    const missingPolicy = await cli(['run', 'collection.json', '--policy', 'nope.json']);
    expect(missingPolicy.status).toBe(2);
  }, 90_000);

  it('--export-environment writes the environment with values changed by scripts', async () => {
    const r = await cli(['run', 'collection.json', '-e', 'env.json', '-g', 'globals.json', '--folder', 'Smoke', '--export-environment', 'out/env-after.json', '--reporters', 'json']);
    expect(r.status, r.stderr).toBe(0);
    const exported = JSON.parse(readFileSync(file('out/env-after.json'), 'utf8'));
    expect(exported.name).toBe('CLI env');
    const values = Object.fromEntries(exported.values.map((v: { key: string; value: string }) => [v.key, v.value]));
    expect(values.baseUrl).toBe(server.url);
    expect(values.lastPath).toContain('/echo?u=global-user');
    expect(values.apiToken).toBe('tok-123'); // default policy allows secret export
  }, 60_000);

  it('colour handling: NO_COLOR wins, --color forces ANSI codes', async () => {
    const forced = await cli(['run', 'collection.json', '-e', 'env.json', '-g', 'globals.json', '--folder', 'Smoke', '--color']);
    expect(forced.status).toBe(0);
    expect(forced.stdout).toContain('\u001b[32m');
    const plain = await cli(['run', 'collection.json', '-e', 'env.json', '-g', 'globals.json', '--folder', 'Smoke', '--no-color']);
    expect(plain.stdout).not.toContain('\u001b[');
  }, 60_000);
});
