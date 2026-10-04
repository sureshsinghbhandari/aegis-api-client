import { describe, expect, it } from 'vitest';
import type { ImportWarningModel } from '@aegis/core';
import { countWarnings, describeCounts, filterWarnings, previewSummaryLines, progressView, sourceValueExcerpt, warningsFromDetails } from '../../apps/desktop/renderer/src/lib/import-helpers';
import { validateBackupPassphrase, describeBackupSecrets } from '../../apps/desktop/renderer/src/lib/backup-helpers';

const w = (severity: ImportWarningModel['severity'], message: string, extra: Partial<ImportWarningModel> = {}): ImportWarningModel => ({ severity, path: `item[0].${message}`, message, ...extra });

describe('import warnings', () => {
  const list = [w('INFO', 'i1'), w('ERROR', 'e1'), w('WARNING', 'w1'), w('INFO', 'i2'), w('WARNING', 'w2')];

  it('counts per severity', () => {
    expect(countWarnings(list)).toEqual({ ERROR: 1, WARNING: 2, INFO: 2 });
    expect(describeCounts({ ERROR: 1, WARNING: 2, INFO: 2 })).toBe('1 error, 2 warnings, 2 info');
    expect(describeCounts({ ERROR: 0, WARNING: 0, INFO: 0 })).toBe('none');
  });
  it('filters and orders by severity, stable within a severity', () => {
    expect(filterWarnings(list, 'ALL').map((x) => x.message)).toEqual(['e1', 'w1', 'w2', 'i1', 'i2']);
    expect(filterWarnings(list, 'WARNING').map((x) => x.message)).toEqual(['w1', 'w2']);
  });
  it('excerpts long source values on a single line', () => {
    const text = sourceValueExcerpt(w('INFO', 'x', { sourceValue: `line1\n   line2 ${'z'.repeat(300)}` }), 40);
    expect(text.length).toBe(40);
    expect(text).not.toContain('\n');
    expect(sourceValueExcerpt(w('INFO', 'y'))).toBe('');
  });
  it('reads warnings from error details defensively', () => {
    expect(warningsFromDetails(undefined)).toEqual([]);
    expect(warningsFromDetails({ warnings: 'nope' })).toEqual([]);
    const parsed = warningsFromDetails({ warnings: [{ severity: 'WARNING', path: 'a', message: 'm', sourceValue: 's' }, { message: 5 }, null, 'x'] });
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual({ severity: 'WARNING', path: 'a', message: 'm', sourceValue: 's' });
    expect(parsed[1]?.severity).toBe('ERROR');
  });
});

describe('import preview', () => {
  it('renders the fixed summary form', () => {
    const lines = previewSummaryLines({ kind: 'postman-collection', name: 'Pet Store', stats: { folders: 3, requests: 1250, variables: 4, scripts: 7, examples: 2 } });
    expect(lines).toEqual(['Collection: Pet Store', 'Folders: 3', 'Requests: 1,250', 'Variables: 4', 'Scripts: 7', 'Examples: 2']);
  });
  it('labels other kinds', () => {
    expect(previewSummaryLines({ kind: 'postman-environment', name: 'Prod', stats: { folders: 0, requests: 0, variables: 2, scripts: 0, examples: 0 } })[0]).toBe('Environment: Prod');
    expect(previewSummaryLines({ kind: 'aegis-backup', name: 'b', stats: { folders: 0, requests: 0, variables: 0, scripts: 0, examples: 0 } })[0]).toBe('Backup: b');
  });
});

describe('import progress', () => {
  it('computes counter and percent', () => {
    const v = progressView({ stage: 'Importing', current: 1250, total: 5000 });
    expect(v.counter).toBe('1,250 / 5,000 requests');
    expect(v.percent).toBe(25);
    expect(v.stageNumber).toBe(3);
    expect(v.stageCount).toBe(5);
  });
  it('handles unknown totals and overshoot', () => {
    expect(progressView({ stage: 'Parsing', current: 0, total: 0 })).toMatchObject({ percent: 0, counter: '', stageNumber: 1 });
    expect(progressView({ stage: 'Saving', current: 12, total: 10 }).percent).toBe(100);
  });
});

describe('backup passphrase', () => {
  it('accepts empty, rejects short and mismatching', () => {
    expect(validateBackupPassphrase('', '')).toBeNull();
    expect(validateBackupPassphrase('short', 'short')).toMatch(/at least/);
    expect(validateBackupPassphrase('long-enough-1', 'long-enough-2')).toMatch(/do not match/);
    expect(validateBackupPassphrase('long-enough-1', 'long-enough-1')).toBeNull();
  });
  it('explains secret handling', () => {
    expect(describeBackupSecrets('', true)).toMatch(/NOT included/);
    expect(describeBackupSecrets('passphrase1', false)).toMatch(/policy/);
    expect(describeBackupSecrets('passphrase1', true)).toMatch(/encrypted/);
  });
});
