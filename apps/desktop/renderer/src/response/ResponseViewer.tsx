import type { ExecutionResult, RequestExample, ResponseView } from '@aegis/core';
import { useEffect, useRef, useState } from 'react';
import { Badge, Button, EmptyState, formatBytes, formatMs, Spinner, statusTone, Tabs } from '../components/ui';
import { suggestedFileName } from '../lib/format';
import { useApp, type OpenTab } from '../store/app';
import { useUi } from '../store/ui';
import { BodyViewsFor } from './BodyViewsFor';
import { saveResponse } from './LargeBodyViewer';
import { TestSummary } from './TestResultsList';
import { useResponseBody, type ResponseBody } from './useResponseBody';

function useElapsed(active: boolean, key: string | undefined): number {
  const start = useRef(Date.now());
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    start.current = Date.now();
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, [active, key]);
  return active ? now - start.current : 0;
}

const HINTS: Partial<Record<string, string>> = {
  TLS_ERROR: 'The TLS handshake or certificate validation failed. If the server uses a private or corporate CA, add it under Settings → Certificates. Certificate verification cannot be bypassed from a request.',
  NETWORK_ERROR: 'The server could not be reached. Check the URL, your network or proxy settings, and that the service is running.',
  REQUEST_TIMEOUT: 'The server did not answer in time. You can raise the timeout in the Settings tab of the request.',
  REQUEST_CANCELLED: 'The request was cancelled before a response was received.',
  TOO_MANY_REDIRECTS: 'The server redirected too many times. Check for a redirect loop or raise the limit in the request Settings tab.',
  RESPONSE_TOO_LARGE: 'The response exceeded the maximum allowed size.',
  REQUEST_TOO_LARGE: 'The request body exceeded the maximum allowed size.',
  POLICY_VIOLATION: 'This request is blocked by your organization policy.',
  AUTH_FAILED: 'Authorization failed. Check the Authorization tab of the request (for OAuth 2.0 request a new access token).',
  SCRIPT_ERROR: 'A script failed. See the Console panel for details.',
  SCRIPT_TIMEOUT: 'A script took too long. See the Console panel for details.',
  SCRIPT_MEMORY: 'A script used too much memory. See the Console panel for details.',
  PATH_NOT_ALLOWED: 'A file referenced by the request (form-data file or binary body) cannot be read from that location.',
  VALIDATION_FAILED: 'The request is not valid. Check the URL and other fields.',
};

function ErrorView({ tab, error, result }: { tab: OpenTab; error: { code: string; message: string }; result?: ExecutionResult }) {
  const sendTab = useApp((s) => s.sendTab);
  const env = useApp((s) => s.environments.find((e) => e.isActive));
  const hint = HINTS[error.code];
  return (
    <div className="rv-error" role="alert">
      <div className="rv-error-code">
        <Badge tone="danger">{error.code}</Badge>
      </div>
      <div className="rv-error-msg">{error.message}</div>
      {hint && <p className="wb-hint">{hint}</p>}
      {error.code === 'CONFIRMATION_REQUIRED' && (
        <div>
          <p className="wb-hint">The active environment{env ? ` "${env.name}"` : ''} is marked as production.</p>
          <Button variant="danger" onClick={() => void sendTab(tab.tabId, { confirmProduction: true })}>
            Send anyway
          </Button>
        </div>
      )}
      {result && result.unresolvedVariables.length > 0 && (
        <p className="wb-hint">
          Unresolved variables: {result.unresolvedVariables.map((v) => `{{${v}}}`).join(', ')}
        </p>
      )}
      {result && result.warnings.length > 0 && (
        <ul className="tl-list tl-warn">
          {result.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

type SectionId = 'pretty' | 'raw' | 'preview' | 'visualize' | 'headers' | 'cookies' | 'tests' | 'timeline';

/** Build an example from the current response (body only when it is text and fully loaded). */
export function exampleFromResponse(name: string, response: ResponseView, body: ResponseBody, result: ExecutionResult): RequestExample {
  const textual = body.text !== null && !body.large;
  const language = body.kind === 'json' || body.kind === 'xml' || body.kind === 'html' ? body.kind : 'text';
  return {
    name,
    status: response.statusText,
    code: response.status,
    headers: response.headers.map((h) => ({ key: h.name, value: h.value, enabled: true })),
    body: textual ? body.text! : '',
    language,
    ...(result.request ? { originalRequest: { method: result.request.method, url: result.request.url, headers: result.request.headers } } : {}),
    metadata: textual ? {} : { bodyOmitted: body.large ? 'too large' : 'binary' },
  };
}

export function ResponseViewer({ tab }: { tab: OpenTab }) {
  const { response: state } = tab;
  const cancelTab = useApp((s) => s.cancelTab);
  const [section, setSection] = useState<SectionId>('pretty');
  const [dismissed, setDismissed] = useState<string | null>(null);
  const elapsed = useElapsed(state.status === 'sending', state.executionId);
  const result = state.result;
  const response = result?.response ?? null;
  const body = useResponseBody(response);

  if (state.status === 'idle') {
    return (
      <div className="rv-root">
        <EmptyState title="No response yet">
          Press <kbd>Ctrl</kbd>+<kbd>Enter</kbd> or click Send to execute the request.
        </EmptyState>
      </div>
    );
  }
  if (state.status === 'sending') {
    return (
      <div className="rv-root">
        <div className="center-fill rv-sending">
          <Spinner label="Sending request" />
          <span>Sending… {formatMs(elapsed)}</span>
          <Button onClick={() => void cancelTab(tab.tabId)}>Cancel</Button>
        </div>
      </div>
    );
  }

  const error = state.error ?? result?.error;
  if (!response || !result) {
    return (
      <div className="rv-root">
        {error ? <ErrorView tab={tab} error={error} {...(result ? { result } : {})} /> : <EmptyState title="No response received">The request finished without a response.</EmptyState>}
      </div>
    );
  }

  const tests = result.tests;
  const warnings = result.warnings;
  const showWarnings = warnings.length > 0 && dismissed !== state.executionId;
  const suggested = suggestedFileName(response.contentType, response.url);

  const saveAsExample = async () => {
    const name = await useUi.getState().prompt({ title: 'Save response as example', label: 'Example name', initial: `${response.status} ${response.statusText}`.trim() || tab.draft.name, confirmLabel: 'Save example' });
    if (!name) return;
    await useApp.getState().addExample(tab.tabId, exampleFromResponse(name, response, body, result));
  };

  return (
    <div className="rv-root">
      <div className="rv-status">
        <span className="rv-status-item">
          Status <Badge tone={statusTone(response.status)}>{response.status} {response.statusText}</Badge>
        </span>
        <span className="rv-status-item" title="Total time">
          Time <strong>{formatMs(response.timings.totalMs)}</strong>
        </span>
        <span className="rv-status-item" title="Response body size">
          Size <strong>{formatBytes(response.size)}</strong>
        </span>
        {response.contentType && (
          <span className="rv-status-item rv-ct" title={response.contentType}>
            {response.contentType}
          </span>
        )}
        <span className="wb-spacer" />
        <Button size="sm" onClick={() => void saveAsExample()} title="Store this response as an example of the request (exported with the collection)">
          Save as example
        </Button>
        <Button size="sm" onClick={() => saveResponse(response.responseId, suggested)} title="Save the full response body to a file">
          Save response
        </Button>
      </div>
      {error && <ErrorView tab={tab} error={error} result={result} />}
      {showWarnings && (
        <div className="banner rv-warnings" role="status">
          <ul>
            {warnings.slice(0, 6).map((w, i) => (
              <li key={i}>{w}</li>
            ))}
            {warnings.length > 6 && <li>…and {warnings.length - 6} more (see Timeline)</li>}
          </ul>
          <Button size="sm" variant="ghost" aria-label="Dismiss warnings" onClick={() => setDismissed(state.executionId ?? null)}>
            Dismiss
          </Button>
        </div>
      )}
      <Tabs<SectionId>
        className="rv-tabs"
        value={section}
        onChange={setSection}
        tabs={[
          { id: 'pretty' as const, label: 'Pretty' },
          { id: 'raw' as const, label: 'Raw' },
          { id: 'preview' as const, label: 'Preview' },
          { id: 'visualize' as const, label: 'Visualize', badge: result.visualizer ? <span className="wb-badge-dot" aria-label="has content" /> : undefined },
          { id: 'headers' as const, label: 'Headers', badge: response.headers.length },
          { id: 'cookies' as const, label: 'Cookies', badge: response.cookies.length || undefined },
          { id: 'tests' as const, label: 'Test Results', badge: tests.length > 0 ? <TestSummary tests={tests} /> : undefined },
          { id: 'timeline' as const, label: 'Timeline' },
        ]}
      />
      <div className="rv-panel" role="tabpanel">
        <BodyViewsFor section={section} response={response} result={result} body={body} onSave={() => saveResponse(response.responseId, suggested)} />
      </div>
    </div>
  );
}
