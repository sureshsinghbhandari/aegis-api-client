import type { ResponseView } from '@aegis/core';
import { buildPreviewDocument } from '@aegis/core';
import { useMemo, useState } from 'react';
import { CodeEditor } from '../components/CodeEditor';
import { Button, ErrorBanner, formatBytes, Spinner } from '../components/ui';
import { monacoLanguage, prettyPrint } from '../lib/format';
import { applyJsonPathToText, formatJsonPathResults } from '../lib/jsonpath';
import { LargeBodyViewer } from './LargeBodyViewer';
import { copyText, type ResponseBody } from './useResponseBody';

function BodyToolbar({ children, text, label }: { children?: React.ReactNode; text: string | null; label: string }) {
  return (
    <div className="rv-toolbar">
      {children}
      <span className="wb-spacer" />
      <Button size="sm" disabled={text === null} onClick={() => text !== null && void copyText(text, `${label} copied`)}>
        Copy
      </Button>
    </div>
  );
}

function BinaryNotice({ response, onSave }: { response: ResponseView; onSave(): void }) {
  return (
    <div className="empty">
      <div className="empty-title">Binary content</div>
      <div className="empty-body">
        {response.contentType || 'Unknown type'} · {formatBytes(response.size)}. Save the response to a file to open it.
      </div>
      <div className="empty-action">
        <Button variant="primary" onClick={onSave}>
          Save to file
        </Button>
      </div>
    </div>
  );
}

function Loading({ body }: { body: ResponseBody }) {
  if (body.error) return <ErrorBanner message={`Could not load the response body: ${body.error}`} />;
  return (
    <div className="center-fill">
      <Spinner label="Loading response body" />
    </div>
  );
}

/** JSONPath filter box shown above JSON bodies (`$.items[*].id`). */
function JsonPathFilter({ value, onChange, error, count }: { value: string; onChange(v: string): void; error: string | null; count: number | null }) {
  return (
    <div className="rv-filter">
      <input
        type="search"
        className="mono"
        aria-label="Filter JSON with JSONPath"
        placeholder="Filter with JSONPath, e.g. $.data[*].id or $..name or $.items[?(@.price > 10)]"
        value={value}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error !== null}
      />
      {error ? (
        <span className="rv-filter-error" role="alert">
          {error}
        </span>
      ) : count !== null ? (
        <span className="wb-dim">
          {count} result{count === 1 ? '' : 's'}
        </span>
      ) : null}
    </div>
  );
}

export function PrettyView({ response, body, onSave }: { response: ResponseView; body: ResponseBody; onSave(): void }) {
  const [wrap, setWrap] = useState(true);
  const [filter, setFilter] = useState('');
  const pretty = useMemo(() => (body.text === null ? null : prettyPrint(body.kind, body.text)), [body.kind, body.text]);
  const filtered = useMemo(() => {
    if (body.kind !== 'json' || body.text === null || filter.trim() === '') return null;
    const outcome = applyJsonPathToText(body.text, filter);
    return outcome.ok ? { text: formatJsonPathResults(outcome), count: outcome.results.length, error: null } : { text: null, count: null, error: outcome.error };
  }, [body.kind, body.text, filter]);

  if (body.large) return <LargeBodyViewer responseId={response.responseId} size={response.size} onSave={onSave} />;
  if (body.kind === 'image' || body.kind === 'pdf' || body.kind === 'binary') return <BinaryNotice response={response} onSave={onSave} />;
  if (pretty === null) return <Loading body={body} />;
  if (pretty === '') return <div className="empty">The response body is empty.</div>;
  const shown = filtered?.text ?? pretty;
  return (
    <div className="rv-body">
      <BodyToolbar text={shown} label="Body">
        <span className="wb-dim">{body.kind.toUpperCase()}</span>
        <label className="checkbox">
          <input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} />
          <span>Wrap lines</span>
        </label>
        <span className="wb-dim">Ctrl+F to search, click the gutter arrows to fold</span>
      </BodyToolbar>
      {body.kind === 'json' && <JsonPathFilter value={filter} onChange={setFilter} error={filtered?.error ?? null} count={filtered?.count ?? null} />}
      <div className="rv-editor">
        <CodeEditor value={shown} language={monacoLanguage(body.kind)} readOnly wordWrap={wrap} />
      </div>
    </div>
  );
}

export function RawView({ response, body, onSave }: { response: ResponseView; body: ResponseBody; onSave(): void }) {
  const [wrap, setWrap] = useState(true);
  if (body.large) return <LargeBodyViewer responseId={response.responseId} size={response.size} onSave={onSave} />;
  if (body.kind === 'image' || body.kind === 'pdf' || body.kind === 'binary') return <BinaryNotice response={response} onSave={onSave} />;
  if (body.text === null) return <Loading body={body} />;
  if (body.text === '') return <div className="empty">The response body is empty.</div>;
  return (
    <div className="rv-body">
      <BodyToolbar text={body.text} label="Body">
        <label className="checkbox">
          <input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} />
          <span>Wrap lines</span>
        </label>
      </BodyToolbar>
      <div className="rv-editor">
        <CodeEditor value={body.text} language="plaintext" readOnly wordWrap={wrap} lineNumbers />
      </div>
    </div>
  );
}

export function PreviewView({ response, body, onSave }: { response: ResponseView; body: ResponseBody; onSave(): void }) {
  const isImage = response.contentType.toLowerCase().startsWith('image/');
  const srcDoc = useMemo(() => (body.kind === 'html' && body.text !== null ? buildPreviewDocument(body.text) : null), [body.kind, body.text]);

  if (isImage) {
    const type = response.contentType.split(';')[0]!.trim();
    if (response.imagePreviewBase64) {
      return (
        <div className="rv-image">
          <img alt="Response preview" src={`data:${type};base64,${response.imagePreviewBase64}`} />
        </div>
      );
    }
    return <BinaryNotice response={response} onSave={onSave} />;
  }
  if (body.kind === 'html') {
    if (body.large) {
      return (
        <div className="empty">
          <div className="empty-title">Too large to preview</div>
          <div className="empty-body">This HTML response is {formatBytes(response.size)}. Use the Raw tab or save it to a file.</div>
        </div>
      );
    }
    if (srcDoc === null) return <Loading body={body} />;
    return (
      <div className="rv-body">
        <div className="rv-toolbar">
          <span className="wb-dim">Sandboxed preview: scripts, forms, plugins and network requests are disabled.</span>
        </div>
        {/* sandbox="" (no flags): no scripts, no same-origin access, no forms, no popups. */}
        <iframe className="rv-iframe" title="Response preview" sandbox="" srcDoc={srcDoc} referrerPolicy="no-referrer" />
      </div>
    );
  }
  if (body.kind === 'pdf' || body.kind === 'binary') return <BinaryNotice response={response} onSave={onSave} />;
  return (
    <div className="empty">
      <div className="empty-title">No visual preview for this content type</div>
      <div className="empty-body">Use the Pretty or Raw tab to inspect the body.</div>
    </div>
  );
}
