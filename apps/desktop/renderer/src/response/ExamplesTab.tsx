import type { KeyValueEntry, RequestExample } from '@aegis/core';
import { useEffect, useMemo, useState } from 'react';
import { CodeEditor } from '../components/CodeEditor';
import { Badge, Button, EmptyState, KeyValueTable, statusTone } from '../components/ui';
import type { OpenTab } from '../store/app';
import { useUi } from '../store/ui';
import { useDraftUpdate } from '../workspace/useDraft';
import '../styles/tools.css';

const LANGUAGES = ['json', 'xml', 'html', 'text', 'javascript'] as const;

/** Stable key for examples (imported ones carry ids; unsaved ones are addressed by index). */
const keyOf = (e: RequestExample, i: number): string => e.id ?? `idx-${i}`;

export function exampleSummary(e: RequestExample): string {
  return `${e.code} ${e.status}`.trim();
}

/** List / view / edit / delete the saved examples of a request. Edits are part of the draft (save the request to persist). */
export function ExamplesTab({ tab }: { tab: OpenTab }) {
  const update = useDraftUpdate(tab);
  const examples = tab.draft.examples;
  const [selected, setSelected] = useState<string | null>(null);
  const index = useMemo(() => examples.findIndex((e, i) => keyOf(e, i) === selected), [examples, selected]);
  const current = index >= 0 ? examples[index] : undefined;

  useEffect(() => {
    if (!current && examples.length > 0) setSelected(keyOf(examples[0]!, 0));
  }, [current, examples]);

  const patch = (p: Partial<RequestExample>) => {
    if (index < 0) return;
    update({ examples: examples.map((e, i) => (i === index ? { ...e, ...p } : e)) });
  };

  const remove = async () => {
    if (!current) return;
    const ok = await useUi.getState().confirm({ title: 'Delete example', message: `Delete example "${current.name}"?`, confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    update({ examples: examples.filter((_, i) => i !== index) });
    setSelected(null);
  };

  const add = () => {
    const example: RequestExample = { name: `Example ${examples.length + 1}`, status: 'OK', code: 200, headers: [], body: '', language: 'json' };
    update({ examples: [...examples, example] });
    setSelected(keyOf(example, examples.length));
  };

  if (examples.length === 0) {
    return (
      <EmptyState
        title="No examples yet"
        action={
          <Button variant="primary" onClick={add}>
            Add example
          </Button>
        }
      >
        Send the request and click “Save as example” on the response, or add one by hand. Examples are exported with the collection.
      </EmptyState>
    );
  }

  return (
    <div className="ex-root">
      <aside className="ex-list" aria-label="Examples">
        {examples.map((e, i) => {
          const k = keyOf(e, i);
          return (
            <button key={k} type="button" className={`ex-item ${k === selected ? 'active' : ''}`} onClick={() => setSelected(k)} title={e.name}>
              <Badge tone={statusTone(e.code)}>{e.code}</Badge>
              <span className="ex-item-name">{e.name || 'Untitled'}</span>
            </button>
          );
        })}
        <Button size="sm" className="ex-add" onClick={add}>
          + Add example
        </Button>
      </aside>
      {current ? (
        <div className="ex-detail">
          <div className="ex-row">
            <label className="field ex-grow">
              <span className="field-label">Name</span>
              <input value={current.name} onChange={(e) => patch({ name: e.target.value })} aria-label="Example name" />
            </label>
            <label className="field ex-code">
              <span className="field-label">Status code</span>
              <input type="number" min={100} max={599} value={current.code} aria-label="Example status code" onChange={(e) => patch({ code: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} />
            </label>
            <label className="field ex-grow">
              <span className="field-label">Status text</span>
              <input value={current.status} onChange={(e) => patch({ status: e.target.value })} aria-label="Example status text" />
            </label>
            <label className="field ex-lang">
              <span className="field-label">Body type</span>
              <select value={LANGUAGES.includes(current.language as (typeof LANGUAGES)[number]) ? current.language : 'text'} aria-label="Example body language" onChange={(e) => patch({ language: e.target.value })}>
                {LANGUAGES.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <Button size="sm" variant="danger" onClick={() => void remove()} aria-label="Delete example">
              Delete
            </Button>
          </div>
          <div className="wb-h">Response headers</div>
          <KeyValueTable rows={current.headers} onChange={(headers: KeyValueEntry[]) => patch({ headers })} keyPlaceholder="Header" showDescription={false} />
          <div className="wb-h">Response body</div>
          <div className="ex-editor">
            <CodeEditor value={current.body} language={current.language === 'json' || current.language === 'xml' || current.language === 'html' || current.language === 'javascript' ? current.language : 'plaintext'} onChange={(body) => patch({ body })} />
          </div>
          {tab.requestId ? <p className="wb-hint">Changes to examples are saved with the request (Ctrl+S).</p> : <p className="wb-hint">Save the request to keep its examples.</p>}
        </div>
      ) : (
        <div className="ex-detail">
          <EmptyState title="Select an example" />
        </div>
      )}
    </div>
  );
}
