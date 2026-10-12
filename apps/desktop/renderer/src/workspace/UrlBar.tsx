import { composeDisplayUrl, HTTP_METHODS } from '@aegis/core';
import { useRef, useState } from 'react';
import { Button, METHOD_COLORS } from '../components/ui';
import { VariableInput } from '../components/VariableInput';
import { looksLikeCurlPaste, pastedText } from '../lib/curl-paste';
import { applyUrlEdit } from '../lib/urlSync';
import { useVariableIndexLoader } from '../lib/variable-index';
import { isDirty, useApp, type OpenTab } from '../store/app';
import { useUi } from '../store/ui';
import { useDraftUpdate } from './useDraft';

const CUSTOM = '__custom__';

function MethodPicker({ method, onChange }: { method: string; onChange(m: string): void }) {
  const [custom, setCustom] = useState(false);
  const [text, setText] = useState('');
  const known = (HTTP_METHODS as readonly string[]).includes(method);
  const color = METHOD_COLORS[method.toUpperCase()] ?? 'var(--text)';

  if (custom) {
    const commit = () => {
      const m = text.trim().toUpperCase();
      if (m && /^[A-Z][A-Z0-9_-]*$/.test(m)) onChange(m);
      setCustom(false);
    };
    return (
      <input
        className="wb-method wb-method-input"
        aria-label="Custom HTTP method"
        autoFocus
        value={text}
        placeholder="METHOD"
        spellCheck={false}
        onChange={(e) => setText(e.target.value.toUpperCase())}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') setCustom(false);
        }}
      />
    );
  }
  return (
    <select
      className="wb-method"
      aria-label="HTTP method"
      style={{ color }}
      value={method}
      onChange={(e) => {
        if (e.target.value === CUSTOM) {
          setText('');
          setCustom(true);
        } else onChange(e.target.value);
      }}
    >
      {HTTP_METHODS.map((m) => (
        <option key={m} value={m}>
          {m}
        </option>
      ))}
      {!known && <option value={method}>{method}</option>}
      <option value={CUSTOM}>Custom…</option>
    </select>
  );
}

export function UrlBar({ tab }: { tab: OpenTab }) {
  const update = useDraftUpdate(tab);
  const sendTab = useApp((s) => s.sendTab);
  const cancelTab = useApp((s) => s.cancelTab);
  const saveTab = useApp((s) => s.saveTab);
  const { draft } = tab;
  const sending = tab.response.status === 'sending';
  const dirty = isDirty(tab);
  const composed = composeDisplayUrl(draft.url, draft.queryParams);
  // While typing, show exactly what was typed (parsing/recomposing could eat characters such as a trailing "=").
  const [editing, setEditing] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const unresolved = tab.response.result?.unresolvedVariables ?? [];
  // The URL bar is rendered once per active tab, so it keeps the shared variable index (URL, cells, body, auth) current.
  useVariableIndexLoader(tab);

  return (
    <div className="wb-urlbar-wrap">
      <div className="wb-urlbar">
        <MethodPicker method={draft.method} onChange={(method) => update({ method })} />
        <VariableInput
          inputRef={input}
          className="wb-url"
          aria-label="Request URL"
          placeholder="Enter URL or paste text — use {{variables}} and :pathVariables"
          value={editing ?? composed}
          onChange={(v) => {
            setEditing(v);
            update(applyUrlEdit(v, draft));
          }}
          onBlur={() => setEditing(null)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !sending) {
              e.preventDefault();
              void sendTab(tab.tabId);
            }
          }}
          onPaste={(e) => {
            // A pasted curl command is offered as an import instead of landing in the URL field.
            const text = pastedText(e.clipboardData);
            if (looksLikeCurlPaste(text)) {
              e.preventDefault();
              useUi.getState().openModal('curl-import', { text, tabId: tab.tabId });
            }
          }}
        />
        {sending ? (
          <Button variant="danger" className="wb-send" onClick={() => void cancelTab(tab.tabId)}>
            Cancel
          </Button>
        ) : (
          <Button variant="primary" className="wb-send" onClick={() => void sendTab(tab.tabId)} title="Send (Ctrl+Enter)">
            Send
          </Button>
        )}
        <Button onClick={() => void saveTab(tab.tabId)} disabled={!dirty && tab.requestId !== null} title="Save (Ctrl+S)">
          Save
        </Button>
        <Button onClick={() => useUi.getState().openModal('code', { tabId: tab.tabId })} title="Generate a code snippet for this request">
          Code
        </Button>
      </div>
      {unresolved.length > 0 && (
        <div className="wb-unresolved" role="status">
          <span>Unresolved variables in the last send:</span>
          {unresolved.map((v) => (
            <code key={v} className="wb-var-badge" title="Define it in the active environment, collection or globals">
              {`{{${v}}}`}
            </code>
          ))}
        </div>
      )}
    </div>
  );
}
