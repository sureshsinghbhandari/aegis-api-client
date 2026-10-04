import type { FormDataEntry } from '@aegis/core';
import { api, errorMessage } from '../lib/api';
import { useApp } from '../store/app';
import { formatBytes } from '../components/ui';

const EMPTY: FormDataEntry = { key: '', type: 'text', value: '', enabled: true };

/** multipart/form-data rows: text, file (picked via the main process) or variable (value = variable NAME). */
export function FormDataTable({ rows, onChange }: { rows: FormDataEntry[]; onChange(rows: FormDataEntry[]): void }) {
  const display = [...rows, EMPTY];
  const patch = (i: number, p: Partial<FormDataEntry>) => {
    const next = display.map((r, idx) => (idx === i ? { ...r, ...p } : r));
    onChange(next.filter((r, idx) => idx < rows.length || r.key !== '' || r.value !== ''));
  };

  const pick = async (i: number) => {
    try {
      const file = await api.tools.pickFile({ purpose: 'upload' });
      if (file) patch(i, { type: 'file', filePath: file.path, value: file.name, contentType: display[i]?.contentType ?? '' });
    } catch (e) {
      useApp.getState().toast(errorMessage(e), 'error');
    }
  };

  return (
    <div className="kv">
      <div className="kv-row kv-head fd-row">
        <span />
        <span>Key</span>
        <span>Type</span>
        <span>Value</span>
        <span />
      </div>
      {display.map((r, i) => {
        const ghost = i === rows.length;
        return (
          <div key={i} className={`kv-row fd-row ${r.enabled ? '' : 'disabled'}`}>
            <input type="checkbox" aria-label="Enabled" checked={r.enabled} disabled={ghost} onChange={(e) => patch(i, { enabled: e.target.checked })} />
            <input value={r.key} placeholder="Key" spellCheck={false} onChange={(e) => patch(i, { key: e.target.value })} />
            <select aria-label="Field type" value={r.type} onChange={(e) => patch(i, { type: e.target.value as FormDataEntry['type'], ...(e.target.value !== 'file' ? { filePath: '' } : {}) })}>
              <option value="text">Text</option>
              <option value="file">File</option>
              <option value="variable">Variable</option>
            </select>
            {r.type === 'file' ? (
              <div className="fd-file">
                <button type="button" className="btn btn-sm" onClick={() => void pick(i)}>
                  {r.filePath ? 'Change file…' : 'Choose file…'}
                </button>
                <span className="fd-file-name" title={r.filePath}>
                  {r.filePath ? r.value : 'No file selected'}
                </span>
              </div>
            ) : (
              <input value={r.value} placeholder={r.type === 'variable' ? 'Variable name' : 'Value'} spellCheck={false} onChange={(e) => patch(i, { value: e.target.value })} />
            )}
            <button type="button" className="icon-btn" aria-label="Remove row" disabled={ghost} onClick={() => onChange(rows.filter((_, idx) => idx !== i))}>
              ✕
            </button>
          </div>
        );
      })}
      <p className="wb-hint">File parts are read from disk when the request is sent. {rows.some((r) => r.type === 'file') ? 'Files outside the allowed locations are rejected by the security policy.' : ''}</p>
    </div>
  );
}

export function fileLabel(path: string | undefined, size?: number): string {
  if (!path) return 'No file selected';
  const name = path.split(/[\\/]/).pop() ?? path;
  return size !== undefined ? `${name} (${formatBytes(size)})` : name;
}
