import type { ImportPreview, ImportProgress, ImportSeverity, ImportSourceKind, ImportStage, ImportWarningModel } from '@aegis/core';
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
    case 'openapi':
      return 'OpenAPI';
    case 'swagger':
      return 'Swagger 2.0';
    case 'har':
      return 'HAR';
    case 'insomnia':
      return 'Insomnia';
    case 'postman-v1':
      return 'Collection (v1)';
    case 'postman-dump':
      return 'Postman data dump';
  }
}

/** User-facing import choices. `kind` is sent to the main process; `extensions` drives the file hint. */
export const IMPORT_KINDS: ReadonlyArray<{ id: ImportSourceKind; label: string; hint: string; extensions: string }> = [
  { id: 'auto', label: 'Auto-detect', hint: 'Recognises every supported format from the file content (Postman v1/v2, data dump, OpenAPI/Swagger, HAR, Insomnia, Aegis workspace).', extensions: '.json, .yaml, .har' },
  { id: 'postman-collection', label: 'Postman Collection (v2.0 / v2.1 / v1)', hint: 'A collection exported from Postman or another tool as JSON.', extensions: '.json' },
  { id: 'postman-environment', label: 'Postman Environment / Globals', hint: 'An environment or globals file exported from Postman.', extensions: '.json' },
  { id: 'openapi', label: 'OpenAPI 3.0 / 3.1 or Swagger 2.0 (JSON, YAML)', hint: 'Operations become requests grouped by tag; servers[0] becomes {{baseUrl}}; examples are generated from schemas. $refs are resolved inside the file only.', extensions: '.json, .yaml, .yml' },
  { id: 'har', label: 'HAR 1.2 (HTTP Archive)', hint: 'Recorded browser or proxy traffic. Credentials in Authorization/Cookie headers are not imported.', extensions: '.har, .json' },
  { id: 'insomnia', label: 'Insomnia v4 export', hint: 'Workspaces, folders, requests and environments from an Insomnia export file.', extensions: '.json, .yaml' },
  { id: 'postman-dump', label: 'Postman data dump', hint: 'The "Export data" file from Postman settings: all collections, environments and globals at once.', extensions: '.json' },
  { id: 'aegis-workspace', label: 'Aegis workspace file', hint: 'A file written by Workspace -> Export. It is restored as a new workspace.', extensions: '.aegis-workspace.json' },
  { id: 'backup', label: 'Aegis Backup', hint: 'A backup created with "Backup…". Encrypted backups ask for their passphrase.', extensions: '.json, .aegisbackup' },
];

export function asImportKind(value: unknown): ImportSourceKind {
  return IMPORT_KINDS.some((k) => k.id === value) ? (value as ImportSourceKind) : 'auto';
}

/** Kinds whose result may create a new workspace (the sidebar must refresh its workspace list). */
export function importCreatesWorkspace(kind: ImportPreview['kind']): boolean {
  return kind === 'aegis-backup' || kind === 'aegis-workspace';
}

/** The fixed-form preview lines: "Collection: <name>", Folders, Requests, Variables, Scripts, Examples. */
export function previewSummaryLines(preview: Pick<ImportPreview, 'kind' | 'name' | 'stats' | 'collections' | 'environments'>): string[] {
  const { stats } = preview;
  const multi = preview.collections !== undefined && preview.environments !== undefined ? ` (${formatCount(preview.collections)} collections, ${formatCount(preview.environments)} environments)` : '';
  return [
    `${previewTitleLabel(preview.kind)}: ${preview.name}${multi}`,
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
