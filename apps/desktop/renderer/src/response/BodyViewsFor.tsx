import type { ExecutionResult, ResponseView } from '@aegis/core';
import { PrettyView, PreviewView, RawView } from './BodyViews';
import { CookiesView, HeadersView } from './ResponseTables';
import { TestResultsList } from './TestResultsList';
import { Timeline } from './Timeline';
import type { ResponseBody } from './useResponseBody';
import { VisualizeView } from './VisualizeView';

/** Renders the selected response section. The body is resolved once per response by the viewer and shared by the body tabs. */
export function BodyViewsFor({ section, response, result, body, onSave }: { section: string; response: ResponseView; result: ExecutionResult; body: ResponseBody; onSave(): void }) {
  switch (section) {
    case 'pretty':
      return <PrettyView response={response} body={body} onSave={onSave} />;
    case 'raw':
      return <RawView response={response} body={body} onSave={onSave} />;
    case 'preview':
      return <PreviewView response={response} body={body} onSave={onSave} />;
    case 'visualize':
      return <VisualizeView result={result} />;
    case 'headers':
      return <HeadersView response={response} />;
    case 'cookies':
      return <CookiesView response={response} />;
    case 'tests':
      return (
        <div className="rv-scroll">
          <TestResultsList tests={result.tests} />
        </div>
      );
    default:
      return <Timeline result={result} response={response} />;
  }
}
