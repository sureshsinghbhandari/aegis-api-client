import { generateSnippet, isSnippetLanguage, prepareSnippetRequest, snippetRequestFromSent, SNIPPET_LANGUAGES, type DisplayVariable, type SnippetLanguage } from '@aegis/codegen';
import type { AuthConfig, VariableEntry } from '@aegis/core';
import { AUTH_SECRET_PARAMS } from '@aegis/core';
import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Checkbox, Modal } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { isSecretRef } from '../lib/ui-format';
import { useApp } from '../store/app';
import { useUi } from '../store/ui';
import type { ModalComponentProps } from './ModalHost';
import '../styles/workbench.css';

const LANGUAGE_KEY = 'aegis.codegen.language';

interface Scope {
  variables: Map<string, DisplayVariable>;
  effectiveAuth?: AuthConfig;
  inheritedFrom?: string;
  error?: string;
}

function addEntries(map: Map<string, DisplayVariable>, entries: VariableEntry[]): void {
  for (const e of entries) {
    if (!e.enabled || !e.key) continue;
    const value = e.currentValue !== undefined && e.currentValue !== '' ? e.currentValue : e.initialValue;
    map.set(e.key, { value, secret: e.isSecret || isSecretRef(value) });
  }
}

function storedLanguage(): SnippetLanguage {
  try {
    const v = localStorage.getItem(LANGUAGE_KEY);
    if (v && isSnippetLanguage(v)) return v;
  } catch {
    /* storage unavailable */
  }
  return 'curl';
}

/** Props: `{ tabId: string }`. */
export default function CodeSnippetModal({ props }: ModalComponentProps) {
  const tabId = typeof props?.tabId === 'string' ? props.tabId : null;
  const tab = useApp((s) => (tabId ? s.tabs.find((t) => t.tabId === tabId) : undefined));
  const info = useApp((s) => s.info);
  const workspaceId = useApp((s) => s.workspaceId);
  const environments = useApp((s) => s.environments);
  const close = () => useUi.getState().closeModal();

  const [language, setLanguage] = useState<SnippetLanguage>(storedLanguage);
  const [scope, setScope] = useState<Scope | null>(null);
  const [reveal, setReveal] = useState(false);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [revealing, setRevealing] = useState(false);
  const [source, setSource] = useState<'editor' | 'sent'>('editor');
  const [copied, setCopied] = useState<string | null>(null);

  const allowReveal = info?.policy.allowSecretExport !== false;
  const sent = tab?.response.result?.request;
  const activeEnv = environments.find((e) => e.isActive);

  // Variables visible to the request: global < collection < folders (outer -> inner) < environment.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!tab || !workspaceId) return;
      const map = new Map<string, DisplayVariable>();
      const result: Scope = { variables: map };
      try {
        addEntries(map, await api.variables.get({ scope: 'global', ownerId: workspaceId }));
        if (tab.collectionId) addEntries(map, await api.variables.get({ scope: 'collection', ownerId: tab.collectionId }));
        const chain: string[] = [];
        let folderId = tab.folderId;
        for (let depth = 0; folderId && depth < 32; depth++) {
          chain.unshift(folderId);
          const folder = await api.folders.get({ id: folderId });
          folderId = folder.parentFolderId;
        }
        for (const id of chain) addEntries(map, await api.variables.get({ scope: 'folder', ownerId: id }));
        if (activeEnv) addEntries(map, await api.variables.get({ scope: 'environment', ownerId: activeEnv.id }));
        if (tab.draft.auth.type === 'inherit' && tab.requestId) {
          const eff = await api.requests.effectiveAuth({ id: tab.requestId });
          result.effectiveAuth = eff.auth;
          result.inheritedFrom = eff.source;
        }
      } catch (e) {
        result.error = errorMessage(e);
      }
      if (!cancelled) setScope(result);
    })();
    return () => {
      cancelled = true;
    };
  }, [tab?.tabId, tab?.collectionId, tab?.folderId, tab?.requestId, tab?.draft.auth.type, workspaceId, activeEnv?.id]);

  const snippetRequest = useMemo(() => {
    if (!tab) return null;
    if (source === 'sent' && sent) return snippetRequestFromSent(sent);
    return prepareSnippetRequest(tab.draft, {
      variables: scope?.variables,
      ...(scope?.effectiveAuth ? { effectiveAuth: scope.effectiveAuth, inheritedFrom: scope.inheritedFrom } : {}),
      revealSecrets: reveal && allowReveal,
      revealed,
    });
  }, [tab, source, sent, scope, reveal, allowReveal, revealed]);

  const code = useMemo(() => {
    if (!snippetRequest) return '';
    try {
      return generateSnippet(language, snippetRequest);
    } catch (e) {
      return `# ${errorMessage(e)}`;
    }
  }, [language, snippetRequest]);

  const pickLanguage = (id: string) => {
    if (!isSnippetLanguage(id)) return;
    setLanguage(id);
    try {
      localStorage.setItem(LANGUAGE_KEY, id);
    } catch {
      /* storage unavailable */
    }
  };

  const toggleReveal = async (on: boolean) => {
    if (!on || !allowReveal) {
      setReveal(false);
      return;
    }
    // Every secret reference is revealed through the audited channel; nothing is cached beyond this modal.
    const refs = new Set<string>();
    for (const v of scope?.variables.values() ?? []) if (v.secret && isSecretRef(v.value)) refs.add(v.value);
    const auth = tab?.draft.auth.type === 'inherit' ? scope?.effectiveAuth : tab?.draft.auth;
    if (auth) {
      const keys = AUTH_SECRET_PARAMS[auth.type === 'custom' ? String(auth.params.providerId ?? 'custom') : auth.type] ?? [];
      for (const k of keys) {
        const v = auth.params[k];
        if (typeof v === 'string' && isSecretRef(v)) refs.add(v);
      }
    }
    setRevealing(true);
    try {
      const out: Record<string, string> = {};
      for (const ref of refs) out[ref] = await api.variables.revealSecret({ ref });
      setRevealed(out);
      setReveal(true);
    } catch (e) {
      useApp.getState().toast(errorMessage(e), 'error');
      setReveal(false);
    } finally {
      setRevealing(false);
    }
  };

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      useApp.getState().toast('Could not access the clipboard.', 'error');
    }
  };

  const copyAsSent = () => {
    if (!sent) return;
    void copy(generateSnippet(language, snippetRequestFromSent(sent)), 'sent');
  };

  if (!tab) {
    return (
      <Modal title="Code" onClose={close}>
        <p className="field-hint">The request tab is no longer open.</p>
      </Modal>
    );
  }

  return (
    <Modal
      title="Code"
      width={820}
      onClose={close}
      footer={
        <>
          {sent && (
            <Button onClick={copyAsSent} title="Copy the snippet for the request exactly as it was last sent (variables resolved, secrets redacted)">
              {copied === 'sent' ? 'Copied' : 'Copy as sent'}
            </Button>
          )}
          <Button variant="primary" onClick={() => void copy(code, 'code')}>
            {copied === 'code' ? 'Copied' : 'Copy'}
          </Button>
        </>
      }
    >
      <div className="cs-toolbar">
        <label className="cs-lang">
          <span className="field-label">Language</span>
          <select aria-label="Snippet language" value={language} onChange={(e) => pickLanguage(e.target.value)}>
            {SNIPPET_LANGUAGES.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
        {sent && (
          <label className="cs-lang">
            <span className="field-label">Source</span>
            <select aria-label="Snippet source" value={source} onChange={(e) => setSource(e.target.value === 'sent' ? 'sent' : 'editor')}>
              <option value="editor">Request editor</option>
              <option value="sent">Last sent request (redacted)</option>
            </select>
          </label>
        )}
        <span className="cs-spacer" />
        <span title={allowReveal ? 'Substitute secret variables and credentials (audited)' : 'Disabled by organization policy (secret export is not allowed)'}>
          <Checkbox label={revealing ? 'Revealing…' : 'Reveal secrets'} checked={reveal} disabled={!allowReveal || revealing || source === 'sent'} onChange={(v) => void toggleReveal(v)} />
        </span>
        {!allowReveal && <Badge tone="warning">Policy: secrets stay masked</Badge>}
      </div>
      {scope?.error && <p className="field-warn">Variables could not be loaded: {scope.error}</p>}
      {reveal && allowReveal && <p className="field-warn">Secrets are included in this snippet. The reveal was audited.</p>}
      <pre className="cs-code" tabIndex={0} aria-label="Generated code">
        {code}
      </pre>
    </Modal>
  );
}
