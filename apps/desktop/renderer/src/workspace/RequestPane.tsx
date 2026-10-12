import { useMemo, useState } from 'react';
import { MarkdownEditor } from '../components/MarkdownPreview';
import { Tabs } from '../components/ui';
import { hasScript } from '../lib/scripts';
import { ExamplesTab } from '../response/ExamplesTab';
import type { OpenTab } from '../store/app';
import { BodyTab } from './BodyTab';
import { AuthTab, SettingsTab } from './MiscTabs';
import { HeadersTab, ParamsTab } from './ParamsHeadersTabs';
import { ScriptPanel, type ScriptContext } from './ScriptPanel';
import { UrlBar } from './UrlBar';
import { useDraftUpdate } from './useDraft';

type SectionId = 'params' | 'headers' | 'body' | 'auth' | 'prerequest' | 'tests' | 'examples' | 'settings' | 'docs';

// The selected section is remembered per tab while the app is running.
const lastSection = new Map<string, SectionId>();

/** Description editor with a sandboxed Markdown preview next to it. */
function DocsSection({ tab }: { tab: OpenTab }) {
  const update = useDraftUpdate(tab);
  return (
    <div className="wb-pane-scroll wb-docs">
      <MarkdownEditor label="Request description" value={tab.draft.description} onChange={(description) => update({ description })} placeholder="Describe this request: purpose, expected inputs and outputs… (Markdown)" />
    </div>
  );
}

export function RequestPane({ tab }: { tab: OpenTab }) {
  const update = useDraftUpdate(tab);
  const [section, setSectionState] = useState<SectionId>(lastSection.get(tab.tabId) ?? 'params');
  const setSection = (s: SectionId) => {
    lastSection.set(tab.tabId, s);
    setSectionState(s);
  };
  const { draft } = tab;

  const tabs = useMemo(() => {
    const dot = <span className="wb-badge-dot" aria-label="has content" />;
    const queryCount = draft.queryParams.filter((p) => p.enabled && p.key !== '').length;
    const headerCount = draft.headers.filter((h) => h.enabled && h.key !== '').length;
    const authBadge = draft.auth.type !== 'none' && draft.auth.type !== 'inherit' ? dot : undefined;
    return [
      { id: 'params' as const, label: 'Params', badge: queryCount || undefined },
      { id: 'headers' as const, label: 'Headers', badge: headerCount || undefined },
      { id: 'body' as const, label: 'Body', badge: draft.body.mode !== 'none' ? dot : undefined },
      { id: 'auth' as const, label: 'Authorization', badge: authBadge },
      { id: 'prerequest' as const, label: 'Pre-request Script', badge: hasScript(draft.scripts, 'prerequest') ? dot : undefined },
      { id: 'tests' as const, label: 'Post-response', badge: hasScript(draft.scripts, 'test') ? dot : undefined },
      { id: 'examples' as const, label: 'Examples', badge: draft.examples.length || undefined },
      { id: 'settings' as const, label: 'Settings' },
      { id: 'docs' as const, label: 'Docs', badge: draft.description.trim() ? dot : undefined },
    ];
  }, [draft.queryParams, draft.headers, draft.body.mode, draft.auth.type, draft.scripts, draft.examples.length, draft.description]);
  const scriptContext: ScriptContext = { collectionId: tab.collectionId, folderId: tab.folderId, variableChanges: tab.response.result?.variableChanges };

  return (
    <div className="wb-request">
      <div className="wb-namerow">
        <input
          className="wb-name"
          aria-label="Request name"
          value={draft.name}
          placeholder="Request name"
          spellCheck={false}
          onChange={(e) => update({ name: e.target.value })}
        />
      </div>
      <UrlBar tab={tab} />
      <Tabs tabs={tabs} value={section} onChange={setSection} className="wb-sections" />
      <div className="wb-section-body" role="tabpanel">
        {section === 'params' && <ParamsTab tab={tab} />}
        {section === 'headers' && <HeadersTab tab={tab} />}
        {section === 'body' && <BodyTab tab={tab} />}
        {section === 'auth' && <AuthTab tab={tab} />}
        {section === 'prerequest' && <ScriptPanel phase="prerequest" scripts={draft.scripts} onChange={(scripts) => update({ scripts })} context={scriptContext} />}
        {section === 'tests' && <ScriptPanel phase="test" scripts={draft.scripts} onChange={(scripts) => update({ scripts })} context={scriptContext} />}
        {section === 'examples' && <ExamplesTab tab={tab} />}
        {section === 'settings' && <SettingsTab tab={tab} />}
        {section === 'docs' && <DocsSection tab={tab} />}
      </div>
    </div>
  );
}
