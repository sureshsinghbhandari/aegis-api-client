import { useCallback, useEffect, useState } from 'react';
import type { AppSettings } from '@aegis/core';
import { api, errorMessage } from '../lib/api';
import { Button, ErrorBanner, Modal, Spinner } from '../components/ui';
import { useApp } from '../store/app';
import { useUi } from '../store/ui';
import { CertificatesSection } from './settings/CertificatesSection';
import { CookiesSection } from './settings/CookiesSection';
import { GeneralSection } from './settings/GeneralSection';
import { HistorySection } from './settings/HistorySection';
import { NetworkSection } from './settings/NetworkSection';
import { ScriptingSection } from './settings/ScriptingSection';
import { SecuritySection } from './settings/SecuritySection';
import type { SectionProps } from './settings/common';
import type { ModalComponentProps } from './ModalHost';
import '../styles/panels.css';

const SECTIONS = [
  { id: 'general', label: 'General' },
  { id: 'network', label: 'Network' },
  { id: 'certificates', label: 'Certificates' },
  { id: 'cookies', label: 'Cookies' },
  { id: 'history', label: 'History & Privacy' },
  { id: 'scripting', label: 'Scripting' },
  { id: 'security', label: 'Security & Privacy' },
] as const;
type SectionId = (typeof SECTIONS)[number]['id'];

const isSection = (v: unknown): v is SectionId => SECTIONS.some((s) => s.id === v);

export default function SettingsModal({ props }: ModalComponentProps) {
  const info = useApp((s) => s.info);
  const [section, setSection] = useState<SectionId>(isSection(props?.section) ? props.section : 'general');
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');

  useEffect(() => {
    if (isSection(props?.section)) setSection(props.section);
  }, [props]);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const s = await api.settings.get();
      setSettings(s);
      useApp.getState().applySettings(s);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  const save = useCallback(async (patch: Record<string, unknown>): Promise<boolean> => {
    setSaveState('saving');
    setError(null);
    try {
      const next = await api.settings.update({ patch });
      setSettings(next);
      useApp.getState().applySettings(next);
      setSaveState('saved');
      return true;
    } catch (e) {
      setError(errorMessage(e));
      setSaveState('idle');
      // Re-sync controls with what the backend actually has.
      void api.settings.get().then(setSettings, () => undefined);
      return false;
    }
  }, []);

  const sectionProps: SectionProps | null = settings ? { settings, info, save, reload } : null;

  return (
    <Modal
      title="Settings"
      width={920}
      onClose={() => useUi.getState().closeModal()}
      footer={
        <>
          <span className="set-status" role="status" aria-live="polite">
            {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'All changes saved' : 'Changes are saved automatically'}
          </span>
          <Button variant="primary" onClick={() => useUi.getState().closeModal()}>
            Done
          </Button>
        </>
      }
    >
      <div className="set">
        <nav className="set-nav" aria-label="Settings sections">
          {SECTIONS.map((s) => (
            <button key={s.id} type="button" className={`set-nav-item ${s.id === section ? 'active' : ''}`} aria-current={s.id === section ? 'page' : undefined} onClick={() => setSection(s.id)}>
              {s.label}
            </button>
          ))}
        </nav>
        <div className="set-content">
          {error && <ErrorBanner message={error} onRetry={() => void reload()} />}
          {!sectionProps ? (
            !error && (
              <div className="center-fill" style={{ padding: 24 }}>
                <Spinner label="Loading settings" />
              </div>
            )
          ) : (
            <>
              {section === 'general' && <GeneralSection {...sectionProps} />}
              {section === 'network' && <NetworkSection {...sectionProps} />}
              {section === 'certificates' && <CertificatesSection />}
              {section === 'cookies' && <CookiesSection />}
              {section === 'history' && <HistorySection {...sectionProps} />}
              {section === 'scripting' && <ScriptingSection {...sectionProps} />}
              {section === 'security' && <SecuritySection {...sectionProps} />}
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
