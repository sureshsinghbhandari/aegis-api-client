import type { ThemePreference } from '@aegis/core';
import { buildPatch } from '../../lib/settings-helpers';
import { SettingsGroup, type SectionProps } from './common';

const THEMES: Array<{ value: ThemePreference; label: string; hint: string }> = [
  { value: 'system', label: 'System', hint: 'Follow the operating system setting' },
  { value: 'dark', label: 'Dark', hint: 'Dark colors' },
  { value: 'light', label: 'Light', hint: 'Light colors' },
];

export function GeneralSection({ settings, save }: SectionProps) {
  return (
    <SettingsGroup title="Appearance">
      <fieldset className="imp-kinds">
        <legend className="field-label">Theme</legend>
        {THEMES.map((t) => (
          <label key={t.value} className="imp-kind">
            <input type="radio" name="theme" checked={settings.appearance.theme === t.value} onChange={() => void save(buildPatch(['appearance', 'theme'], t.value))} />
            <span>
              <strong>{t.label}</strong>
              <span className="field-hint">{t.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
    </SettingsGroup>
  );
}
