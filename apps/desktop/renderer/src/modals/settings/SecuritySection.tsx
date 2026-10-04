import { useState } from 'react';
import { buildPatch, policySummary, validateRegexSource } from '../../lib/settings-helpers';
import { Badge, Button, Checkbox } from '../../components/ui';
import { AuditLog } from './AuditLog';
import { SettingsGroup, type SectionProps } from './common';

export function SecuritySection({ settings, info, save }: SectionProps) {
  const s = settings.security;
  const policy = info?.policy;
  const [pattern, setPattern] = useState('');
  const patternError = pattern === '' ? null : validateRegexSource(pattern);

  const addPattern = async () => {
    const p = pattern.trim();
    if (!p || validateRegexSource(p) || s.redactionPatterns.includes(p)) return;
    if (await save(buildPatch(['security', 'redactionPatterns'], [...s.redactionPatterns, p]))) setPattern('');
  };

  return (
    <>
      <SettingsGroup title="Local-only mode" description="Aegis API Client contains no telemetry, analytics, cloud sync or crash reporting. The only network traffic is the requests you send yourself.">
        <Checkbox
          checked={s.localOnly || (policy?.enforceLocalOnly ?? false)}
          disabled={policy?.enforceLocalOnly ?? false}
          onChange={(v) => void save(buildPatch(['security', 'localOnly'], v))}
          label="Local-only mode (never contact anything except the APIs you call)"
        />
        {policy?.enforceLocalOnly && <p className="field-hint">Enforced by your organization.</p>}
        {!s.localOnly && !policy?.enforceLocalOnly && <p className="field-hint field-warn">Local-only mode is off. No optional network features exist in this version, but future features may use the network when this is off.</p>}
      </SettingsGroup>

      <SettingsGroup title="Redaction patterns" description="Values matching these patterns (case-insensitive regular expressions) are masked in the console, history and logs, in addition to the built-in secret patterns.">
        {s.redactionPatterns.length === 0 ? (
          <p className="field-hint">No custom patterns.</p>
        ) : (
          <ul className="pat-list">
            {s.redactionPatterns.map((p) => (
              <li key={p}>
                <code className="mono">{p}</code>
                <Button size="sm" variant="ghost" aria-label={`Remove pattern ${p}`} onClick={() => void save(buildPatch(['security', 'redactionPatterns'], s.redactionPatterns.filter((x) => x !== p)))}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div className="set-row">
          <input aria-label="New redaction pattern" className="mono" value={pattern} placeholder="e.g. internal-token-[a-z0-9]+" spellCheck={false} onChange={(e) => setPattern(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void addPattern()} aria-invalid={patternError !== null} />
          <Button size="sm" variant="primary" disabled={!pattern.trim() || patternError !== null} onClick={() => void addPattern()}>
            Add pattern
          </Button>
        </div>
        {patternError && <p className="field-hint field-err">Invalid regular expression: {patternError}</p>}
      </SettingsGroup>

      <SettingsGroup title="Audit log" description="A local record of security-relevant actions (revealing secrets, exporting, changing security settings). It never contains secret values and never leaves this computer.">
        <Checkbox checked={s.auditLogEnabled} onChange={(v) => void save(buildPatch(['security', 'auditLogEnabled'], v))} label="Record security-relevant actions" />
        <AuditLog />
      </SettingsGroup>

      <SettingsGroup title="Developer mode">
        <Checkbox checked={s.developerMode} onChange={(v) => void save(buildPatch(['security', 'developerMode'], v))} label="Enable developer mode (extra diagnostics)" />
        <p className="field-hint">Diagnostics still never include secret values.</p>
      </SettingsGroup>

      <SettingsGroup title="Secret storage">
        {info ? (
          <p>
            {info.secretStorageAvailable ? <Badge tone="success">Available</Badge> : <Badge tone="danger">Unavailable</Badge>} {info.secretStorage}
          </p>
        ) : (
          <p className="field-hint">Status unavailable.</p>
        )}
        {info && !info.secretStorageAvailable && <p className="field-hint field-warn">Secrets cannot be stored securely on this system. Saving secret variables or credentials will fail rather than store them in plain text.</p>}
      </SettingsGroup>

      <SettingsGroup title="Organization policy" description="Read-only. Values marked as enforced are set by your administrator and cannot be changed here.">
        {policy ? (
          <table className="tbl">
            <tbody>
              {policySummary(policy).map((l) => (
                <tr key={l.label}>
                  <td>{l.label}</td>
                  <td>{l.value}</td>
                  <td>{l.enforced ? <Badge tone="warning">enforced</Badge> : <Badge>user choice</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="field-hint">Policy unavailable.</p>
        )}
      </SettingsGroup>
    </>
  );
}
