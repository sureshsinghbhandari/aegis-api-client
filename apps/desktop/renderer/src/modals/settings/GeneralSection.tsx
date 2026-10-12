import type { ThemePreference, WorkbenchLayout } from '@aegis/core';
import { buildPatch } from '../../lib/settings-helpers';
import { useApp } from '../../store/app';
import { SettingsGroup, type SectionProps } from './common';
import { WorkingDirectorySection } from './WorkingDirectorySection';

const THEMES: Array<{ value: ThemePreference; label: string; hint: string }> = [
  { value: 'system', label: 'System', hint: 'Follow the operating system setting' },
  { value: 'dark', label: 'Dark', hint: 'Dark colors' },
  { value: 'light', label: 'Light', hint: 'Light colors' },
];

const LAYOUTS: Array<{ value: WorkbenchLayout; label: string; hint: string }> = [
  { value: 'stacked', label: 'Stacked', hint: 'Request above the response (single pane)' },
  { value: 'side-by-side', label: 'Side by side', hint: 'Request on the left, response on the right (two panes)' },
];

export function GeneralSection({ settings, save }: SectionProps) {
  const layout = useApp((s) => s.layout);
  const changeLayout = async (value: WorkbenchLayout) => {
    if (await save(buildPatch(['appearance', 'layout'], value))) useApp.setState({ layout: value });
  };
  return (
    <>
    <WorkingDirectorySection settings={settings} save={save} />
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
    <SettingsGroup title="Layout" description="How the request editor and the response viewer are arranged. Also available from the toggle at the right of the tab bar.">
      <fieldset className="imp-kinds">
        <legend className="field-label">Request / response</legend>
        {LAYOUTS.map((l) => (
          <label key={l.value} className="imp-kind">
            <input type="radio" name="layout" checked={(settings.appearance.layout ?? layout) === l.value} onChange={() => void changeLayout(l.value)} />
            <span>
              <strong>{l.label}</strong>
              <span className="field-hint">{l.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
    </SettingsGroup>
    </>
  );
}
