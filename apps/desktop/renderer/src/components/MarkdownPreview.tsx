import { useMemo } from 'react';
import { buildMarkdownDocument } from '../lib/markdown';
import { useApp } from '../store/app';
import '../styles/tools.css';

/**
 * Read-only Markdown preview of a description. The HTML is produced by the in-app safe-subset
 * renderer (everything escaped, http(s)/mailto links only, inline data images only) and shown
 * in an `<iframe sandbox="">` with a restrictive CSP: no scripts, no remote resources.
 */
export function MarkdownPreview({ markdown, title = 'Description preview' }: { markdown: string; title?: string }) {
  const theme = useApp((s) => s.theme);
  const srcDoc = useMemo(() => buildMarkdownDocument(markdown, theme), [markdown, theme]);
  if (markdown.trim() === '') return <div className="md-empty wb-dim">Nothing to preview yet. Markdown is supported: headings, lists, links, code blocks, tables.</div>;
  return <iframe className="md-frame" title={title} sandbox="" srcDoc={srcDoc} referrerPolicy="no-referrer" />;
}

/** Textarea + live preview side by side. */
export function MarkdownEditor({ value, onChange, placeholder, label }: { value: string; onChange(v: string): void; placeholder?: string; label: string }) {
  return (
    <div className="md-editor">
      <textarea aria-label={label} placeholder={placeholder} value={value} spellCheck onChange={(e) => onChange(e.target.value)} />
      <div className="md-preview" aria-label={`${label} preview`}>
        <MarkdownPreview markdown={value} title={`${label} preview`} />
      </div>
    </div>
  );
}
