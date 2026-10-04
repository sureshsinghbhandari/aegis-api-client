import { describe, expect, it } from 'vitest';
import { offsetForFraction, splitDisplayLines } from '../../apps/desktop/renderer/src/lib/chunks';
import { detectContentKind, formatHtml, formatJson, formatXml, prettyPrint, suggestedFileName } from '../../apps/desktop/renderer/src/lib/format';
import { getScript, hasScript, setScript } from '../../apps/desktop/renderer/src/lib/scripts';

describe('formatJson', () => {
  it('pretty prints nested structures', () => {
    expect(formatJson('{"a":1,"b":[1,2,{"c":null}],"d":{}}')).toBe('{\n  "a": 1,\n  "b": [\n    1,\n    2,\n    {\n      "c": null\n    }\n  ],\n  "d": {}\n}');
  });
  it('does not alter literals, escapes or large numbers', () => {
    const out = formatJson('{"big":12345678901234567890,"s":"a\\"b, {x}: [y]","e":1e3}')!;
    expect(out).toContain('12345678901234567890');
    expect(out).toContain('"a\\"b, {x}: [y]"');
    expect(out).toContain('1e3');
    expect(() => JSON.parse(out)).not.toThrow();
  });
  it('returns null for invalid JSON', () => {
    expect(formatJson('{oops')).toBeNull();
    expect(formatJson('')).toBeNull();
  });
  it('handles top-level scalars and BOM', () => {
    expect(formatJson('﻿ 42 ')).toBe('42');
    expect(formatJson('"x"')).toBe('"x"');
  });
});

describe('formatXml / formatHtml', () => {
  it('indents nested elements and keeps text inline', () => {
    const out = formatXml('<?xml version="1.0"?><root><a id="1">hi</a><b/><c><d>x</d></c></root>');
    expect(out).toBe('<?xml version="1.0"?>\n<root>\n  <a id="1">hi</a>\n  <b/>\n  <c>\n    <d>x</d>\n  </c>\n</root>');
  });
  it('keeps comments and CDATA intact', () => {
    expect(formatXml('<r><!-- note --><![CDATA[<x>]]></r>')).toBe('<r>\n  <!-- note -->\n  <![CDATA[<x>]]>\n</r>');
  });
  it('does not indent after void HTML elements and keeps script content verbatim', () => {
    const out = formatHtml('<html><body><img src="a.png"><br><p>t</p><script>if (a<b) {x()}</script></body></html>');
    expect(out).toBe('<html>\n  <body>\n    <img src="a.png">\n    <br>\n    <p>t</p>\n    <script>\n      if (a<b) {x()}\n    </script>\n  </body>\n</html>');
  });
  it('never throws on malformed input', () => {
    expect(() => formatXml('<a><b></a>')).not.toThrow();
    expect(formatXml('plain text')).toBe('plain text');
  });
});

describe('detectContentKind / prettyPrint', () => {
  it('uses the content type first', () => {
    expect(detectContentKind('application/json; charset=utf-8', '', false)).toBe('json');
    expect(detectContentKind('application/problem+json', '', false)).toBe('json');
    expect(detectContentKind('text/html', '', false)).toBe('html');
    expect(detectContentKind('application/xml', '', false)).toBe('xml');
    expect(detectContentKind('image/png', '', true)).toBe('image');
    expect(detectContentKind('image/svg+xml', '<svg/>', false)).toBe('xml');
    expect(detectContentKind('application/pdf', '', true)).toBe('pdf');
    expect(detectContentKind('application/zip', '', true)).toBe('binary');
  });
  it('sniffs when the content type is missing or generic', () => {
    expect(detectContentKind('', '  {"a":1}', false)).toBe('json');
    expect(detectContentKind('text/plain', '<!DOCTYPE html><html>', false)).toBe('html');
    expect(detectContentKind('', 'hello', false)).toBe('text');
  });
  it('prettyPrint falls back to the original text', () => {
    expect(prettyPrint('json', '{bad')).toBe('{bad');
    expect(prettyPrint('text', 'a\nb')).toBe('a\nb');
    expect(prettyPrint('json', '{"a":1}')).toBe('{\n  "a": 1\n}');
  });
});

describe('suggestedFileName', () => {
  it('derives name and extension', () => {
    expect(suggestedFileName('application/json', 'https://x.test/api/users')).toBe('users.json');
    expect(suggestedFileName('application/pdf', 'https://x.test/files/report.pdf?x=1')).toBe('report.pdf');
    expect(suggestedFileName('', 'not a url')).toBe('response.bin');
  });
});

describe('script helpers', () => {
  it('sets, replaces and removes entries per phase', () => {
    let s = setScript([], 'test', { source: 'pm.test()' });
    s = setScript(s, 'prerequest', { source: 'a' });
    expect(s.map((x) => x.type)).toEqual(['prerequest', 'test']);
    expect(getScript(s, 'test').source).toBe('pm.test()');
    s = setScript(s, 'prerequest', { source: '   ' });
    expect(s.map((x) => x.type)).toEqual(['test']);
    expect(hasScript(s, 'prerequest')).toBe(false);
    expect(getScript(s, 'prerequest')).toMatchObject({ source: '', enabled: true, language: 'javascript' });
  });
  it('keeps the enabled flag when editing the source', () => {
    let s = setScript([], 'test', { source: 'x', enabled: false });
    s = setScript(s, 'test', { source: 'y' });
    expect(s[0]).toMatchObject({ source: 'y', enabled: false });
  });
});

describe('chunk helpers', () => {
  it('splits lines and wraps very long ones', () => {
    expect(splitDisplayLines('a\nb\r\nc\n')).toEqual(['a', 'b', 'c']);
    expect(splitDisplayLines('')).toEqual([]);
    expect(splitDisplayLines('x'.repeat(5), 2)).toEqual(['xx', 'xx', 'x']);
  });
  it('aligns jump offsets to chunk boundaries and stays inside the body', () => {
    expect(offsetForFraction(0, 1000, 100)).toBe(0);
    expect(offsetForFraction(0.55, 1000, 100)).toBe(500);
    expect(offsetForFraction(1, 1000, 100)).toBe(900);
    expect(offsetForFraction(2, 1000, 100)).toBe(900);
  });
});
