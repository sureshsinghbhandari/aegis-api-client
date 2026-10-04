import { AppError } from '@aegis/core';
import { bool, emptyResult, str, type AuthProvider } from './types';

export const noneProvider: AuthProvider = {
  type: 'none',
  apply: () => emptyResult(),
};

export const basicProvider: AuthProvider = {
  type: 'basic',
  apply(params) {
    const username = str(params, 'username');
    const password = str(params, 'password');
    const result = emptyResult();
    if (!username && !password) return result;
    const token = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
    result.headers.push({ name: 'Authorization', value: `Basic ${token}` });
    return result;
  },
};

export const bearerProvider: AuthProvider = {
  type: 'bearer',
  apply(params) {
    const token = str(params, 'token').trim();
    const result = emptyResult();
    if (token) result.headers.push({ name: 'Authorization', value: `Bearer ${token}` });
    return result;
  },
};

export const apiKeyProvider: AuthProvider = {
  type: 'apikey',
  apply(params) {
    const key = str(params, 'key').trim();
    const value = str(params, 'value');
    const result = emptyResult();
    if (!key) return result;
    const location = str(params, 'in', 'header').toLowerCase();
    if (location === 'query' || location === 'queryparams') result.query.push({ name: key, value });
    else result.headers.push({ name: key, value });
    return result;
  },
};

/** Types that are preserved on import but cannot be executed by this version. */
export function unsupportedProvider(type: string): AuthProvider {
  return {
    type,
    apply() {
      throw new AppError('AUTH_FAILED', `Authentication type "${type}" is preserved for round-trip export but cannot be executed by this version.`, { type });
    },
  };
}

export { bool };
