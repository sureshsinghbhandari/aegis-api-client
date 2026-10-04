import type { ScriptEntry, ScriptType } from '@aegis/core';
import { useRef } from 'react';
import { CodeEditor } from '../components/CodeEditor';
import type { MonacoEditorProps } from '../components/MonacoEditor';
import { Checkbox } from '../components/ui';
import { getScript, setScript } from '../lib/scripts';
import { PM_TYPINGS, SNIPPETS } from './scriptSupport';
import '../styles/workbench.css';

type Editor = Parameters<NonNullable<MonacoEditorProps['onReady']>>[0];

const DESCRIPTION: Record<ScriptType, string> = {
  prerequest: 'Runs before the request is sent. Use it to set variables or adjust the outgoing request.',
  test: 'Runs after the response is received. Use it to write tests and save values from the response.',
};

/** JavaScript editor for one script phase with `pm` autocomplete and a snippet list. */
export function ScriptPanel({ phase, scripts, onChange }: { phase: ScriptType; scripts: ScriptEntry[]; onChange(next: ScriptEntry[]): void }) {
  const editor = useRef<Editor | null>(null);
  const entry = getScript(scripts, phase);

  const insert = (code: string) => {
    const ed = editor.current;
    if (ed) {
      const sel = ed.getSelection();
      if (sel) ed.executeEdits('snippet', [{ range: sel, text: code, forceMoveMarkers: true }]);
      ed.focus();
    } else {
      onChange(setScript(scripts, phase, { source: entry.source + (entry.source && !entry.source.endsWith('\n') ? '\n' : '') + code }));
    }
  };

  return (
    <div className="sc-panel">
      <div className="sc-main">
        <div className="sc-head">
          <span className="wb-dim">{DESCRIPTION[phase]}</span>
          <span className="wb-spacer" />
          <Checkbox checked={entry.enabled} onChange={(enabled) => onChange(setScript(scripts, phase, { enabled }))} label="Enabled" disabled={entry.source.trim() === ''} />
        </div>
        <div className="sc-editor">
          <CodeEditor
            key={phase}
            value={entry.source}
            language="javascript"
            extraLib={PM_TYPINGS}
            onChange={(source) => onChange(setScript(scripts, phase, { source }))}
            onReady={(ed) => {
              editor.current = ed;
            }}
          />
        </div>
      </div>
      <aside className="sc-snippets" aria-label="Snippets">
        <div className="sc-snippets-title">Snippets</div>
        {SNIPPETS.filter((s) => s.phases.includes(phase)).map((s) => (
          <button key={s.title} type="button" className="sc-snippet" onClick={() => insert(s.code)} title={s.code}>
            {s.title}
          </button>
        ))}
      </aside>
    </div>
  );
}
