/**
 * Swagger 2.0 -> CollectionBundle, implemented as a front-end to the OpenAPI
 * converter: the document is first rewritten into the OpenAPI 3 shape
 * (servers, requestBody, components, flows), then imported like any 3.x file.
 * `$ref`s are rewritten (`#/definitions/` -> `#/components/schemas/`, ...) and
 * remain local-only; external refs become warnings in the OpenAPI stage.
 */
import { AppError } from '@aegis/core';
import { convertOpenApiObject, type ParseOpenApiOptions, type ParseOpenApiResult } from './import-openapi';
import { parseImportText } from './parse-input';
import type { JsonObject } from './shared';
import { DEFAULT_MAX_BYTES, UNSAFE_KEYS, failImport, isRecord, toStr } from './shared';
import { WarningCollector } from './warnings';

const HTTP_METHODS: ReadonlySet<string> = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch']);
const MAX_WALK_DEPTH = 500;

const REF_MAP: Array<[string, string]> = [
  ['#/definitions/', '#/components/schemas/'],
  ['#/parameters/', '#/components/parameters/'],
  ['#/responses/', '#/components/responses/'],
  ['#/securityDefinitions/', '#/components/securitySchemes/'],
];

/** Deep copy that rewrites `$ref` targets and drops unsafe keys. */
function rewriteRefs(value: unknown, depth = 0): unknown {
  if (depth > MAX_WALK_DEPTH) throw new AppError('IMPORT_INVALID', 'The document contains data nested too deeply.');
  if (Array.isArray(value)) return value.map((v) => rewriteRefs(v, depth + 1));
  if (!isRecord(value)) return value;
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(value)) {
    if (UNSAFE_KEYS.has(k)) continue;
    if (k === '$ref' && typeof v === 'string') {
      const hit = REF_MAP.find(([from]) => v.startsWith(from));
      out[k] = hit ? v.replace(hit[0], hit[1]) : v;
    } else out[k] = rewriteRefs(v, depth + 1);
  }
  return out;
}

/** Swagger parameter `type/format/items/enum/default/...` -> OpenAPI `schema`. */
function paramSchema(p: JsonObject): JsonObject {
  const schema: JsonObject = {};
  for (const key of ['type', 'format', 'items', 'enum', 'default', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'multipleOf', 'minItems', 'maxItems', 'uniqueItems']) {
    if (p[key] !== undefined) schema[key] = p[key];
  }
  if (schema.type === 'file') schema.type = 'string';
  if (p.type === 'file') schema.format = 'binary';
  return schema;
}

function convertParameter(p: JsonObject): JsonObject {
  const out: JsonObject = { name: p.name, in: p.in };
  if (p.required !== undefined) out.required = p.required;
  if (p.description !== undefined) out.description = p.description;
  if (p['x-example'] !== undefined) out.example = p['x-example'];
  out.schema = paramSchema(p);
  if (p.collectionFormat === 'multi') out.explode = true;
  return out;
}

interface Split {
  params: JsonObject[];
  body?: JsonObject;
  form: JsonObject[];
}

function splitParameters(list: unknown, w: WarningCollector, path: string, componentParams: JsonObject): Split {
  const out: Split = { params: [], form: [] };
  if (!Array.isArray(list)) return out;
  list.forEach((raw, i) => {
    let p = raw;
    if (isRecord(raw) && typeof raw.$ref === 'string') {
      // Refs were already rewritten to the OpenAPI 3 location; body/formData parameters have no
      // OpenAPI 3 parameter equivalent and must be inlined, everything else stays a reference.
      const prefix = '#/components/parameters/';
      const name = raw.$ref.startsWith(prefix) ? raw.$ref.slice(prefix.length) : undefined;
      const target = name !== undefined && !UNSAFE_KEYS.has(name) && Object.prototype.hasOwnProperty.call(componentParams, name) ? componentParams[name] : undefined;
      if (isRecord(target) && (target.in === 'body' || target.in === 'formData')) p = target;
      else {
        out.params.push(raw);
        return;
      }
    }
    if (!isRecord(p)) {
      w.warn(`${path}[${i}]`, 'Parameter is not an object; skipped', raw);
      return;
    }
    if (p.in === 'body') {
      if (out.body) w.warn(`${path}[${i}]`, 'More than one body parameter; only the first is imported', p.name);
      else out.body = p;
    } else if (p.in === 'formData') out.form.push(p);
    else out.params.push(convertParameter(p));
  });
  return out;
}

function requestBodyFrom(split: Split, consumes: string[], w: WarningCollector, path: string): JsonObject | undefined {
  if (split.body) {
    const mediaType = consumes[0] ?? 'application/json';
    if (consumes.length > 1) w.info(`${path}.consumes`, `Several "consumes" media types; "${mediaType}" was imported`, consumes);
    const media: JsonObject = {};
    if (split.body.schema !== undefined) media.schema = split.body.schema;
    if (split.body['x-example'] !== undefined) media.example = split.body['x-example'];
    const rb: JsonObject = { content: { [mediaType]: media } };
    if (split.body.required !== undefined) rb.required = split.body.required;
    if (split.body.description !== undefined) rb.description = split.body.description;
    return rb;
  }
  if (split.form.length > 0) {
    const hasFile = split.form.some((p) => p.type === 'file');
    const mediaType = hasFile || consumes.some((c) => /multipart/i.test(c)) ? 'multipart/form-data' : 'application/x-www-form-urlencoded';
    const properties: JsonObject = {};
    const required: string[] = [];
    for (const p of split.form) {
      if (typeof p.name !== 'string' || UNSAFE_KEYS.has(p.name)) continue;
      const schema = paramSchema(p);
      if (p.description !== undefined) schema.description = p.description;
      if (p['x-example'] !== undefined) schema.example = p['x-example'];
      properties[p.name] = schema;
      if (p.required === true) required.push(p.name);
    }
    return { content: { [mediaType]: { schema: { type: 'object', properties, ...(required.length ? { required } : {}) } } } };
  }
  return undefined;
}

function convertResponses(responses: unknown, produces: string[]): JsonObject | undefined {
  if (!isRecord(responses)) return undefined;
  const out: JsonObject = {};
  for (const code of Object.keys(responses)) {
    if (UNSAFE_KEYS.has(code)) continue;
    const r = responses[code];
    if (!isRecord(r)) continue;
    if (typeof r.$ref === 'string') {
      out[code] = r;
      continue;
    }
    const res: JsonObject = { description: typeof r.description === 'string' ? r.description : '' };
    if (isRecord(r.headers)) {
      const headers: JsonObject = {};
      for (const [name, h] of Object.entries(r.headers)) {
        if (UNSAFE_KEYS.has(name) || !isRecord(h)) continue;
        headers[name] = { ...(h.description !== undefined ? { description: h.description } : {}), schema: paramSchema(h) };
      }
      res.headers = headers;
    }
    if (r.schema !== undefined || isRecord(r.examples)) {
      const mediaType = produces[0] ?? 'application/json';
      const media: JsonObject = {};
      if (r.schema !== undefined) media.schema = r.schema;
      if (isRecord(r.examples)) {
        const ex = Object.prototype.hasOwnProperty.call(r.examples, mediaType) ? r.examples[mediaType] : Object.values(r.examples)[0];
        if (ex !== undefined) media.example = ex;
      }
      res.content = { [mediaType]: media };
    }
    out[code] = res;
  }
  return out;
}

function convertSecurityDefinitions(defs: unknown, w: WarningCollector): JsonObject {
  const out: JsonObject = {};
  if (!isRecord(defs)) return out;
  for (const [name, raw] of Object.entries(defs)) {
    if (UNSAFE_KEYS.has(name) || !isRecord(raw)) continue;
    const common = raw.description !== undefined ? { description: raw.description } : {};
    if (raw.type === 'basic') out[name] = { type: 'http', scheme: 'basic', ...common };
    else if (raw.type === 'apiKey') out[name] = { type: 'apiKey', name: raw.name, in: raw.in, ...common };
    else if (raw.type === 'oauth2') {
      const scopes = isRecord(raw.scopes) ? raw.scopes : {};
      const flow = toStr(raw.flow);
      const flows: JsonObject = {};
      if (flow === 'implicit') flows.implicit = { authorizationUrl: raw.authorizationUrl, scopes };
      else if (flow === 'password') flows.password = { tokenUrl: raw.tokenUrl, scopes };
      else if (flow === 'application') flows.clientCredentials = { tokenUrl: raw.tokenUrl, scopes };
      else if (flow === 'accessCode') flows.authorizationCode = { authorizationUrl: raw.authorizationUrl, tokenUrl: raw.tokenUrl, scopes };
      else w.warn(`securityDefinitions.${name}.flow`, `Unknown OAuth 2.0 flow "${flow}"`, raw.flow);
      out[name] = { type: 'oauth2', flows, ...common };
    } else out[name] = { type: toStr(raw.type), ...common };
  }
  return out;
}

/** Build an OpenAPI 3.0-shaped object from a Swagger 2.0 document. Pure data transformation, no network. */
export function swagger2ToOpenApi3(raw: JsonObject, w: WarningCollector): JsonObject {
  const doc = rewriteRefs(raw) as JsonObject;
  const out: JsonObject = { openapi: '3.0.3', info: isRecord(doc.info) ? doc.info : { title: 'Imported API' } };

  const schemes = Array.isArray(doc.schemes) && doc.schemes.length ? doc.schemes.map(toStr) : [];
  const host = typeof doc.host === 'string' ? doc.host : '';
  const basePath = typeof doc.basePath === 'string' ? doc.basePath.replace(/\/+$/, '') : '';
  if (host) out.servers = (schemes.length ? schemes : ['https']).map((s) => ({ url: `${s}://${host}${basePath}` }));
  else if (basePath) {
    out.servers = [{ url: basePath }];
    w.warn('host', 'The document has no "host"; the server URL is relative (basePath only)');
  }

  const globalConsumes = Array.isArray(doc.consumes) ? doc.consumes.map(toStr) : [];
  const globalProduces = Array.isArray(doc.produces) ? doc.produces.map(toStr) : [];
  const componentParams = isRecord(doc.parameters) ? doc.parameters : {};

  const paths: JsonObject = {};
  if (isRecord(doc.paths)) {
    for (const [pathKey, item] of Object.entries(doc.paths)) {
      if (UNSAFE_KEYS.has(pathKey) || !isRecord(item)) continue;
      const pathItem: JsonObject = {};
      const shared = splitParameters(item.parameters, w, `paths["${pathKey}"].parameters`, componentParams);
      if (shared.params.length) pathItem.parameters = shared.params;
      for (const [key, op] of Object.entries(item)) {
        if (!HTTP_METHODS.has(key.toLowerCase()) || !isRecord(op)) continue;
        const at = `paths["${pathKey}"].${key}`;
        const own = splitParameters(op.parameters, w, `${at}.parameters`, componentParams);
        const consumes = Array.isArray(op.consumes) ? op.consumes.map(toStr) : globalConsumes;
        const produces = Array.isArray(op.produces) ? op.produces.map(toStr) : globalProduces;
        const merged: Split = { params: own.params, form: [...shared.form, ...own.form], ...(own.body ?? shared.body ? { body: own.body ?? shared.body } : {}) };
        const converted: JsonObject = {};
        for (const k of ['tags', 'summary', 'description', 'operationId', 'deprecated', 'security', 'externalDocs']) if (op[k] !== undefined) converted[k] = op[k];
        for (const k of Object.keys(op)) if (k.startsWith('x-')) converted[k] = op[k];
        if (merged.params.length) converted.parameters = merged.params;
        const body = requestBodyFrom(merged, consumes, w, at);
        if (body) converted.requestBody = body;
        const responses = convertResponses(op.responses, produces);
        if (responses) converted.responses = responses;
        pathItem[key] = converted;
      }
      paths[pathKey] = pathItem;
    }
  }
  out.paths = paths;

  const components: JsonObject = {};
  if (isRecord(doc.definitions)) components.schemas = doc.definitions;
  if (Object.keys(componentParams).length) {
    const converted: JsonObject = {};
    for (const [name, p] of Object.entries(componentParams)) if (!UNSAFE_KEYS.has(name) && isRecord(p) && p.in !== 'body' && p.in !== 'formData') converted[name] = convertParameter(p);
    components.parameters = converted;
  }
  if (isRecord(doc.responses)) components.responses = convertResponses(doc.responses, globalProduces);
  if (doc.securityDefinitions !== undefined) components.securitySchemes = convertSecurityDefinitions(doc.securityDefinitions, w);
  if (Object.keys(components).length) out.components = components;
  if (doc.security !== undefined) out.security = doc.security;
  if (doc.tags !== undefined) out.tags = doc.tags;
  if (doc.externalDocs !== undefined) out.externalDocs = doc.externalDocs;
  for (const k of Object.keys(doc)) if (k.startsWith('x-')) out[k] = doc[k];
  return out;
}

/** Convert a Swagger 2.0 document (JSON or YAML text, or a parsed object) into a {@link CollectionBundle}. */
export function parseSwagger2Document(input: string | object, options: ParseOpenApiOptions = {}): ParseOpenApiResult {
  const w = new WarningCollector();
  try {
    options.onProgress?.({ stage: 'Parsing', current: 0, total: 1 });
    const raw = typeof input === 'string' ? parseImportText(input, options.fileName, options.maxBytes ?? DEFAULT_MAX_BYTES, w) : input;
    options.onProgress?.({ stage: 'Parsing', current: 1, total: 1 });
    if (!isRecord(raw)) failImport(w, '', 'This is not a Swagger document: the top-level value must be an object.');
    if (typeof raw.openapi === 'string') failImport(w, 'openapi', 'This is an OpenAPI 3 document; use the OpenAPI importer.');
    if (raw.swagger !== '2.0' && raw.swagger !== 2) failImport(w, 'swagger', `Unsupported Swagger version "${toStr(raw.swagger)}". Only Swagger 2.0 can be imported.`);
    if (!isRecord(raw.paths)) failImport(w, 'paths', 'This is not a Swagger document: the "paths" object is missing.');
    w.info('swagger', 'Swagger 2.0 document converted to the OpenAPI 3 shape before import');
    const doc = swagger2ToOpenApi3(raw, w);
    const result = convertOpenApiObject(doc, '2.0', 'swagger', w, options);
    return result;
  } catch (e) {
    if (e instanceof RangeError) throw new AppError('IMPORT_INVALID', 'The document is nested too deeply to import.', {}, { cause: e });
    throw e;
  }
}
