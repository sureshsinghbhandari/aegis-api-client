/**
 * Turn a request draft into the display-resolved `SnippetRequest` the generators consume.
 *
 * Secrets never leak by default: a variable flagged secret (or whose value is a
 * `secretref:`) stays as `{{name}}`, secret auth parameters become `{{token}}`-style
 * placeholders, and OAuth2/AWS/JWT/OAuth1 signatures are never computed here (the
 * header is shown with a placeholder plus a note). Pure TS, no Node APIs.
 */
import { AUTH_SECRET_PARAMS, buildRequestUrl, type AuthConfig, type KeyValueEntry, type RawLanguage, type RequestDraft, type ResolvedRequestView } from '@aegis/core';
import { base64Utf8 } from './escape';
import type { SnippetBody, SnippetFormPart, SnippetHeader, SnippetRequest } from './types';

export interface DisplayVariable {
  value: string;
  secret: boolean;
}

export interface PrepareOptions {
  /** Variables visible to the request (already merged by precedence; the caller decides which scope wins). */
  variables?: ReadonlyMap<string, DisplayVariable> | Readonly<Record<string, DisplayVariable>>;
  /** Effective auth to render when the draft inherits (`auth.type === 'inherit'`). */
  effectiveAuth?: AuthConfig;
  /** Label of the scope the effective auth comes from, for the note. */
  inheritedFrom?: string;
  /**
   * Substitute secret values. The caller is responsible for the audit (e.g. `variables.revealSecret`) and
   * for the policy gate; `revealed` maps `secretref:` strings to their plaintext.
   */
  revealSecrets?: boolean;
  revealed?: Readonly<Record<string, string>>;
}

const VAR_PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/g;
const RAW_CONTENT_TYPES: Record<RawLanguage, string> = {
  json: 'application/json',
  xml: 'application/xml',
  text: 'text/plain',
  html: 'text/html',
  javascript: 'application/javascript',
};

export function isSecretRef(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('secretref:');
}

function lookup(vars: PrepareOptions['variables'], name: string): DisplayVariable | undefined {
  if (!vars) return undefined;
  if (vars instanceof Map) return vars.get(name);
  return Object.prototype.hasOwnProperty.call(vars, name) ? (vars as Record<string, DisplayVariable>)[name] : undefined;
}

/** Base name of a path for placeholders; never returns directories. */
export function fileNameOf(path: string | undefined): string {
  if (!path) return 'file.bin';
  const base = path.split(/[\\/]/).filter(Boolean).pop() ?? '';
  return base || 'file.bin';
}

class DisplayResolver {
  readonly secretNames = new Set<string>();
  readonly unresolved = new Set<string>();

  constructor(private readonly options: PrepareOptions) {}

  private valueOf(v: DisplayVariable): string | undefined {
    if (!v.secret) return v.value;
    if (!this.options.revealSecrets) return undefined;
    if (isSecretRef(v.value)) return this.options.revealed?.[v.value];
    return v.value;
  }

  resolve(input: string, depth = 4): string {
    if (!input || !input.includes('{{')) return input;
    return input.replace(VAR_PATTERN, (match, rawName: string) => {
      const name = rawName.trim();
      if (name.startsWith('$')) return match; // dynamic variables are generated at send time
      const hit = lookup(this.options.variables, name);
      if (!hit) {
        this.unresolved.add(name);
        return match;
      }
      const value = this.valueOf(hit);
      if (value === undefined) {
        this.secretNames.add(name);
        return `{{${name}}}`;
      }
      return depth > 0 ? this.resolve(value, depth - 1) : value;
    });
  }

  entries(entries: readonly KeyValueEntry[]): KeyValueEntry[] {
    return entries.filter((e) => e.enabled && e.key !== '').map((e) => ({ ...e, key: this.resolve(e.key), value: this.resolve(e.value) }));
  }

  /** Auth parameter: secret keys are masked unless revealed; `{{vars}}` are resolved like everywhere else. */
  authParam(auth: AuthConfig, key: string, secretKeys: readonly string[]): { text: string; placeholder: boolean } {
    const raw = auth.params[key];
    const value = raw === undefined || raw === null ? '' : String(raw);
    if (!secretKeys.includes(key)) return { text: this.resolve(value), placeholder: false };
    if (value === '') return { text: `{{${key}}}`, placeholder: true };
    if (/^\s*\{\{[^{}]+\}\}\s*$/.test(value)) return { text: this.resolve(value), placeholder: value === this.resolve(value) };
    if (!this.options.revealSecrets) return { text: `{{${key}}}`, placeholder: true };
    if (isSecretRef(value)) {
      const plain = this.options.revealed?.[value];
      return plain === undefined ? { text: `{{${key}}}`, placeholder: true } : { text: plain, placeholder: false };
    }
    return { text: this.resolve(value), placeholder: false };
  }
}

/** Header names/values must not contain line breaks (request splitting); flatten and report. */
function sanitizeHeaders(headers: Array<{ name: string; value: string }>, notes: string[]): SnippetHeader[] {
  const out: SnippetHeader[] = [];
  let flattened = false;
  for (const h of headers) {
    const name = h.name.replace(/[\r\n\u0000-\u001f\u007f\s]+/g, '');
    if (!name) continue;
    const value = h.value.replace(/[\r\n\u0000]+/g, ' ');
    if (value !== h.value || name !== h.name.trim()) flattened = true;
    out.push({ name, value });
  }
  if (flattened) notes.push('Header values containing control characters were flattened; the request engine rejects such headers.');
  return out;
}

function hasHeader(headers: Array<{ name: string; value: string }>, name: string): boolean {
  const lower = name.toLowerCase();
  return headers.some((h) => h.name.toLowerCase() === lower);
}

function renderAuth(auth: AuthConfig, r: DisplayResolver, headers: Array<{ name: string; value: string }>, query: KeyValueEntry[], notes: string[], inheritedFrom?: string): void {
  const type = auth.type;
  const secretKeys = AUTH_SECRET_PARAMS[type === 'custom' ? String(auth.params.providerId ?? 'custom') : type] ?? [];
  const from = inheritedFrom ? ` (inherited from ${inheritedFrom})` : '';
  switch (type) {
    case 'none':
      return;
    case 'inherit':
      notes.push('Authorization is inherited from the collection/folder; it is not included in this snippet.');
      return;
    case 'basic': {
      const user = r.authParam(auth, 'username', secretKeys);
      const pass = r.authParam(auth, 'password', secretKeys);
      if (!user.text && !pass.text) return;
      if (pass.placeholder || user.text.includes('{{') || pass.text.includes('{{')) {
        headers.push({ name: 'Authorization', value: `Basic {{base64(${user.text}:${pass.text})}}` });
        notes.push(`Basic auth${from}: replace the placeholder with base64("username:password").`);
      } else headers.push({ name: 'Authorization', value: `Basic ${base64Utf8(`${user.text}:${pass.text}`)}` });
      return;
    }
    case 'bearer': {
      const token = r.authParam(auth, 'token', secretKeys);
      headers.push({ name: 'Authorization', value: `Bearer ${token.text}` });
      if (token.placeholder) notes.push(`Bearer token${from} is a placeholder; use "Reveal secrets" or paste the token.`);
      return;
    }
    case 'apikey': {
      const key = String(auth.params.key ?? '').trim();
      if (!key) return;
      const value = r.authParam(auth, 'value', secretKeys);
      const where = String(auth.params.in ?? 'header').toLowerCase();
      if (where === 'query' || where === 'queryparams') query.push({ key, value: value.text, enabled: true });
      else headers.push({ name: key, value: value.text });
      if (value.placeholder) notes.push(`API key${from} is a placeholder; use "Reveal secrets" or paste the key.`);
      return;
    }
    case 'oauth2': {
      const token = r.authParam(auth, 'accessToken', secretKeys);
      const prefix = String(auth.params.headerPrefix ?? 'Bearer').trim() || 'Bearer';
      const where = String(auth.params.addTokenTo ?? 'header').toLowerCase();
      const text = token.placeholder ? '{{accessToken}}' : token.text;
      if (where.startsWith('query')) query.push({ key: String(auth.params.queryParamKey ?? 'access_token'), value: text, enabled: true });
      else headers.push({ name: 'Authorization', value: `${prefix} ${text}` });
      notes.push(`OAuth 2.0${from}: the access token is obtained by the client at send time; the snippet shows a placeholder.`);
      return;
    }
    case 'jwt': {
      const prefix = String(auth.params.headerPrefix ?? 'Bearer').trim() || 'Bearer';
      const where = String(auth.params.addTokenTo ?? 'header').toLowerCase();
      if (where.startsWith('query')) query.push({ key: String(auth.params.queryParamKey ?? 'token'), value: '{{jwt}}', enabled: true });
      else headers.push({ name: 'Authorization', value: `${prefix} {{jwt}}` });
      notes.push(`JWT bearer${from}: the token is signed at send time; the snippet shows a placeholder.`);
      return;
    }
    case 'awsv4':
      headers.push({ name: 'Authorization', value: 'AWS4-HMAC-SHA256 {{aws-signature}}' });
      headers.push({ name: 'X-Amz-Date', value: '{{aws-date}}' });
      notes.push(`AWS Signature v4${from}: the signature is computed at send time; the snippet shows placeholders.`);
      return;
    case 'oauth1':
      headers.push({ name: 'Authorization', value: 'OAuth {{oauth1-signature}}' });
      notes.push(`OAuth 1.0${from}: the signature is computed at send time; the snippet shows a placeholder.`);
      return;
    case 'custom': {
      const provider = String(auth.params.providerId ?? 'custom');
      headers.push({ name: 'Authorization', value: `{{${provider}-authorization}}` });
      notes.push(`Authentication type "${provider}"${from} is applied at send time; the snippet shows a placeholder.`);
      return;
    }
    default:
      return;
  }
}

function graphqlJson(query: string, variables: string, operationName: string | undefined): string {
  let vars: unknown = undefined;
  if (variables.trim()) {
    try {
      vars = JSON.parse(variables);
    } catch {
      vars = variables; // invalid JSON is sent as a string so the problem is visible
    }
  }
  const payload: Record<string, unknown> = { query };
  if (vars !== undefined) payload.variables = vars;
  if (operationName) payload.operationName = operationName;
  return JSON.stringify(payload, null, 2);
}

function buildBody(draft: RequestDraft, r: DisplayResolver, headers: Array<{ name: string; value: string }>, notes: string[]): SnippetBody {
  const body = draft.body;
  const explicit = headers.find((h) => h.name.toLowerCase() === 'content-type')?.value;
  switch (body.mode) {
    case 'raw': {
      const contentType = explicit ?? body.contentType ?? RAW_CONTENT_TYPES[body.rawLanguage ?? 'text'];
      if (!explicit) headers.push({ name: 'Content-Type', value: contentType });
      return { kind: 'text', text: r.resolve(body.raw ?? ''), contentType };
    }
    case 'graphql': {
      const contentType = explicit ?? body.contentType ?? 'application/json';
      if (!explicit) headers.push({ name: 'Content-Type', value: contentType });
      const g = body.graphql ?? { query: '', variables: '' };
      return { kind: 'text', text: graphqlJson(r.resolve(g.query), r.resolve(g.variables), g.operationName ? r.resolve(g.operationName) : undefined), contentType };
    }
    case 'urlencoded': {
      if (!explicit) headers.push({ name: 'Content-Type', value: 'application/x-www-form-urlencoded' });
      return { kind: 'urlencoded', entries: r.entries(body.urlencoded ?? []).map((e) => ({ name: e.key, value: e.value })) };
    }
    case 'formdata': {
      const parts: SnippetFormPart[] = [];
      for (const f of body.formData ?? []) {
        if (!f.enabled || f.key === '') continue;
        const name = r.resolve(f.key);
        if (f.type === 'file') {
          parts.push({ name, value: fileNameOf(f.filePath), file: true, ...(f.contentType ? { contentType: f.contentType } : {}) });
          continue;
        }
        if (f.type === 'variable') {
          parts.push({ name, value: r.resolve(`{{${f.value.trim()}}}`), file: false, ...(f.contentType ? { contentType: f.contentType } : {}) });
          continue;
        }
        parts.push({ name, value: r.resolve(f.value), file: false, ...(f.contentType ? { contentType: f.contentType } : {}) });
      }
      if (parts.some((p) => p.file)) notes.push('File parts show the file name only; point the snippet at the file on your machine.');
      return { kind: 'multipart', parts };
    }
    case 'binary': {
      const contentType = explicit ?? body.contentType ?? 'application/octet-stream';
      if (!explicit) headers.push({ name: 'Content-Type', value: contentType });
      notes.push('Binary body: the snippet reads the file by name; adjust the path on your machine.');
      return { kind: 'file', fileName: fileNameOf(body.filePath), contentType };
    }
    default:
      return { kind: 'none' };
  }
}

/** Resolve a draft for display and render auth as headers/placeholders. The draft is never mutated. */
export function prepareSnippetRequest(draft: RequestDraft, options: PrepareOptions = {}): SnippetRequest {
  const r = new DisplayResolver(options);
  const notes: string[] = [];
  const headers: Array<{ name: string; value: string }> = r.entries(draft.headers).map((h) => ({ name: h.key.trim(), value: h.value }));
  const query = r.entries(draft.queryParams);
  const pathVariables = r.entries(draft.pathVariables);

  const auth = draft.auth.type === 'inherit' && options.effectiveAuth ? options.effectiveAuth : draft.auth;
  const inheritedFrom = draft.auth.type === 'inherit' && options.effectiveAuth ? (options.inheritedFrom ?? 'parent') : undefined;
  if (!hasHeader(headers, 'authorization') || auth.type === 'apikey') renderAuth(auth, r, headers, query, notes, inheritedFrom);
  else if (auth.type !== 'none' && auth.type !== 'inherit') notes.push('An explicit Authorization header is present; the auth configuration was not rendered.');

  const body = buildBody(draft, r, headers, notes);
  const url = buildRequestUrl(r.resolve(draft.url), query, pathVariables);

  if (r.secretNames.size) notes.push(`Secret variables are placeholders: ${[...r.secretNames].map((n) => `{{${n}}}`).join(', ')}.`);
  if (r.unresolved.size) notes.push(`Unresolved variables: ${[...r.unresolved].map((n) => `{{${n}}}`).join(', ')}.`);

  return { method: (draft.method.trim().toUpperCase() || 'GET').replace(/[^A-Z0-9_-]/g, ''), url, headers: sanitizeHeaders(headers, notes), body, notes };
}

/** "Copy as sent": build the snippet input from the redacted request view of the last execution. */
export function snippetRequestFromSent(sent: ResolvedRequestView): SnippetRequest {
  const notes = ['Generated from the last request as sent (variables resolved); sensitive values were redacted by the application.'];
  const headers = sanitizeHeaders(sent.headers.map((h) => ({ name: h.name, value: h.value })), notes);
  const contentType = headers.find((h) => h.name.toLowerCase() === 'content-type')?.value ?? 'text/plain';
  const body: SnippetBody = sent.bodyPreview ? { kind: 'text', text: sent.bodyPreview, contentType } : { kind: 'none' };
  return { method: sent.method.toUpperCase().replace(/[^A-Z0-9_-]/g, '') || 'GET', url: sent.url, headers, body, notes };
}
