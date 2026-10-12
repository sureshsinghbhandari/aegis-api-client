import type * as Monaco from 'monaco-editor';
import { getActiveVariableIndex, useVariableIndex } from '../lib/variable-index';
import { completionContext, describeHint, filterCompletions, findVariableTokens, lookupHint, scopeLabel } from '../lib/variable-hints';

/** Languages whose editors offer `{{variable}}` completion/hover (request bodies, scripts). */
const LANGUAGES = ['json', 'xml', 'plaintext', 'html', 'javascript', 'graphql'];

let installed = false;

/**
 * Register the `{{` completion provider and the hover provider once per Monaco instance.
 * Both read the ACTIVE tab's variable index, so no editor-specific wiring is needed.
 */
export function installMonacoVariableSupport(monaco: typeof Monaco): void {
  if (installed) return;
  installed = true;
  for (const language of LANGUAGES) {
    monaco.languages.registerCompletionItemProvider(language, {
      triggerCharacters: ['{'],
      provideCompletionItems(model, position) {
        const line = model.getLineContent(position.lineNumber);
        const ctx = completionContext(line, position.column - 1);
        if (!ctx) return { suggestions: [] };
        const after = line.slice(position.column - 1);
        const closing = after.startsWith('}}') ? '' : '}}';
        const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: ctx.start + 1, endColumn: position.column };
        const suggestions = filterCompletions(getActiveVariableIndex(), ctx.prefix, 60).map((item, i) => ({
          label: `{{${item.name}}}`,
          kind: monaco.languages.CompletionItemKind.Variable,
          detail: `${scopeLabel(item.scope)}${item.owner ? ` · ${item.owner}` : ''}${item.secret ? ' · secret' : ''}`,
          insertText: `{{${item.name}${closing}`,
          range,
          sortText: String(i).padStart(3, '0'),
        }));
        return { suggestions };
      },
    });
    monaco.languages.registerHoverProvider(language, {
      provideHover(model, position) {
        const line = model.getLineContent(position.lineNumber);
        const col = position.column - 1;
        const token = findVariableTokens(line).find((t) => col >= t.start && col <= t.end);
        if (!token) return null;
        const d = describeHint(getActiveVariableIndex(), token.name);
        return {
          range: new monaco.Range(position.lineNumber, token.start + 1, position.lineNumber, token.end + 1),
          contents: [{ value: `**${d.title}**` }, { value: d.detail }],
        };
      },
    });
  }
}

/**
 * Highlight `{{references}}` in an editor (unresolved ones get a warning underline) and
 * keep the decorations current while the content or the active index changes.
 * Returns a dispose function.
 */
export function decorateVariables(monaco: typeof Monaco, editor: Monaco.editor.IStandaloneCodeEditor): () => void {
  const collection = editor.createDecorationsCollection();
  const apply = () => {
    const model = editor.getModel();
    if (!model) return;
    const index = getActiveVariableIndex();
    const decorations: Monaco.editor.IModelDeltaDecoration[] = [];
    const text = model.getValue();
    if (text.includes('{{')) {
      for (const t of findVariableTokens(text)) {
        const start = model.getPositionAt(t.start);
        const end = model.getPositionAt(t.end);
        const hint = lookupHint(index, t.name);
        const cls = !hint ? 'vi-mono-unresolved' : hint.secret ? 'vi-mono-secret' : 'vi-mono-var';
        decorations.push({
          range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
          options: { inlineClassName: cls, ...(hint ? {} : { hoverMessage: { value: `Unresolved variable {{${t.name}}}` } }) },
        });
      }
    }
    collection.set(decorations);
  };
  apply();
  const sub = editor.onDidChangeModelContent(apply);
  const unsubscribe = useVariableIndex.subscribe(apply);
  return () => {
    sub.dispose();
    unsubscribe();
    collection.clear();
  };
}
