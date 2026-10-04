import type { AuthConfig } from '@aegis/core';

export type AuthSource = { level: 'request' } | { level: 'folder'; folderId: string; name: string } | { level: 'collection' } | { level: 'none' };

export interface EffectiveAuth {
  auth: AuthConfig;
  source: AuthSource;
}

export interface AuthLevel {
  auth: AuthConfig;
  folderId?: string;
  name?: string;
}

/**
 * Resolve inherited authentication: request overrides folder (innermost
 * first), which overrides collection. `inherit` defers to the next level.
 * An explicit `none` stops inheritance.
 */
export function resolveEffectiveAuth(request: AuthConfig, folderChainInnermostFirst: readonly AuthLevel[], collection: AuthConfig): EffectiveAuth {
  if (request.type !== 'inherit') return { auth: request, source: { level: 'request' } };
  for (const f of folderChainInnermostFirst) {
    if (f.auth.type !== 'inherit') return { auth: f.auth, source: { level: 'folder', folderId: f.folderId ?? '', name: f.name ?? '' } };
  }
  if (collection.type !== 'inherit') return { auth: collection, source: { level: 'collection' } };
  return { auth: { type: 'none', params: {} }, source: { level: 'none' } };
}
