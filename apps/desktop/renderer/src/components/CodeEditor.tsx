import { lazy, Suspense } from 'react';
import type { MonacoEditorProps } from './MonacoEditor';
import { Spinner } from './ui';

const Monaco = lazy(() => import('./MonacoEditor'));

/**
 * Code editor (Monaco, loaded lazily so the first paint is fast).
 * Languages: json, xml, html, javascript, plaintext. For very large content
 * (> ~2 MB) prefer `LargeText` rendering instead of an editor.
 */
export function CodeEditor(props: MonacoEditorProps & { height?: number | string }) {
  const { height = '100%', ...rest } = props;
  return (
    <div style={{ height, minHeight: 80, position: 'relative' }}>
      <Suspense
        fallback={
          <div className="center-fill">
            <Spinner />
          </div>
        }
      >
        <Monaco {...rest} />
      </Suspense>
    </div>
  );
}
