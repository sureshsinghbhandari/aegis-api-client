import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { API_CHANNELS } from '@aegis/core';

const root = path.resolve(__dirname, '../..');
const read = (f: string) => readFileSync(path.join(root, f), 'utf8');

describe('documentation stays in sync with the code', () => {
  it('API.md lists every IPC channel', () => {
    const doc = read('API.md');
    for (const channel of API_CHANNELS) expect(doc, channel).toContain(`\`${channel}\``);
  });

  it('never claims full Postman compatibility', () => {
    for (const f of ['README.md', 'docs/postman-compatibility/compatibility.md', 'ARCHITECTURE.md', 'SECURITY.md']) {
      expect(read(f), f).not.toMatch(/100\s*%\s*(postman\s*)?compatible/i);
    }
  });

  it('the required top-level documents exist', () => {
    for (const f of ['README.md', 'ARCHITECTURE.md', 'SECURITY.md', 'API.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'LICENSE']) expect(() => read(f), f).not.toThrow();
  });
});
