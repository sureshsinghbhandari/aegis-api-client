import { parseCurl, type CurlParseResult } from '@aegis/codegen';
import { composeDisplayUrl } from '@aegis/core';
import { useMemo, useState } from 'react';
import { Badge, Button, Modal } from '../components/ui';
import { useApp } from '../store/app';
import { useUi } from '../store/ui';
import type { ModalComponentProps } from './ModalHost';
import '../styles/workbench.css';

/**
 * Props: `{ text?: string; tabId?: string }`. `text` pre-fills the textarea (URL bar paste);
 * `tabId` enables "Replace in this tab" next to "Create request".
 */
export default function CurlImportModal({ props }: ModalComponentProps) {
  const initial = typeof props?.text === 'string' ? props.text : '';
  const tabId = typeof props?.tabId === 'string' ? props.tabId : null;
  const [text, setText] = useState(initial);
  const close = () => useUi.getState().closeModal();
  const parsed: CurlParseResult | null = useMemo(() => (text.trim() ? parseCurl(text) : null), [text]);
  const tab = useApp((s) => (tabId ? s.tabs.find((t) => t.tabId === tabId) : undefined));

  const create = () => {
    if (!parsed?.ok) return;
    const { draft } = parsed;
    useApp.getState().newRequest(tab?.collectionId ?? null, tab?.folderId ?? null, draft);
    useApp.getState().toast(`Imported ${draft.method} request from cURL`, 'success');
    close();
  };
  const replace = () => {
    if (!parsed?.ok || !tab) return;
    const { draft } = parsed;
    // Keep the tab's identity (name/description/scripts/examples) and replace what the command describes.
    const { name: _n, description: _d, scripts: _s, examples: _e, metadata: _m, ...rest } = draft;
    useApp.getState().updateDraft(tab.tabId, rest);
    useApp.getState().toast('Request replaced from cURL', 'success');
    close();
  };

  return (
    <Modal
      title="Import cURL"
      width={720}
      onClose={close}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          {tab && (
            <Button onClick={replace} disabled={!parsed?.ok} title="Replace method, URL, params, headers, auth and body of the current tab">
              Replace in this tab
            </Button>
          )}
          <Button variant="primary" onClick={create} disabled={!parsed?.ok}>
            Create request
          </Button>
        </>
      }
    >
      <div className="ci-body">
        <label className="field">
          <span className="field-label">cURL command</span>
          <textarea
            className="ci-input mono"
            aria-label="cURL command"
            autoFocus
            spellCheck={false}
            placeholder="curl -X POST https://api.example.com/users -H 'Content-Type: application/json' -d '{&quot;name&quot;:&quot;Ada&quot;}'"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <span className="field-hint">File references (@file, -F name=@file, cookie files) are never imported; -k never disables TLS verification.</span>
        </label>
        {parsed && <Preview parsed={parsed} />}
      </div>
    </Modal>
  );
}

function Preview({ parsed }: { parsed: CurlParseResult }) {
  const { draft, warnings, ok } = parsed;
  const headers = draft.headers.filter((h) => h.enabled);
  const bodySummary = (() => {
    switch (draft.body.mode) {
      case 'raw':
        return `raw (${draft.body.rawLanguage ?? 'text'}), ${(draft.body.raw ?? '').length} characters`;
      case 'urlencoded':
        return `x-www-form-urlencoded, ${draft.body.urlencoded?.length ?? 0} fields`;
      case 'formdata':
        return `form-data, ${draft.body.formData?.length ?? 0} fields`;
      default:
        return 'none';
    }
  })();
  const authSummary = draft.auth.type === 'basic' ? `Basic (${String(draft.auth.params.username ?? '')})` : draft.auth.type === 'bearer' ? 'Bearer token' : 'inherit';
  return (
    <div className="ci-preview" aria-live="polite">
      {ok ? (
        <dl className="ci-grid">
          <dt>Request</dt>
          <dd className="mono ci-url">
            <strong>{draft.method}</strong> {composeDisplayUrl(draft.url, draft.queryParams) || '(no URL)'}
          </dd>
          <dt>Query</dt>
          <dd>{draft.queryParams.length ? draft.queryParams.map((q) => q.key).join(', ') : 'none'}</dd>
          <dt>Headers</dt>
          <dd>{headers.length ? headers.map((h) => h.key).join(', ') : 'none'}</dd>
          <dt>Auth</dt>
          <dd>{authSummary}</dd>
          <dt>Body</dt>
          <dd>{bodySummary}</dd>
          {Object.keys(draft.settings).length > 0 && (
            <>
              <dt>Settings</dt>
              <dd>
                {Object.entries(draft.settings)
                  .map(([k, v]) => `${k}=${String(v)}`)
                  .join(', ')}
              </dd>
            </>
          )}
        </dl>
      ) : (
        <p className="field-err">The text could not be imported as a request.</p>
      )}
      {warnings.length > 0 && (
        <div className="ci-warnings">
          <Badge tone="warning">{warnings.length === 1 ? '1 warning' : `${warnings.length} warnings`}</Badge>
          <ul>
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
