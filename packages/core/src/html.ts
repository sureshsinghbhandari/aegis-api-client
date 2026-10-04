/**
 * HTML preview hardening. API responses are rendered ONLY inside a sandboxed
 * iframe (`sandbox=""`: no scripts, no same-origin, no forms, no popups) with a
 * `srcdoc` that carries its own restrictive CSP. Defense in depth: the markup is
 * additionally stripped of <script>, event handlers and javascript: URLs.
 */
export const PREVIEW_CSP =
  "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; media-src data: blob:; frame-src 'none'; form-action 'none'; base-uri 'none'";

export function sanitizeHtmlForPreview(html: string): string {
  let out = html;
  out = out.replace(/<\s*(script|iframe|object|embed|applet|base|meta\s+http-equiv)[\s\S]*?(<\/\s*\1\s*>|$)/gi, '');
  out = out.replace(/<\s*(script|iframe|object|embed|applet|base|link)\b[^>]*>/gi, '');
  out = out.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  out = out.replace(/\s(href|src|xlink:href|action|formaction)\s*=\s*("\s*javascript:[^"]*"|'\s*javascript:[^']*'|javascript:[^\s>]+)/gi, '');
  return out;
}

export function buildPreviewDocument(html: string): string {
  const safe = sanitizeHtmlForPreview(html);
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}"></head><body>${safe}</body></html>`;
}
