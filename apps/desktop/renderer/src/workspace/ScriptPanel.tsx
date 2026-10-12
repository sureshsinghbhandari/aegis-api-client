import type { ExecutionResult, ScriptEntry, ScriptType } from '@aegis/core';
import { useEffect, useRef, useState } from 'react';
import { CodeEditor } from '../components/CodeEditor';
import type { MonacoEditorProps } from '../components/MonacoEditor';
import { Checkbox } from '../components/ui';
import { readPaneOpen, writePaneOpen } from '../lib/script-vars';
import { getScript, setScript } from '../lib/scripts';
import { PM_TYPINGS, SNIPPETS } from './scriptSupport';
import { ScriptVariablesPane } from './ScriptVariablesPane';
import '../styles/workbench.css';
import '../styles/script-vars.css';

type Editor = Parameters<NonNullable<MonacoEditorProps['onReady']>>[0];

const DESCRIPTION: Record<ScriptType, string> = {
  prerequest: 'Pre-request: runs before the request is sent. Use it to set variables or adjust the outgoing request.',
  test: 'Post-response: runs after the response is received. Use it to write tests (pm.test) and save values from the response.',
};

/** Where the script runs: a request tab (knows its collection/folder and last run) or a collection/folder editor. */
export interface ScriptContext {
  collectionId: string | null;
  folderId: string | null;
  variableChanges?: ExecutionResult['variableChanges'] | undefined;
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** JavaScript editor for one script phase with `pm` autocomplete, a snippet list and a variables side pane. */
export function ScriptPanel({ phase, scripts, onChange, context }: { phase: ScriptType; scripts: ScriptEntry[]; onChange(next: ScriptEntry[]): void; context?: ScriptContext }) {
  const editor = useRef<Editor | null>(null);
  const entry = getScript(scripts, phase);
  const [varsOpen, setVarsOpen] = useState(() => readPaneOpen(safeStorage()));
  const [helpOpen, setHelpOpen] = useState(false);
  const helpRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!helpOpen) return;
    const onDown = (e: MouseEvent) => {
      if (helpRef.current && !helpRef.current.contains(e.target as Node)) setHelpOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setHelpOpen(false);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [helpOpen]);

  const toggleVars = () => {
    const next = !varsOpen;
    setVarsOpen(next);
    writePaneOpen(safeStorage(), next);
  };

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
          <div className="sc-help-wrap" ref={helpRef}>
            <button type="button" className="btn btn-sm" aria-expanded={helpOpen} aria-haspopup="dialog" onClick={() => setHelpOpen((v) => !v)}>
              Examples
            </button>
            {helpOpen && (
              <div className="sc-help" role="dialog" aria-label="Script examples">
                <h4>How scripts run</h4>
                <p>
                  <strong>Pre-request</strong> runs before the request is sent. <strong>Post-response</strong> runs after the response arrives and is where <code>pm.test(...)</code> results come from (see the Test Results tab).
                </p>
                <h4>Chain requests with variables</h4>
                <pre>{"pm.environment.set('token', pm.response.json().token);"}</pre>
                <p>
                  Then use <code>{'{{token}}'}</code> in the next request's URL, headers or body, or read it with <code>pm.environment.get('token')</code>.
                </p>
                <h4>Scopes</h4>
                <p>
                  <code>pm.environment</code> (active environment), <code>pm.globals</code> (workspace), <code>pm.collectionVariables</code> (collection and folders), <code>pm.variables</code> (local to this run; also reads every scope). Values written by a script are saved after the send and show up in the Variables pane.
                </p>
                <h4>Dynamic values</h4>
                <p>
                  <code>{"pm.variables.replaceIn('{{$guid}}')"}</code>, <code>{'{{$timestamp}}'}</code>, <code>{'{{$randomInt}}'}</code>.
                </p>
              </div>
            )}
          </div>
          <button type="button" className="btn btn-sm" aria-pressed={varsOpen} onClick={toggleVars} title="Show the variables this script can read and write">
            Variables
          </button>
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
      {varsOpen && <ScriptVariablesPane phase={phase} collectionId={context?.collectionId ?? null} folderId={context?.folderId ?? null} variableChanges={context?.variableChanges} onInsert={insert} />}
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
