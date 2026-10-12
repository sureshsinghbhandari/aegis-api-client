import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { FormDataEntry, KeyValueEntry } from '@aegis/core';
import { BULK_PLACEHOLDER, parseBulk, parseFormBulk, serializeBulk, serializeFormBulk } from '../lib/bulk-edit';
import { KeyValueTable, type KeyValueTableProps } from './ui';

/** Header line with the bulk-edit toggle; `title` is optional (Params has section headings). */
export function BulkEditToggle({ bulk, onChange, title, children }: { bulk: boolean; onChange(v: boolean): void; title?: string; children?: ReactNode }) {
  return (
    <div className="be-head">
      {title && <h3 className="wb-h be-title">{title}</h3>}
      {children}
      <span className="wb-spacer" />
      <button type="button" className="btn btn-ghost btn-sm" aria-pressed={bulk} onClick={() => onChange(!bulk)} title={bulk ? 'Back to the key/value table' : 'Edit as text: one key:value per line, // disables a row'}>
        {bulk ? 'Key-Value Edit' : 'Bulk Edit'}
      </button>
    </div>
  );
}

/**
 * Text-mode editor. The text is local state seeded from `rows`; every keystroke is parsed
 * back into rows (descriptions of unchanged rows are preserved by the parser).
 */
export function BulkTextEditor<T extends { key: string }>({
  rows,
  onChange,
  serialize,
  parse,
  label,
}: {
  rows: readonly T[];
  onChange(rows: T[]): void;
  serialize(rows: readonly T[]): string;
  parse(text: string, previous: readonly T[]): T[];
  label: string;
}) {
  const [text, setText] = useState(() => serialize(rows));
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  // External row changes (e.g. the URL bar editing params) refresh the text unless they came from this editor.
  const lastEmitted = useRef<string | null>(null);
  useEffect(() => {
    const json = JSON.stringify(rows);
    if (lastEmitted.current !== json) {
      lastEmitted.current = json;
      setText(serialize(rows));
    }
  }, [rows, serialize]);
  return (
    <textarea
      className="be-text mono"
      aria-label={label}
      placeholder={BULK_PLACEHOLDER}
      spellCheck={false}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const next = parse(e.target.value, rowsRef.current);
        lastEmitted.current = JSON.stringify(next);
        onChange(next);
      }}
    />
  );
}

/** Key/value table with a "Bulk Edit" toggle. */
export function KeyValueBulkTable({ title, label, ...props }: KeyValueTableProps & { title?: string; label: string }) {
  const [bulk, setBulk] = useState(false);
  return (
    <div className="be-root">
      <BulkEditToggle bulk={bulk} onChange={setBulk} {...(title ? { title } : {})} />
      {bulk ? <BulkTextEditor rows={props.rows} onChange={props.onChange} serialize={serializeBulk} parse={parseBulk} label={`${label} (bulk edit)`} /> : <KeyValueTable {...props} />}
    </div>
  );
}

export const formBulk = { serialize: serializeFormBulk, parse: parseFormBulk } as const;
export type { FormDataEntry, KeyValueEntry };
