import { buildPreviewDocument, PREVIEW_CSP, type ExecutionResult } from '@aegis/core';
import { useMemo } from 'react';
import { EmptyState } from '../components/ui';

/** Already a full sandboxed document (the sandbox may wrap it itself)? Then do not wrap it twice. */
export function visualizerDocument(html: string): string {
  const head = html.slice(0, 512).toLowerCase();
  if (head.startsWith('<!doctype html') && html.includes(PREVIEW_CSP)) return html;
  return buildPreviewDocument(html);
}

/**
 * Renders the HTML produced by `pm.visualizer.set(template, data)`. The markup is static: it is
 * sanitised, carries a restrictive CSP and is shown in an `<iframe sandbox="">` (no scripts,
 * no network, no forms), so a visualizer template cannot run code or reach other origins.
 */
export function VisualizeView({ result }: { result: ExecutionResult }) {
  const html = result.visualizer;
  const srcDoc = useMemo(() => (html ? visualizerDocument(html) : null), [html]);
  if (!srcDoc) {
    return (
      <EmptyState title="No visualization">
        Call <code>pm.visualizer.set(template, data)</code> in the Tests script to render the response with a Handlebars template. The output is static HTML
        (styles allowed, scripts and remote resources blocked).
      </EmptyState>
    );
  }
  return (
    <div className="rv-body">
      <div className="rv-toolbar">
        <span className="wb-dim">Sandboxed visualization: scripts, forms, plugins and network requests are disabled.</span>
      </div>
      {/* sandbox="" (no flags): no scripts, no same-origin access, no forms, no popups. */}
      <iframe className="rv-iframe" title="Response visualization" sandbox="" srcDoc={srcDoc} referrerPolicy="no-referrer" />
    </div>
  );
}
