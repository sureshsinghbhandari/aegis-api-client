import { AppError, type AuthConfig } from '@aegis/core';
import { asapProvider } from './asap';
import { digestProvider } from './digest';
import { edgeGridProvider } from './edgegrid';
import { hawkProvider } from './hawk';
import { jwtProvider } from './jwt';
import { oauth1Provider } from './oauth1';
import { oauth2Provider } from './oauth2';
import { awsV4Provider } from './sigv4';
import { apiKeyProvider, basicProvider, bearerProvider, noneProvider, unsupportedProvider } from './simple';
import type { AuthContext, AuthProvider, AuthResult } from './types';
import { emptyResult } from './types';

/** Registry of authentication providers; `custom` providers can be added at runtime. */
export class AuthRegistry {
  private readonly providers = new Map<string, AuthProvider>();

  constructor(builtins: AuthProvider[] = []) {
    for (const p of builtins) this.register(p);
  }

  register(provider: AuthProvider): this {
    this.providers.set(provider.type, provider);
    return this;
  }

  has(type: string): boolean {
    return this.providers.has(type);
  }

  /** Apply the auth config. `custom` configs delegate to the provider named by `params.providerId`. */
  async apply(auth: AuthConfig, context: AuthContext): Promise<AuthResult> {
    if (auth.type === 'inherit') return emptyResult();
    if (auth.type === 'custom') {
      const id = String(auth.params.providerId ?? '');
      const provider = this.providers.get(id) ?? unsupportedProvider(id || 'custom');
      return provider.apply(auth.params, context);
    }
    const provider = this.providers.get(auth.type);
    if (!provider) throw new AppError('AUTH_FAILED', `Unknown authentication type "${auth.type}".`, { type: auth.type });
    return provider.apply(auth.params, context);
  }
}

export function createDefaultAuthRegistry(): AuthRegistry {
  return new AuthRegistry([
    noneProvider,
    basicProvider,
    bearerProvider,
    apiKeyProvider,
    oauth2Provider,
    oauth1Provider,
    jwtProvider,
    awsV4Provider,
    // Postman "custom" providers (`type: 'custom'`, `params.providerId`): executable since this version.
    digestProvider,
    hawkProvider,
    edgeGridProvider,
    asapProvider,
  ]);
}
