import type { ImportPreview, ImportProgress, ImportSeverity, ImportStage, ImportWarningModel } from '@aegis/core';
import { formatCount, truncate } from './ui-format';

export const IMPORT_STAGES: readonly ImportStage[] = ['Parsing', 'Validating', 'Importing', 'Saving', 'Finalizing'];

export type WarningCounts = Record<ImportSeverity, number>;

const SEVERITY_ORDER: Record<ImportSeverity, number> = { ERROR: 0, WARNING: 1, INFO: 2 };

/** Count warnings per severity. */
export function countWarnings(warnings: ImportWarningModel[]): WarningCounts {
  const counts: WarningCounts = { ERROR: 0, WARNING: 0, INFO: 0 };
  for (const w of warnings) counts[w.severity] += 1;
  return counts;
}

/** Filter by severity (`ALL` keeps everything) and order ERROR, WARNING, INFO (stable within a severity). */
export function filterWarnings(warnings: ImportWarningModel[], severity: ImportSeverity | 'ALL'): ImportWarningModel[] {
  const list = severity === 'ALL' ? warnings.slice() : warnings.filter((w) => w.severity === severity);
  return list
    .map((w, i) => ({ w, i }))
    .sort((a, b) => SEVERITY_ORDER[a.w.severity] - SEVERITY_ORDER[b.w.severity] || a.i - b.i)
    .map((x) => x.w);
}

/** One-line description of the counts, e.g. "2 errors, 5 warnings, 1 info"; "none" when empty. */
export function describeCounts(counts: WarningCounts): string {
  const parts: string[] = [];
  if (counts.ERROR) parts.push(`${formatCount(counts.ERROR)} ${counts.ERROR === 1 ? 'error' : 'errors'}`);
  if (counts.WARNING) parts.push(`${formatCount(counts.WARNING)} ${counts.WARNING === 1 ? 'warning' : 'warnings'}`);
  if (counts.INFO) parts.push(`${formatCount(counts.INFO)} info`);
  return parts.length ? parts.join(', ') : 'none';
}

export function previewTitleLabel(kind: ImportPreview['kind']): string {
  switch (kind) {
    case 'postman-collection':
      return 'Collection';
    case 'postman-environment':
      return 'Environment';
    case 'postman-globals':
      return 'Globals';
    case 'aegis-backup':
      return 'Backup';
    case 'aegis-workspace':
      return 'Workspace';
  }
}

/** The fixed-form preview lines: "Collection: <name>", Folders, Requests, Variables, Scripts, Examples. */
export function previewSummaryLines(preview: Pick<ImportPreview, 'kind' | 'name' | 'stats'>): string[] {
  const { stats } = preview;
  return [
    `${previewTitleLabel(preview.kind)}: ${preview.name}`,
    `Folders: ${formatCount(stats.folders)}`,
    `Requests: ${formatCount(stats.requests)}`,
    `Variables: ${formatCount(stats.variables)}`,
    `Scripts: ${formatCount(stats.scripts)}`,
    `Examples: ${formatCount(stats.examples)}`,
  ];
}

export interface ProgressView {
  stage: ImportStage;
  /** 1-based index of the stage. */
  stageNumber: number;
  stageCount: number;
  /** 0-100 for the current stage. */
  percent: number;
  /** e.g. "1,250 / 5,000 requests" (empty when the stage has no countable total). */
  counter: string;
}

export function progressView(p: ImportProgress): ProgressView {
  const idx = Math.max(0, IMPORT_STAGES.indexOf(p.stage));
  const unit = p.stage === 'Importing' || p.stage === 'Saving' ? 'requests' : 'items';
  const total = Math.max(0, p.total);
  const current = Math.min(Math.max(0, p.current), total || Math.max(0, p.current));
  const percent = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;
  return {
    stage: p.stage,
    stageNumber: idx + 1,
    stageCount: IMPORT_STAGES.length,
    percent,
    counter: total > 0 ? `${formatCount(current)} / ${formatCount(total)} ${unit}` : '',
  };
}

/** Pull `ImportWarningModel[]` out of an ApiError `details` bag (IMPORT_INVALID carries `details.warnings`). */
export function warningsFromDetails(details: Record<string, unknown> | undefined): ImportWarningModel[] {
  const raw = details?.warnings;
  if (!Array.isArray(raw)) return [];
  const out: ImportWarningModel[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const r = item as Record<string, unknown>;
    const severity = r.severity === 'ERROR' || r.severity === 'WARNING' || r.severity === 'INFO' ? r.severity : 'ERROR';
    out.push({
      severity,
      path: typeof r.path === 'string' ? r.path : '',
      message: typeof r.message === 'string' ? r.message : String(r.message ?? ''),
      ...(typeof r.sourceValue === 'string' ? { sourceValue: r.sourceValue } : {}),
    });
  }
  return out;
}

/** Truncated, single-line rendering of the offending source value. */
export function sourceValueExcerpt(w: ImportWarningModel, max = 120): string {
  if (!w.sourceValue) return '';
  return truncate(w.sourceValue.replace(/\s+/g, ' ').trim(), max);
}
