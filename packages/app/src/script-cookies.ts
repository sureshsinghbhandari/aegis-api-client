import type { ScriptCookieJarOp, ScriptCookieJarResult } from '@aegis/core';
import { redactUrl } from '@aegis/security';
import type { AppContext } from './context';

/**
 * `ScriptHost.cookieJar` for the request executor: routes `pm.cookies.jar()` operations to the
 * workspace cookie jar, audits every write (`SCRIPT_COOKIE_WRITE`, never values) and reports it in
 * the execution warnings so the user can see that a script changed cookies.
 */
export async function runScriptCookieOp(ctx: AppContext, workspaceId: string, op: ScriptCookieJarOp, warnings: string[]): Promise<ScriptCookieJarResult> {
  const out = await ctx.cookies.scriptOperation(workspaceId, op);
  if (out.changed.length > 0) {
    const names = out.changed.map((c) => `${c.name}@${c.domain}${c.path}`);
    ctx.deps.audit.log('SCRIPT_COOKIE_WRITE', { operation: op.op, url: redactUrl(op.url), cookies: names });
    warnings.push(`Cookies changed by script (${op.op}): ${names.join(', ')}`);
  }
  return { cookies: out.cookies };
}
