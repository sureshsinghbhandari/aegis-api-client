import { ApiError } from './api';
import { useUi } from '../store/ui';

/**
 * Run an API call that may be refused with CONFIRMATION_REQUIRED (production environment + enterprise policy).
 * On that error the user is asked to confirm; when they agree the call is retried with `confirmProduction: true`.
 * Resolves `undefined` when the user declines. Other errors propagate.
 */
export async function withProductionConfirm<T>(run: (confirmProduction: boolean) => Promise<T>, what = 'send this request'): Promise<T | undefined> {
  try {
    return await run(false);
  } catch (e) {
    if (e instanceof ApiError && e.code === 'CONFIRMATION_REQUIRED') {
      const ok = await useUi.getState().confirm({
        title: 'Production environment',
        message: `${e.message}\n\nThe active environment is marked as PRODUCTION. Do you really want to ${what}?`,
        confirmLabel: 'Yes, continue',
        danger: true,
      });
      if (!ok) return undefined;
      return run(true);
    }
    throw e;
  }
}
