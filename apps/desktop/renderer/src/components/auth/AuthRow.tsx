import type { AuthConfig, AuthParamValue } from '@aegis/core';
import type { ReactNode } from 'react';
import { param } from './authModel';
import { SecretField } from './SecretField';
import { VariableInput } from '../VariableInput';

export function AuthRow({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="au-row">
      <span className="au-label">{label}</span>
      <div className="au-control">
        {children}
        {hint && <div className="field-hint">{hint}</div>}
      </div>
    </div>
  );
}

export interface AuthFieldProps {
  auth: AuthConfig;
  set(key: string, value: AuthParamValue): void;
}

export function TextParam({ auth, set, name, label, hint, placeholder }: AuthFieldProps & { name: string; label: string; hint?: string; placeholder?: string }) {
  return (
    <AuthRow label={label} {...(hint ? { hint } : {})}>
      <VariableInput aria-label={label} value={param(auth, name)} placeholder={placeholder} onChange={(v) => set(name, v)} />
    </AuthRow>
  );
}

export function SecretParam({ auth, set, name, label, hint, multiline }: AuthFieldProps & { name: string; label: string; hint?: string; multiline?: boolean }) {
  return (
    <AuthRow label={label} {...(hint ? { hint } : {})}>
      <SecretField label={label} value={param(auth, name)} onChange={(v) => set(name, v)} {...(multiline ? { multiline } : {})} />
    </AuthRow>
  );
}

export function SelectParam({ auth, set, name, label, options, fallback, hint }: AuthFieldProps & { name: string; label: string; options: Array<{ value: string; label: string }>; fallback: string; hint?: string }) {
  return (
    <AuthRow label={label} {...(hint ? { hint } : {})}>
      <select aria-label={label} value={param(auth, name, fallback)} onChange={(e) => set(name, e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </AuthRow>
  );
}
