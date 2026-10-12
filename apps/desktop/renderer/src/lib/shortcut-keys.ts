/** Pure key → action mapping for the global shortcuts (no DOM, unit tested). */
export type ShortcutAction = 'send' | 'save' | 'close-tab' | 'new-tab' | 'reopen-tab' | 'next-tab' | 'prev-tab' | 'find-replace' | 'search' | 'console';

export function shortcutAction(e: { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): ShortcutAction | null {
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return null;
  const key = e.key.toLowerCase();
  if (key === 'tab') return e.shiftKey ? 'prev-tab' : 'next-tab';
  if (key === 'f' && e.shiftKey) return 'find-replace';
  if (key === 'enter') return 'send';
  if (key === 's') return 'save';
  if (key === 'w') return 'close-tab';
  if (key === 't') return e.shiftKey ? 'reopen-tab' : 'new-tab';
  if (key === 'k') return 'search';
  if (key === '`') return 'console';
  return null;
}
