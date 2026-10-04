/** Pure formatting helpers (no React/DOM) shared by the panels and modals owned by UI-B. */

/** "just now", "5 min ago", "3 h ago", "2 d ago", or an ISO date for older entries. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const diff = Math.max(0, now - then);
  const sec = Math.floor(diff / 1000);
  if (sec < 45) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${Math.max(1, min)} min ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} d ago`;
  return new Date(then).toISOString().slice(0, 10);
}

export function truncate(text: string, max: number): string {
  if (max < 2 || text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

/** Thousands separators using a fixed locale so output is stable. */
export function formatCount(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/** Dotted placeholder used wherever a secret would otherwise be shown. */
export const MASK = '••••••••';

/** True for references the backend uses in place of secret values. */
export function isSecretRef(value: string | undefined | null): boolean {
  return typeof value === 'string' && value.startsWith('secretref:');
}

export function pluralize(n: number, one: string, many = `${one}s`): string {
  return `${formatCount(n)} ${n === 1 ? one : many}`;
}
