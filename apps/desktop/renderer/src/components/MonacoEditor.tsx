import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/language/typescript/ts.worker?worker';
import { useEffect, useRef } from 'react';
import { useApp } from '../store/app';

// Workers are bundled with the app (served from app://), so the strict CSP needs no remote script sources.
(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker(_id: string, label: string): Worker {
    if (label === 'json') return new jsonWorker();
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker();
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker();
    if (label === 'typescript' || label === 'javascript') return new tsWorker();
    return new editorWorker();
  },
};

export interface MonacoEditorProps {
  value: string;
  onChange?(value: string): void;
  language?: string;
  readOnly?: boolean;
  wordWrap?: boolean;
  lineNumbers?: boolean;
  /** Extra TypeScript declarations (for script autocomplete), registered once per editor. */
  extraLib?: { content: string; name: string };
  onReady?(editor: monaco.editor.IStandaloneCodeEditor): void;
}

/** Monaco wrapper: controlled value, theme synced with the app, automatic layout. */
export default function MonacoEditor({ value, onChange, language = 'plaintext', readOnly, wordWrap = true, lineNumbers = true, extraLib, onReady }: MonacoEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  const theme = useApp((s) => s.theme);

  useEffect(() => {
    if (!host.current) return;
    const editor = monaco.editor.create(host.current, {
      value,
      language,
      readOnly: !!readOnly,
      theme: theme === 'dark' ? 'vs-dark' : 'vs',
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      wordWrap: wordWrap ? 'on' : 'off',
      lineNumbers: lineNumbers ? 'on' : 'off',
      fontSize: 13,
      tabSize: 2,
      renderWhitespace: 'none',
      fixedOverflowWidgets: true,
      ariaLabel: 'Code editor',
    });
    editorRef.current = editor;
    // Monaco consumes Ctrl+Enter ("insert line below") and Ctrl+S before the global shortcuts see them.
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
      const s = useApp.getState();
      if (s.activeTabId) void s.sendTab(s.activeTabId);
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      const s = useApp.getState();
      if (s.activeTabId) void s.saveTab(s.activeTabId);
    });
    const sub = editor.onDidChangeModelContent(() => changeRef.current?.(editor.getValue()));
    let lib: monaco.IDisposable | undefined;
    if (extraLib) lib = monaco.typescript.javascriptDefaults.addExtraLib(extraLib.content, extraLib.name);
    onReady?.(editor);
    return () => {
      sub.dispose();
      lib?.dispose();
      editor.getModel()?.dispose();
      editor.dispose();
      editorRef.current = null;
    };
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    if (editor && editor.getValue() !== value) editor.setValue(value);
  }, [value]);

  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (model) monaco.editor.setModelLanguage(model, language);
  }, [language]);

  useEffect(() => {
    monaco.editor.setTheme(theme === 'dark' ? 'vs-dark' : 'vs');
  }, [theme]);

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly: !!readOnly, wordWrap: wordWrap ? 'on' : 'off' });
  }, [readOnly, wordWrap]);

  return <div ref={host} className="code-editor" />;
}
