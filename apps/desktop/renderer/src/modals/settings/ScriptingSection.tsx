import { buildPatch, maxScriptTimeout } from '../../lib/settings-helpers';
import { NumberField, SettingsGroup, type SectionProps } from './common';

export function ScriptingSection({ settings, info, save }: SectionProps) {
  const cap = maxScriptTimeout(info?.policy);
  return (
    <SettingsGroup title="Scripting" description="Pre-request and test scripts run in an isolated sandbox without access to the file system or network, except through pm.sendRequest.">
      <NumberField
        label="Script timeout"
        unit="ms"
        value={settings.scripting.timeoutMs}
        min={100}
        max={cap}
        hint={`Your organization caps the script timeout at ${cap.toLocaleString('en-US')} ms.`}
        onCommit={(v) => void save(buildPatch(['scripting', 'timeoutMs'], v))}
      />
      <NumberField label="Script memory limit" unit="MB" value={settings.scripting.memoryLimitMb} min={8} max={1024} onCommit={(v) => void save(buildPatch(['scripting', 'memoryLimitMb'], v))} />
    </SettingsGroup>
  );
}
