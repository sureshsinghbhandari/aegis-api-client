import { useState } from 'react';
import { KeyValueBulkTable } from '../components/BulkEditor';
import { KeyValueTable } from '../components/ui';
import type { OpenTab } from '../store/app';
import { useDraftUpdate } from './useDraft';

export const COMMON_HEADERS = [
  'Accept',
  'Accept-Charset',
  'Accept-Encoding',
  'Accept-Language',
  'Authorization',
  'Cache-Control',
  'Connection',
  'Content-Type',
  'Content-Length',
  'Cookie',
  'DNT',
  'Host',
  'If-Match',
  'If-Modified-Since',
  'If-None-Match',
  'Origin',
  'Pragma',
  'Range',
  'Referer',
  'User-Agent',
  'X-Api-Key',
  'X-Correlation-Id',
  'X-Forwarded-For',
  'X-Request-Id',
  'X-Requested-With',
];

export function ParamsTab({ tab }: { tab: OpenTab }) {
  const update = useDraftUpdate(tab);
  const { draft } = tab;
  return (
    <div className="wb-pane-scroll">
      <KeyValueBulkTable title="Query Params" label="Query params" rows={draft.queryParams} onChange={(queryParams) => update({ queryParams })} keyPlaceholder="Parameter" variableHints />
      <h3 className="wb-h">Path Variables</h3>
      {draft.pathVariables.length === 0 ? (
        <p className="wb-hint">Add <code>:name</code> segments to the URL path (for example <code>/users/:id</code>) to define path variables here.</p>
      ) : (
        <KeyValueTable rows={draft.pathVariables} onChange={(pathVariables) => update({ pathVariables })} keyPlaceholder="Variable" readOnlyKeys variableHints />
      )}
    </div>
  );
}

export function HeadersTab({ tab }: { tab: OpenTab }) {
  const update = useDraftUpdate(tab);
  const [hintOpen, setHintOpen] = useState(false);
  return (
    <div className="wb-pane-scroll">
      <KeyValueBulkTable label="Headers" rows={tab.draft.headers} onChange={(headers) => update({ headers })} keyPlaceholder="Header" keySuggestions={COMMON_HEADERS} variableHints />
      <div className="wb-autohdr">
        <button type="button" className="btn btn-ghost btn-sm" aria-expanded={hintOpen} onClick={() => setHintOpen((v) => !v)}>
          {hintOpen ? '▾' : '▸'} Automatically added headers
        </button>
        {hintOpen && (
          <p className="wb-hint">
            Depending on the request, headers such as <code>Host</code>, <code>Content-Length</code>, a <code>Content-Type</code> derived from the Body, an <code>Authorization</code> header or query parameter from the Authorization tab, and <code>Cookie</code> values from the cookie jar are added when the request is sent. The
            final headers of the last send are listed in the response Timeline tab.
          </p>
        )}
      </div>
    </div>
  );
}
