/**
 * Structural check of a Postman Collection v2.1 document. This is NOT a full
 * JSON-schema validation (the official schema cannot be fetched offline); it
 * verifies the properties Postman requires to import a collection: info,
 * schema, item tree, request/url/header/body/auth/event/variable shapes.
 */
import type { JsonObject } from './shared';
import { KNOWN_POSTMAN_AUTH_TYPES, isRecord } from './shared';

const MAX_DEPTH = 100;
const BODY_MODES: ReadonlySet<string> = new Set(['raw', 'urlencoded', 'formdata', 'file', 'graphql']);
const LISTEN_TYPES: ReadonlySet<string> = new Set(['prerequest', 'test']);

type Problems = string[];

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function checkDescription(v: unknown, path: string, p: Problems): void {
  if (v === undefined || v === null || typeof v === 'string') return;
  if (!isRecord(v) || typeof v.content !== 'string') p.push(`${path}: description must be a string or an object with a string "content"`);
}

function checkKeyValueList(list: unknown, path: string, p: Problems, valueRequired: boolean): void {
  if (list === undefined) return;
  if (!Array.isArray(list)) {
    p.push(`${path}: must be an array`);
    return;
  }
  list.forEach((e: unknown, i) => {
    const at = `${path}[${i}]`;
    if (!isRecord(e)) return void p.push(`${at}: must be an object`);
    if (typeof e.key !== 'string' && e.key !== null) p.push(`${at}.key: must be a string`);
    if (valueRequired && typeof e.value !== 'string' && e.value !== null) p.push(`${at}.value: must be a string`);
    if (e.disabled !== undefined && typeof e.disabled !== 'boolean') p.push(`${at}.disabled: must be a boolean`);
    checkDescription(e.description, `${at}.description`, p);
  });
}

function checkAuth(auth: unknown, path: string, p: Problems): void {
  if (auth === undefined) return;
  if (!isRecord(auth)) return void p.push(`${path}: must be an object`);
  const type = auth.type;
  if (typeof type !== 'string') return void p.push(`${path}.type: is required`);
  if (!KNOWN_POSTMAN_AUTH_TYPES.has(type)) return void p.push(`${path}.type: unknown auth type "${type}"`);
  const section = auth[type];
  if (section === undefined) return;
  if (!Array.isArray(section)) return void p.push(`${path}.${type}: must be an array of {key, value, type} in v2.1`);
  section.forEach((e: unknown, i) => {
    if (!isRecord(e) || typeof e.key !== 'string') p.push(`${path}.${type}[${i}]: must be an object with a string "key"`);
  });
}

function checkEvents(events: unknown, path: string, p: Problems): void {
  if (events === undefined) return;
  if (!Array.isArray(events)) return void p.push(`${path}: must be an array`);
  events.forEach((ev: unknown, i) => {
    const at = `${path}[${i}]`;
    if (!isRecord(ev)) return void p.push(`${at}: must be an object`);
    if (typeof ev.listen !== 'string' || !LISTEN_TYPES.has(ev.listen)) p.push(`${at}.listen: must be "prerequest" or "test"`);
    if (ev.disabled !== undefined && typeof ev.disabled !== 'boolean') p.push(`${at}.disabled: must be a boolean`);
    const script = ev.script;
    if (!isRecord(script)) return void p.push(`${at}.script: must be an object`);
    if (script.exec !== undefined && typeof script.exec !== 'string' && !isStringArray(script.exec)) p.push(`${at}.script.exec: must be a string or an array of strings`);
    if (script.exec === undefined && script.src === undefined) p.push(`${at}.script: needs "exec" or "src"`);
  });
}

function checkVariables(vars: unknown, path: string, p: Problems): void {
  if (vars === undefined) return;
  if (!Array.isArray(vars)) return void p.push(`${path}: must be an array`);
  vars.forEach((v: unknown, i) => {
    const at = `${path}[${i}]`;
    if (!isRecord(v)) return void p.push(`${at}: must be an object`);
    if (typeof v.key !== 'string' && typeof v.id !== 'string') p.push(`${at}: needs "key" (or "id")`);
    if (v.disabled !== undefined && typeof v.disabled !== 'boolean') p.push(`${at}.disabled: must be a boolean`);
  });
}

function checkUrl(url: unknown, path: string, p: Problems): void {
  if (typeof url === 'string') return;
  if (!isRecord(url)) return void p.push(`${path}: must be a string or an object`);
  if (url.raw !== undefined && typeof url.raw !== 'string') p.push(`${path}.raw: must be a string`);
  if (url.protocol !== undefined && typeof url.protocol !== 'string') p.push(`${path}.protocol: must be a string`);
  for (const key of ['host', 'path'] as const) {
    const v = url[key];
    if (v !== undefined && typeof v !== 'string' && !Array.isArray(v)) p.push(`${path}.${key}: must be a string or an array`);
    if (Array.isArray(v) && !v.every((s) => typeof s === 'string' || isRecord(s))) p.push(`${path}.${key}: segments must be strings`);
  }
  if (url.port !== undefined && typeof url.port !== 'string') p.push(`${path}.port: must be a string`);
  checkKeyValueList(url.query, `${path}.query`, p, true);
  checkKeyValueList(url.variable, `${path}.variable`, p, false);
}

function checkFormData(list: unknown, path: string, p: Problems): void {
  if (!Array.isArray(list)) return void p.push(`${path}: must be an array`);
  list.forEach((e: unknown, i) => {
    const at = `${path}[${i}]`;
    if (!isRecord(e) || typeof e.key !== 'string') return void p.push(`${at}: must be an object with a string "key"`);
    if (e.type !== 'text' && e.type !== 'file') p.push(`${at}.type: must be "text" or "file"`);
    if (e.type === 'text' && typeof e.value !== 'string') p.push(`${at}.value: must be a string for text fields`);
    if (e.type === 'file' && e.src !== null && typeof e.src !== 'string' && !isStringArray(e.src)) p.push(`${at}.src: must be a string, an array of strings or null`);
  });
}

function checkBody(body: unknown, path: string, p: Problems): void {
  if (body === undefined) return;
  if (!isRecord(body)) return void p.push(`${path}: must be an object`);
  const mode = body.mode;
  if (typeof mode !== 'string' || !BODY_MODES.has(mode)) return void p.push(`${path}.mode: must be one of ${[...BODY_MODES].join(', ')}`);
  if (mode === 'raw' && typeof body.raw !== 'string') p.push(`${path}.raw: must be a string`);
  if (mode === 'urlencoded') checkKeyValueList(body.urlencoded, `${path}.urlencoded`, p, true);
  if (mode === 'formdata') checkFormData(body.formdata, `${path}.formdata`, p);
  if (mode === 'file' && !isRecord(body.file)) p.push(`${path}.file: must be an object`);
  if (mode === 'graphql' && !isRecord(body.graphql)) p.push(`${path}.graphql: must be an object`);
}

function checkRequest(req: unknown, path: string, p: Problems): void {
  if (typeof req === 'string') return;
  if (!isRecord(req)) return void p.push(`${path}: must be an object or a URL string`);
  if (typeof req.method !== 'string' || req.method === '') p.push(`${path}.method: must be a non-empty string`);
  if (req.url === undefined) p.push(`${path}.url: is required`);
  else checkUrl(req.url, `${path}.url`, p);
  if (req.header !== undefined && typeof req.header !== 'string') checkKeyValueList(req.header, `${path}.header`, p, true);
  checkBody(req.body, `${path}.body`, p);
  checkAuth(req.auth, `${path}.auth`, p);
  checkDescription(req.description, `${path}.description`, p);
}

function checkResponses(list: unknown, path: string, p: Problems): void {
  if (list === undefined) return;
  if (!Array.isArray(list)) return void p.push(`${path}: must be an array`);
  list.forEach((r: unknown, i) => {
    const at = `${path}[${i}]`;
    if (!isRecord(r)) return void p.push(`${at}: must be an object`);
    if (r.name !== undefined && typeof r.name !== 'string') p.push(`${at}.name: must be a string`);
    if (r.code !== undefined && typeof r.code !== 'number') p.push(`${at}.code: must be a number`);
    if (r.status !== undefined && typeof r.status !== 'string') p.push(`${at}.status: must be a string`);
    if (r.body !== undefined && r.body !== null && typeof r.body !== 'string') p.push(`${at}.body: must be a string`);
    if (r.header !== undefined && r.header !== null && typeof r.header !== 'string') checkKeyValueList(r.header, `${at}.header`, p, true);
    if (r.originalRequest !== undefined) checkRequest(r.originalRequest, `${at}.originalRequest`, p);
  });
}

function checkItems(items: unknown, path: string, depth: number, p: Problems): void {
  if (!Array.isArray(items)) return void p.push(`${path}: must be an array`);
  if (depth > MAX_DEPTH) return void p.push(`${path}: folders are nested more than ${MAX_DEPTH} levels deep`);
  items.forEach((item: unknown, i) => {
    const at = `${path}[${i}]`;
    if (!isRecord(item)) return void p.push(`${at}: must be an object`);
    if (typeof item.name !== 'string') p.push(`${at}.name: must be a string`);
    checkDescription(item.description, `${at}.description`, p);
    checkEvents(item.event, `${at}.event`, p);
    if (Array.isArray(item.item)) {
      checkVariables(item.variable, `${at}.variable`, p);
      checkAuth(item.auth, `${at}.auth`, p);
      checkItems(item.item, `${at}.item`, depth + 1, p);
    } else if (item.request === undefined) p.push(`${at}: must have either "item" (folder) or "request"`);
    else {
      checkRequest(item.request, `${at}.request`, p);
      checkResponses(item.response, `${at}.response`, p);
    }
  });
}

/** Returns a list of structural problems; an empty list means the document looks like a valid v2.1 collection. */
export function validatePostmanV21Structure(doc: unknown): string[] {
  const p: Problems = [];
  if (!isRecord(doc)) return ['document: must be a JSON object'];
  const root: JsonObject = doc;
  if (!isRecord(root.info)) p.push('info: is required and must be an object');
  else {
    if (typeof root.info.name !== 'string' || root.info.name === '') p.push('info.name: must be a non-empty string');
    if (typeof root.info.schema !== 'string') p.push('info.schema: is required');
    else if (!root.info.schema.includes('/collection/v2.1.0/')) p.push(`info.schema: expected a v2.1.0 collection schema URL, got "${root.info.schema}"`);
    if (root.info._postman_id !== undefined && typeof root.info._postman_id !== 'string') p.push('info._postman_id: must be a string');
    checkDescription(root.info.description, 'info.description', p);
  }
  checkItems(root.item, 'item', 1, p);
  checkEvents(root.event, 'event', p);
  checkVariables(root.variable, 'variable', p);
  checkAuth(root.auth, 'auth', p);
  return p;
}
