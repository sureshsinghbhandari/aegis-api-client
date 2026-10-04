import type { HeaderPair } from '@aegis/core';

export const REDACTED = '[REDACTED]';

/**
 * Key names (HTTP headers, JSON properties, query params, form fields) whose
 * values are always considered sensitive. Matching is case-insensitive and
 * ignores `-`/`_` differences.
 */
export const SENSITIVE_KEY_PATTERNS: RegExp[] = [
  /^authorization$/i,
  /^proxy-?authorization$/i,
  /^cookie$/i,
  /^set-?cookie$/i,
  /pass(word|wd|phrase)?$/i,
  /secret/i,
  /^(access|refresh|id|session|auth|bearer|csrf|xsrf)[-_]?token$/i,
  /^token$/i,
  /api[-_]?key$/i,
  /^x-api-key$/i,
  /private[-_]?key/i,
  /^client[-_]?secret$/i,
  /^signature$/i,
  /^x-amz-security-token$/i,
  /^credentials?$/i,
];

function compileExtra(patterns: readonly string[] | undefined): RegExp[] {
  if (!patterns) return [];
  const out: RegExp[] = [];
  for (const p of patterns) {
    try {
      out.push(new RegExp(p, 'i'));
    } catch {
      /* ignore invalid user pattern */
    }
  }
  return out;
}

export function isSensitiveKey(key: string, extraPatterns?: readonly string[]): boolean {
  const k = key.trim();
  if (!k) return false;
  return SENSITIVE_KEY_PATTERNS.some((r) => r.test(k)) || compileExtra(extraPatterns).some((r) => r.test(k));
}

export function redactHeaders(headers: readonly HeaderPair[], extraPatterns?: readonly string[]): HeaderPair[] {
  return headers.map((h) => (isSensitiveKey(h.name, extraPatterns) ? { name: h.name, value: REDACTED } : { ...h }));
}

/** Deep-clone `value` replacing the values of sensitive keys. Cycle-safe, depth-limited. */
export function redactObject<T>(value: T, extraPatterns?: readonly string[]): T {
  const extra = compileExtra(extraPatterns);
  const seen = new WeakSet<object>();
  const walk = (v: unknown, depth: number): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (depth > 20) return '[Truncated]';
    if (seen.has(v as object)) return '[Circular]';
    seen.add(v as object);
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (isSensitiveKey(k) || extra.some((r) => r.test(k))) out[k] = val === undefined || val === '' ? val : REDACTED;
      else out[k] = walk(val, depth + 1);
    }
    return out;
  };
  return walk(value, 0) as T;
}

/** Mask sensitive query parameters and the password portion of userinfo in a URL string. */
export function redactUrl(url: string, extraPatterns?: readonly string[]): string {
  const qIndex = url.indexOf('?');
  let base = qIndex === -1 ? url : url.slice(0, qIndex);
  const rest = qIndex === -1 ? '' : url.slice(qIndex + 1);
  base = base.replace(/^([a-z][a-z0-9+.-]*:\/\/)([^/@\s:]*):([^/@\s]*)@/i, `$1$2:${REDACTED}@`);
  if (!rest) return base;
  const hashIndex = rest.indexOf('#');
  const query = hashIndex === -1 ? rest : rest.slice(0, hashIndex);
  const hash = hashIndex === -1 ? '' : rest.slice(hashIndex);
  const masked = query
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      if (eq === -1) return pair;
      const rawKey = pair.slice(0, eq);
      let key = rawKey;
      try {
        key = decodeURIComponent(rawKey);
      } catch {
        /* keep raw */
      }
      return isSensitiveKey(key, extraPatterns) ? `${rawKey}=${REDACTED}` : pair;
    })
    .join('&');
  return `${base}?${masked}${hash}`;
}

/**
 * Redact free text: exact secret values, `Bearer`/`Basic` credentials, and
 * `key=value` / `"key": "value"` pairs with sensitive keys.
 */
export function redactText(text: string, secretValues: readonly string[] = [], extraPatterns?: readonly string[]): string {
  let out = text;
  for (const secret of secretValues) {
    if (secret && secret.length >= 3) out = out.split(secret).join(REDACTED);
  }
  out = out.replace(/\b(Bearer|Basic|Digest)\s+[A-Za-z0-9._~+/=-]{6,}/gi, `$1 ${REDACTED}`);
  // "key": "value"  and  key=value  and  key: value
  const keyAlternatives =
    'authorization|cookie|set-cookie|password|passwd|client_secret|client-secret|access_token|refresh_token|id_token|api[_-]?key|private[_-]?key|secret|token';
  out = out.replace(
    new RegExp(`(["']?(?:${keyAlternatives})["']?\\s*[:=]\\s*)(["'])(.*?)\\2`, 'gi'),
    (_m, prefix: string, quote: string) => `${prefix}${quote}${REDACTED}${quote}`,
  );
  out = out.replace(
    new RegExp(`(\\b(?:${keyAlternatives})\\s*[=:]\\s*)([^\\s"',;&]+)`, 'gi'),
    (_m, prefix: string) => `${prefix}${REDACTED}`,
  );
  for (const re of compileExtra(extraPatterns)) {
    out = out.replace(new RegExp(re.source, 'gi'), REDACTED);
  }
  return out;
}
