import type { RequestDraft } from '@aegis/core';
import { useCallback } from 'react';
import { useApp, type OpenTab } from '../store/app';

/** Patch the draft of a tab. The returned function is stable per tab. */
export function useDraftUpdate(tab: OpenTab): (patch: Partial<RequestDraft>) => void {
  const { tabId } = tab;
  return useCallback((patch) => useApp.getState().updateDraft(tabId, patch), [tabId]);
}
