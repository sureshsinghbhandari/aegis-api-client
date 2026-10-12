import type { BodyMode, RawLanguage, RequestBody } from '@aegis/core';
import { useState } from 'react';
import { BulkEditToggle, BulkTextEditor, formBulk } from '../components/BulkEditor';
import { Button } from '../components/ui';
import { CodeEditor } from '../components/CodeEditor';
import { KeyValueTable } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { parseBulk, serializeBulk } from '../lib/bulk-edit';
import { formatHtml, formatJson, formatXml } from '../lib/format';
import { useApp, type OpenTab } from '../store/app';
import { FormDataTable, fileLabel } from './FormDataTable';
import { EMPTY_GRAPHQL, GraphQLBody } from './GraphQLBody';
import { useDraftUpdate } from './useDraft';

const MODES: Array<{ id: BodyMode; label: string }> = [
  { id: 'none', label: 'none' },
  { id: 'raw', label: 'raw' },
  { id: 'urlencoded', label: 'x-www-form-urlencoded' },
  { id: 'formdata', label: 'form-data' },
  { id: 'binary', label: 'binary' },
  { id: 'graphql', label: 'GraphQL' },
];

const LANGUAGES: Array<{ id: RawLanguage; label: string; monaco: string }> = [
  { id: 'json', label: 'JSON', monaco: 'json' },
  { id: 'xml', label: 'XML', monaco: 'xml' },
  { id: 'text', label: 'Text', monaco: 'plaintext' },
  { id: 'html', label: 'HTML', monaco: 'html' },
  { id: 'javascript', label: 'JavaScript', monaco: 'javascript' },
];

export function BodyTab({ tab }: { tab: OpenTab }) {
  const update = useDraftUpdate(tab);
  const { body } = tab.draft;
  const set = (patch: Partial<RequestBody>) => update({ body: { ...body, ...patch } });
  const language = body.rawLanguage ?? 'json';
  const [bulkUrlencoded, setBulkUrlencoded] = useState(false);
  const [bulkForm, setBulkForm] = useState(false);

  const beautify = () => {
    const raw = body.raw ?? '';
    const next = language === 'json' ? formatJson(raw) : language === 'xml' ? formatXml(raw) : language === 'html' ? formatHtml(raw) : null;
    if (next === null) useApp.getState().toast(language === 'json' ? 'The body is not valid JSON, so it cannot be beautified.' : 'Nothing to beautify for this language.', 'info');
    else set({ raw: next });
  };

  const pickBinary = async () => {
    try {
      const file = await api.tools.pickFile({ purpose: 'upload' });
      if (file) set({ filePath: file.path });
    } catch (e) {
      useApp.getState().toast(errorMessage(e), 'error');
    }
  };

  const switchMode = (mode: BodyMode) => {
    const patch: Partial<RequestBody> = { mode };
    if (mode === 'raw' && !body.rawLanguage) patch.rawLanguage = 'json';
    if (mode === 'graphql' && !body.graphql) patch.graphql = EMPTY_GRAPHQL;
    set(patch);
  };

  return (
    <div className="wb-body">
      <div className="wb-modes" role="radiogroup" aria-label="Body type">
        {MODES.map((m) => (
          <label key={m.id} className={`wb-mode ${body.mode === m.id ? 'active' : ''}`}>
            <input type="radio" name={`body-mode-${tab.tabId}`} checked={body.mode === m.id} onChange={() => switchMode(m.id)} />
            {m.label}
          </label>
        ))}
        {body.mode === 'raw' && (
          <>
            <span className="wb-spacer" />
            <select aria-label="Raw body language" value={language} onChange={(e) => set({ rawLanguage: e.target.value as RawLanguage })}>
              {LANGUAGES.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
            </select>
            <Button size="sm" onClick={beautify} disabled={language === 'text' || language === 'javascript'} title="Re-indent the body">
              Beautify
            </Button>
          </>
        )}
      </div>

      {body.mode === 'none' && <div className="empty">This request has no body.</div>}

      {body.mode === 'raw' && (
        <div className="wb-editor-host">
          <CodeEditor value={body.raw ?? ''} language={LANGUAGES.find((l) => l.id === language)?.monaco ?? 'plaintext'} variableHints onChange={(raw) => set({ raw })} />
        </div>
      )}

      {body.mode === 'graphql' && <GraphQLBody value={body.graphql ?? EMPTY_GRAPHQL} onChange={(graphql) => set({ graphql })} />}

      {body.mode === 'urlencoded' && (
        <div className="wb-pane-scroll">
          <BulkEditToggle bulk={bulkUrlencoded} onChange={setBulkUrlencoded} />
          {bulkUrlencoded ? (
            <BulkTextEditor rows={body.urlencoded ?? []} onChange={(urlencoded) => set({ urlencoded })} serialize={serializeBulk} parse={parseBulk} label="Form fields (bulk edit)" />
          ) : (
            <KeyValueTable rows={body.urlencoded ?? []} onChange={(urlencoded) => set({ urlencoded })} variableHints />
          )}
        </div>
      )}

      {body.mode === 'formdata' && (
        <div className="wb-pane-scroll">
          <BulkEditToggle bulk={bulkForm} onChange={setBulkForm} />
          {bulkForm ? (
            <>
              <BulkTextEditor rows={body.formData ?? []} onChange={(formData) => set({ formData })} serialize={formBulk.serialize} parse={formBulk.parse} label="Form data (bulk edit)" />
              <p className="wb-hint">File rows keep their file as long as the line is unchanged; files cannot be chosen in text mode.</p>
            </>
          ) : (
            <FormDataTable rows={body.formData ?? []} onChange={(formData) => set({ formData })} />
          )}
        </div>
      )}

      {body.mode === 'binary' && (
        <div className="wb-pane-scroll">
          <div className="wb-binary">
            <Button onClick={() => void pickBinary()}>{body.filePath ? 'Change file…' : 'Select file…'}</Button>
            <span title={body.filePath}>{fileLabel(body.filePath)}</span>
            {body.filePath && (
              <Button size="sm" variant="ghost" onClick={() => set({ filePath: '' })}>
                Remove
              </Button>
            )}
          </div>
          <p className="wb-hint">The file is streamed from disk when the request is sent.</p>
        </div>
      )}

      {body.mode !== 'none' && (
        <div className="wb-ct">
          <label>
            <span className="wb-dim">Content-Type override</span>
            <input
              value={body.contentType ?? ''}
              placeholder={body.mode === 'graphql' ? 'application/json' : 'automatic'}
              spellCheck={false}
              aria-label="Content-Type override"
              onChange={(e) => {
                const { contentType: _drop, ...rest } = body;
                update({ body: e.target.value ? { ...rest, contentType: e.target.value } : rest });
              }}
            />
          </label>
        </div>
      )}
    </div>
  );
}
