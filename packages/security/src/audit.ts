import { redactObject } from './redaction';

export type AuditAction =
  | 'IMPORT_COLLECTION'
  | 'EXPORT_COLLECTION'
  | 'CREATE_COLLECTION'
  | 'DELETE_COLLECTION'
  | 'EXECUTE_REQUEST'
  | 'EXECUTE_SCRIPT'
  | 'CHANGE_ENVIRONMENT'
  | 'CHANGE_SECURITY_SETTING'
  | 'DELETE_HISTORY'
  | 'EXPORT_SECRETS'
  | 'IMPORT_ENVIRONMENT'
  | 'EXPORT_ENVIRONMENT'
  | 'CREATE_BACKUP'
  | 'RESTORE_BACKUP';

export interface AuditEntry {
  action: AuditAction;
  /** Free-form detail. Always redacted before it is stored. */
  details: Record<string, unknown>;
}

export interface AuditSink {
  append(entry: { action: AuditAction; details: Record<string, unknown>; createdAt: string }): void;
}

/** Writes redacted audit entries to a sink when enabled. Never stores secret values. */
export class AuditLogger {
  constructor(
    private readonly sink: AuditSink,
    private readonly isEnabled: () => boolean,
    private readonly extraPatterns: () => readonly string[] = () => [],
  ) {}

  log(action: AuditAction, details: Record<string, unknown> = {}): void {
    if (!this.isEnabled()) return;
    try {
      this.sink.append({
        action,
        details: redactObject(details, this.extraPatterns()),
        createdAt: new Date().toISOString(),
      });
    } catch {
      /* auditing must not break the operation being audited */
    }
  }
}
