import { describe, expect, it } from 'vitest';
import { applyJsonPathToText, evaluateJsonPath, formatJsonPathResults, JsonPathError, parseJsonPath } from '../../apps/desktop/renderer/src/lib/jsonpath';

const data = {
  store: {
    book: [
      { category: 'reference', author: 'Nigel Rees', title: 'Sayings of the Century', price: 8.95, tags: ['a'] },
      { category: 'fiction', author: 'Evelyn Waugh', title: 'Sword of Honour', price: 12.99 },
      { category: 'fiction', author: 'Herman Melville', title: 'Moby Dick', isbn: '0-553-21311-3', price: 8.99 },
      { category: 'fiction', author: 'J. R. R. Tolkien', title: 'The Lord of the Rings', isbn: '0-395-19395-8', price: 22.99 },
    ],
    bicycle: { color: 'red', price: 19.95 },
  },
  'weird key': { 'a-b': 1 },
  items: [{ id: 1, ok: true, n: null }, { id: 2, ok: false }, { id: 3 }],
  nested: { deep: { deeper: { value: 'x' } } },
};

describe('JSONPath subset: table of expressions', () => {
  const table: Array<[string, unknown[]]> = [
    ['$', [data]],
    ['$.store.bicycle.color', ['red']],
    ['store.bicycle.color', ['red']],
    ["$['store']['bicycle']['color']", ['red']],
    ['$["weird key"]["a-b"]', [1]],
    ['$.store.book[0].author', ['Nigel Rees']],
    ['$.store.book[-1].author', ['J. R. R. Tolkien']],
    ['$.store.book[*].author', ['Nigel Rees', 'Evelyn Waugh', 'Herman Melville', 'J. R. R. Tolkien']],
    ['$.store.book.*.price', [8.95, 12.99, 8.99, 22.99]],
    ['$..author', ['Nigel Rees', 'Evelyn Waugh', 'Herman Melville', 'J. R. R. Tolkien']],
    ['$..book[2].title', ['Moby Dick']],
    ['$.store.book[0,2].title', ['Sayings of the Century', 'Moby Dick']],
    ["$.store.book[0]['title','price']", ['Sayings of the Century', 8.95]],
    ['$.store.book[1:3].price', [12.99, 8.99]],
    ['$.store.book[:2].price', [8.95, 12.99]],
    ['$.store.book[-2:].price', [8.99, 22.99]],
    ['$.store.book[::2].price', [8.95, 8.99]],
    ['$.store.book[?(@.isbn)].title', ['Moby Dick', 'The Lord of the Rings']],
    ['$.store.book[?(@.price < 10)].title', ['Sayings of the Century', 'Moby Dick']],
    ['$.store.book[?(@.price >= 12.99 && @.category == "fiction")].title', ['Sword of Honour', 'The Lord of the Rings']],
    ["$.store.book[?(@.category != 'fiction')].author", ['Nigel Rees']],
    ['$.store.book[?(@.price > 20 || @.price < 9)].price', [8.95, 8.99, 22.99]],
    ['$.store.book[?(!@.isbn)].price', [8.95, 12.99]],
    ['$.store.book[?(@.tags[0] == "a")].author', ['Nigel Rees']],
    ['$.items[?(@.ok == true)].id', [1]],
    ['$.items[?(@.ok == false)].id', [2]],
    ['$.items[?(@.n == null)].id', [1]],
    ['$.items[?(@.id > 1)]', [{ id: 2, ok: false }, { id: 3 }]],
    ['$.nested..value', ['x']],
    ['$..[?(@.color)]', [{ color: 'red', price: 19.95 }]],
    ['$.store..price', [8.95, 12.99, 8.99, 22.99, 19.95]],
    ['$.does.not.exist', []],
    ['$.store.book[99]', []],
    ['$.store.book[?(@.price > 1000)]', []],
    ['$.store.book[?($.store.bicycle.color == "red")].price', [8.95, 12.99, 8.99, 22.99]],
  ];
  for (const [expr, expected] of table) {
    it(expr, () => {
      expect(evaluateJsonPath(data, expr)).toEqual(expected);
    });
  }
});

describe('JSONPath subset: errors and safety', () => {
  const invalid = ['$.', '$[', '$.a[?(@.x ==)]', '$.a[?(@.x)', '$["unterminated', '$.a[1:2:0]', '$.a[?(@.x =~ /re/)]', '$.a b', '$.a[?(process.exit(1))]', '$.a[?(@.x == alert(1))]'];
  for (const expr of invalid) {
    it(`rejects ${JSON.stringify(expr)}`, () => {
      expect(() => parseJsonPath(expr)).toThrow(JsonPathError);
    });
  }
  it('reports the position of the problem', () => {
    try {
      parseJsonPath('$.store[?(@.x >< 1)]');
      expect.fail('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(JsonPathError);
      expect((e as JsonPathError).message).toMatch(/position \d+/);
    }
  });
  it('never touches prototypes or inherited properties', () => {
    expect(evaluateJsonPath({ a: 1 }, '$.constructor')).toEqual([]);
    expect(evaluateJsonPath({ a: 1 }, '$.__proto__')).toEqual([]);
    expect(evaluateJsonPath([1], '$.length')).toEqual([]);
    expect(evaluateJsonPath({ a: 1 }, '$["toString"]')).toEqual([]);
  });
  it('caps the expression length', () => {
    expect(() => parseJsonPath('$' + '.a'.repeat(2000))).toThrow(/too long/);
  });
  it('survives cyclic and deeply nested data', () => {
    const cyc: Record<string, unknown> = { a: 1 };
    cyc.self = cyc;
    expect(() => evaluateJsonPath(cyc, '$..a')).not.toThrow();
    let deep: unknown = 'leaf';
    for (let i = 0; i < 5000; i++) deep = { d: deep };
    expect(() => evaluateJsonPath(deep, '$..d')).not.toThrow();
  });
  it('does not use eval or Function', () => {
    // (also enforced by eslint no-eval / no-new-func): a filter cannot execute code
    const spy = { called: false };
    const g = globalThis as unknown as { evalTrap?: () => void };
    g.evalTrap = () => {
      spy.called = true;
    };
    expect(() => evaluateJsonPath(data, '$.items[?(evalTrap())]')).toThrow(JsonPathError);
    expect(spy.called).toBe(false);
    delete g.evalTrap;
  });
});

describe('applyJsonPathToText / formatJsonPathResults', () => {
  it('filters JSON text and formats single values for definite paths', () => {
    const out = applyJsonPathToText(JSON.stringify(data), '$.store.bicycle.color');
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.definite).toBe(true);
      expect(formatJsonPathResults(out)).toBe('"red"');
    }
    const many = applyJsonPathToText(JSON.stringify(data), '$.items[*].id');
    expect(many.ok && formatJsonPathResults(many)).toBe('[\n  1,\n  2,\n  3\n]');
  });
  it('reports invalid JSON and invalid expressions as messages, never throws', () => {
    expect(applyJsonPathToText('{not json', '$.a')).toEqual({ ok: false, error: 'The response body is not valid JSON.' });
    const bad = applyJsonPathToText('{"a":1}', '$.a[');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/Expected|position/);
  });
  it('handles a BOM', () => {
    expect(applyJsonPathToText('﻿{"a":[1,2]}', '$.a[1]')).toMatchObject({ ok: true, results: [2] });
  });
});
