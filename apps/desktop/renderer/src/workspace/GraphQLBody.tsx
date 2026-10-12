import type { GraphQLBody as GraphQLBodyModel } from '@aegis/core';
import { Button } from '../components/ui';
import { CodeEditor } from '../components/CodeEditor';
import { VariableInput } from '../components/VariableInput';
import { formatJson } from '../lib/format';
import { useApp } from '../store/app';

export const EMPTY_GRAPHQL: GraphQLBodyModel = { query: '', variables: '' };

/** Query + variables editors for the `graphql` body mode. Sent as `application/json` `{query, variables, operationName}`. */
export function GraphQLBody({ value, onChange }: { value: GraphQLBodyModel; onChange(v: GraphQLBodyModel): void }) {
  const set = (patch: Partial<GraphQLBodyModel>) => onChange({ ...value, ...patch });
  const beautify = () => {
    const next = formatJson(value.variables);
    if (next === null) useApp.getState().toast('The variables are not valid JSON, so they cannot be beautified.', 'info');
    else set({ variables: next });
  };
  const variablesInvalid = value.variables.trim() !== '' && formatJson(value.variables) === null;

  return (
    <div className="gq-root">
      <div className="gq-pane gq-query">
        <div className="gq-head">
          <span>Query</span>
          <span className="wb-spacer" />
          <label className="gq-op">
            <span className="wb-dim">Operation name</span>
            <VariableInput aria-label="GraphQL operation name" value={value.operationName ?? ''} placeholder="optional" onChange={(v) => set(v === '' ? { operationName: undefined } : { operationName: v })} />
          </label>
        </div>
        <div className="wb-editor-host">
          <CodeEditor value={value.query} language="graphql" variableHints onChange={(query) => set({ query })} />
        </div>
      </div>
      <div className="gq-pane gq-vars">
        <div className="gq-head">
          <span>Variables (JSON)</span>
          {variablesInvalid && (
            <span className="gq-invalid" role="status">
              not valid JSON
            </span>
          )}
          <span className="wb-spacer" />
          <Button size="sm" onClick={beautify} title="Re-indent the variables">
            Beautify
          </Button>
        </div>
        <div className="wb-editor-host">
          <CodeEditor value={value.variables} language="json" variableHints onChange={(variables) => set({ variables })} />
        </div>
      </div>
    </div>
  );
}
