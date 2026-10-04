import type { HistoryRetention } from '@aegis/core';
import { api, errorMessage } from '../../lib/api';
import { RETENTION_OPTIONS, buildPatch } from '../../lib/settings-helpers';
import { Button, Checkbox, Field } from '../../components/ui';
import { useApp } from '../../store/app';
import { useUi } from '../../store/ui';
import { SettingsGroup, type SectionProps } from './common';

export function HistorySection({ settings, save }: SectionProps) {
  const h = settings.history;
  const clear = async () => {
    const workspaceId = useApp.getState().workspaceId;
    if (!workspaceId) return;
    const ok = await useUi.getState().confirm({ title: 'Clear history', message: 'Permanently delete the request history of the current workspace? Collections and environments are not affected.', confirmLabel: 'Clear history', danger: true });
    if (!ok) return;
    try {
      const n = await api.history.clear({ workspaceId });
      useApp.getState().bumpHistory();
      useApp.getState().toast(`History cleared (${n} entries)`, 'success');
    } catch (e) {
      useApp.getState().toast(errorMessage(e), 'error');
    }
  };
  return (
    <>
      <SettingsGroup title="History & privacy" description="Privacy-conscious defaults: the history keeps only metadata (method, URL, status, timing). Request and response bodies, which may contain personal data or secrets, are NOT stored unless you opt in below.">
        <div className="set-stack">
          <Checkbox checked={h.enabled} onChange={(v) => void save(buildPatch(['history', 'enabled'], v))} label="Keep a request history" />
          <Checkbox checked={h.storeRequestBodies} disabled={!h.enabled} onChange={(v) => void save(buildPatch(['history', 'storeRequestBodies'], v))} label="Store request bodies" />
          <Checkbox checked={h.storeResponseBodies} disabled={!h.enabled} onChange={(v) => void save(buildPatch(['history', 'storeResponseBodies'], v))} label="Store response bodies" />
        </div>
        {(h.storeRequestBodies || h.storeResponseBodies) && <p className="field-hint field-warn">Stored bodies stay on this computer but may contain sensitive data. Known secret patterns are redacted, but redaction cannot be perfect.</p>}
        <Field label="Keep history for">
          <select value={h.retention} disabled={!h.enabled} onChange={(e) => void save(buildPatch(['history', 'retention'], e.target.value as HistoryRetention))}>
            {RETENTION_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
      </SettingsGroup>
      <SettingsGroup title="Clear stored history">
        <Button variant="danger" onClick={() => void clear()}>
          Clear history of this workspace…
        </Button>
      </SettingsGroup>
    </>
  );
}
