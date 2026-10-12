import { describe, expect, it } from 'vitest';
import { buildMarkdownDocument, renderInline, renderMarkdown, safeImageUrl, safeLinkUrl } from '../../apps/desktop/renderer/src/lib/markdown';

describe('markdown subset rendering', () => {
  it('renders headings, paragraphs, emphasis and code', () => {
    const html = renderMarkdown('# Title\n\nSome **bold**, *em*, ~~gone~~ and `code` text.\n\n## Sub');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<h2>Sub</h2>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>em</em>');
    expect(html).toContain('<del>gone</del>');
    expect(html).toContain('<code>code</code>');
  });
  it('renders lists (nested, ordered, tasks), quotes, rules and fenced code', () => {
    const html = renderMarkdown(['- one', '- two', '  - nested', '', '1. first', '2. second', '', '- [x] done', '- [ ] todo', '', '> quoted', '', '---', '', '```js', 'const x = "<b>";', '```'].join('\n'));
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>two\n<ul>\n<li>nested</li>\n</ul></li>');
    expect(html).toContain('<ol>');
    expect(html).toContain('<li>second</li>');
    expect(html).toContain('<input type="checkbox" disabled checked>');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('<hr>');
    expect(html).toContain('<pre><code class="language-js">const x = &quot;&lt;b&gt;&quot;;\n</code></pre>');
  });
  it('renders tables with alignment', () => {
    const html = renderMarkdown('| a | b |\n|:--|--:|\n| 1 | 2 |');
    expect(html).toContain('<th style="text-align:left">a</th>');
    expect(html).toContain('<td style="text-align:right">2</td>');
  });
  it('renders links with safe schemes only and autolinks', () => {
    expect(renderInline('[x](https://example.test/a?b=1 "T")')).toBe('<a href="https://example.test/a?b=1" title="T" rel="noreferrer">x</a>');
    expect(renderInline('<https://example.test>')).toContain('<a href="https://example.test"');
    expect(renderInline('[mail](mailto:a@b.test)')).toContain('href="mailto:a@b.test"');
    expect(renderInline('[js](javascript:alert(1))')).toBe('<span class="md-nolink" title="javascript:alert(1)">js</span>');
    expect(renderInline('[data](data:text/html;base64,PHNjcmlwdD4=)')).not.toContain('href');
    expect(renderInline('[rel](./other.md)')).not.toContain('href');
  });
  it('allows inline data images only; remote images become text', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    expect(renderInline(`![alt](${png})`)).toBe(`<img alt="alt" src="${png}">`);
    expect(renderInline('![alt](https://evil.test/track.png)')).toBe('<span class="md-noimg">[image: alt]</span>');
    expect(safeImageUrl('data:image/svg+xml;base64,PHN2Zz4=')).not.toBeNull();
    expect(safeImageUrl('data:text/html;base64,AAAA')).toBeNull();
    expect(safeLinkUrl('HTTPS://x.test')).toBe('HTTPS://x.test');
    expect(safeLinkUrl('vbscript:x')).toBeNull();
  });
  it('escapes raw HTML instead of rendering it', () => {
    expect(renderMarkdown('<b>bold</b> & <i>x</i>')).toBe('<p>&lt;b&gt;bold&lt;/b&gt; &amp; &lt;i&gt;x&lt;/i&gt;</p>\n');
  });
  it('handles hard breaks, escapes and CRLF input', () => {
    expect(renderMarkdown('a  \r\nb')).toBe('<p>a  <br>\nb</p>\n');
    expect(renderInline('\\*not em\\*')).toBe('*not em*');
    expect(renderInline('a_b_c')).toBe('a_b_c');
  });
  it('is tolerant of unbalanced markup and huge input', () => {
    expect(() => renderMarkdown('**unclosed *and `tick [link](')).not.toThrow();
    expect(() => renderMarkdown('x'.repeat(300_000))).not.toThrow();
    expect(renderMarkdown('')).toBe('');
  });
});

describe('markdown XSS corpus', () => {
  const payloads = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '[x](javascript:alert(1))',
    '[x](JaVaScRiPt:alert(1))',
    '[x](  javascript:alert(1))',
    '[x](java\u0000script:alert(1))',
    '![x](javascript:alert(1))',
    '![x](https://evil.test/a.png)',
    '<a href="javascript:alert(1)">x</a>',
    '<iframe src="https://evil.test"></iframe>',
    '<svg onload=alert(1)>',
    '<body onload="steal()">',
    '<object data="x"></object><embed src="x">',
    '<base href="https://evil.test/"><link rel="stylesheet" href="https://evil.test/x.css">',
    '[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
    '`<script>alert(1)</script>`',
    '```\n<script>alert(1)</script>\n```',
    '| <script>x</script> | b |\n|---|---|\n| <img src=x onerror=1> | 2 |',
    '> <style>@import "https://evil.test/x.css"</style>',
    '**<iframe srcdoc="x">**',
    '[x](https://ok.test" onclick="alert(1))',
    '![x](data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+)',
  ];
  for (const p of payloads) {
    it(`neutralises ${JSON.stringify(p.slice(0, 40))}`, () => {
      const html = renderMarkdown(`before\n\n${p}\n\nafter`);
      // no element or attribute survives: every `<` of the payload must be escaped, every attribute quoted by us is ours
      expect(html).not.toMatch(/<script|<iframe|<object|<embed|<base|<link|<style|<svg|<body/i);
      expect(html).not.toMatch(/\son[a-z]+\s*=\s*"/i);
      expect(html).not.toMatch(/href="[^"]*javascript:/i);
      expect(html).not.toMatch(/src="(?!data:image\/)/i);
      expect(html).not.toMatch(/(href|src)="[^"]*evil\.test/);
      expect(html).not.toMatch(/url\(/);
      // the payload's own tags are text now
      if (p.includes('<')) expect(html).toContain('&lt;');
      const doc = buildMarkdownDocument(p, 'dark');
      expect(doc).toContain("default-src 'none'");
      expect(doc).toContain('img-src data:');
      expect(doc).not.toMatch(/<script|onerror|onload|<iframe/i);
    });
  }
  it('an svg data image cannot carry a script into the page (it is only ever an <img> source)', () => {
    const html = renderMarkdown('![x](data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+)');
    expect(html).toMatch(/^<p><img alt="x" src="data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+"><\/p>\n$/);
  });
});
