import { describe, expect, it } from 'vitest';
import type { FormDataEntry, KeyValueEntry } from '@aegis/core';
import { parseBulk, parseFormBulk, serializeBulk, serializeFormBulk } from '../../apps/desktop/renderer/src/lib/bulk-edit';

const kv = (key: string, value = '', enabled = true, description?: string): KeyValueEntry => ({ key, value, enabled, ...(description ? { description } : {}) });

describe('bulk edit: serialize / parse', () => {
  it('writes one key:value per line and prefixes disabled rows with //', () => {
    expect(serializeBulk([kv('a', '1'), kv('b', 'x:y', false), kv('c')])).toBe('a:1\n//b:x:y\nc:');
  });

  it('parses lines, splitting at the first colon only and trimming around it', () => {
    expect(parseBulk('a:1\n  b : http://x.test/p?q=1 \n//c:3\n\nd')).toEqual([kv('a', '1'), kv('b', 'http://x.test/p?q=1'), kv('c', '3', false), kv('d')]);
  });

  it('skips empty and comment-only lines and accepts CRLF', () => {
    expect(parseBulk('a:1\r\n//\r\n   \r\nb:2')).toEqual([kv('a', '1'), kv('b', '2')]);
  });

  it('round-trips without loss and keeps descriptions of unchanged rows', () => {
    const rows = [kv('token', '{{t}}', true, 'auth token'), kv('page', '2', false, 'pagination'), kv('x', '')];
    const text = serializeBulk(rows);
    expect(parseBulk(text, rows)).toEqual(rows);
    // editing a value keeps the description, reordering keeps it too, a new key has none
    const edited = parseBulk('page:3\ntoken:{{other}}\nnew:1', rows);
    expect(edited).toEqual([kv('page', '3', true, 'pagination'), kv('token', '{{other}}', true, 'auth token'), kv('new', '1')]);
  });

  it('matches duplicate keys positionally so each description is used once', () => {
    const rows = [kv('k', '1', true, 'first'), kv('k', '2', true, 'second')];
    expect(parseBulk('k:1\nk:2', rows)).toEqual(rows);
    expect(parseBulk('k:2', rows).map((r) => r.description)).toEqual(['first']);
  });

  it('form-data: text rows round-trip; file rows survive when the line is unchanged', () => {
    const rows: FormDataEntry[] = [
      { key: 'name', type: 'text', value: 'Ada', enabled: true, description: 'who' },
      { key: 'upload', type: 'file', value: 'avatar.png', filePath: 'C:/pics/avatar.png', contentType: 'image/png', enabled: true },
      { key: 'ref', type: 'variable', value: 'userId', enabled: false },
    ];
    const text = serializeFormBulk(rows);
    expect(text).toBe('name:Ada\nupload:avatar.png\n//ref:userId');
    expect(parseFormBulk(text, rows)).toEqual(rows);
    // the file line was changed -> it becomes a text row (files cannot be chosen in text mode)
    const changed = parseFormBulk('name:Ada\nupload:other.png', rows);
    expect(changed[1]).toEqual({ key: 'upload', type: 'text', value: 'other.png', enabled: true, contentType: 'image/png' });
    // disabling the file line keeps the file
    expect(parseFormBulk('name:Ada\n//upload:avatar.png', rows)[1]).toEqual({ ...rows[1], enabled: false });
  });
});
