import { createCipheriv } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emptyRequestDraft, newId, type ScriptCookieJarOp, type ScriptCookieJarResult } from '@aegis/core';
import { MAX_COOKIE_OPS, MAX_RANDOM_BYTES_PER_CALL, MAX_RANDOM_CALLS, runScript } from '@aegis/scripting';
import { createTestApp, type TestApp } from '../helpers/app';
import { startServer, type TestServer } from '../helpers/http-server';
import { expectOk, fakeHost, makeInput, okResponse, testByName, testPhase } from './helpers/script-input';

/** Runs a script that stores a JSON value under pm.variables 'out' and returns it parsed. */
async function probe(body: string, options: Parameters<typeof makeInput>[1] = {}): Promise<Record<string, unknown>> {
  const r = await runScript(makeInput(`const out = {};\n${body}\npm.variables.set('out', JSON.stringify(out));`, options));
  expectOk(r);
  return JSON.parse(r.variables.variables.out!) as Record<string, unknown>;
}

describe('require() allow-list', () => {
  it('loads every allow-listed module, caches it, and rejects everything else with MODULE_NOT_FOUND', async () => {
    const out = await probe(`
      const names = ['lodash', 'moment', 'crypto-js', 'uuid', 'ajv', 'tv4', 'xml2js', 'chai', 'atob', 'btoa', 'buffer', 'csv-parse/lib/sync', 'csv-parse/sync'];
      out.types = names.map((n) => typeof require(n));
      out.cached = require('lodash') === require('lodash') && require('lodash') === _;
      out.resolve = require.resolve('moment');
      for (const m of ['fs', 'child_process', 'cheerio', 'lodash/fp', 'postman-collection']) { try { require(m); } catch (e) { out[m] = [e.code, e.message.slice(0, 60)]; } }
    `);
    expect(out.types).toEqual(['function', 'function', 'object', 'object', 'function', 'object', 'object', 'object', 'function', 'function', 'object', 'function', 'object']);
    expect(out.cached).toBe(true);
    expect(out.resolve).toBe('moment');
    expect((out.fs as string[])[0]).toBe('MODULE_NOT_FOUND');
    expect((out.fs as string[])[1]).toContain("Cannot find module 'fs'");
    expect((out.child_process as string[])[0]).toBe('MODULE_NOT_FOUND');
    expect((out.cheerio as string[])[1]).toContain('not available');
    expect((out['postman-collection'] as string[])[1]).toContain('not available');
  });

  it('globals _, CryptoJS, moment, tv4, xml2Json and Buffer are lazy and assignable; cheerio throws', async () => {
    const out = await probe(`
      out.lodash = _.VERSION.split('.')[0];
      out.moment = typeof moment.utc;
      out.cryptojs = typeof CryptoJS.SHA256;
      out.tv4 = typeof tv4.validate;
      out.xml2Json = typeof xml2Json;
      out.buffer = typeof Buffer.from;
      globalThis._ = 'mine';
      out.reassigned = _;
      try { cheerio.load('<p>'); } catch (e) { out.cheerio = e.message; }
    `);
    expect(out).toMatchObject({ lodash: '4', moment: 'function', cryptojs: 'function', tv4: 'function', xml2Json: 'function', buffer: 'function', reassigned: 'mine' });
    expect(out.cheerio).toContain('cheerio is not available');
  });
});

describe('crypto-js', () => {
  it('matches published hash and HMAC test vectors', async () => {
    const out = await probe(`
      const C = require('crypto-js');
      out.md5Empty = C.MD5('').toString();
      out.md5 = C.MD5('abc').toString();
      out.sha1 = C.SHA1('abc').toString();
      out.sha224 = C.SHA224('abc').toString();
      out.sha256 = C.SHA256('abc').toString();
      out.sha384 = C.SHA384('abc').toString().slice(0, 32);
      out.sha512 = C.SHA512('abc').toString();
      out.sha3 = C.SHA3('abc', { outputLength: 256 }).toString();
      out.ripemd = C.RIPEMD160('abc').toString();
      out.hmacSha256 = C.HmacSHA256('what do ya want for nothing?', 'Jefe').toString();
      out.hmacMd5 = C.HmacMD5('The quick brown fox jumps over the lazy dog', 'key').toString();
      out.hmacSha1 = C.HmacSHA1('The quick brown fox jumps over the lazy dog', 'key').toString();
      out.hmacSha512 = C.HmacSHA512('what do ya want for nothing?', 'Jefe').toString().slice(0, 32);
      out.b64 = C.enc.Base64.stringify(C.enc.Utf8.parse('hello'));
      out.hex = C.SHA256('abc').toString(C.enc.Hex).length;
      out.utf8 = C.enc.Utf8.stringify(C.enc.Base64.parse('aGVsbG8='));
      out.latin1 = C.enc.Latin1.stringify(C.enc.Hex.parse('4142'));
      out.pbkdf2 = C.PBKDF2('password', 'salt', { keySize: 256 / 32, iterations: 1, hasher: C.algo.SHA256 }).toString();
      out.global = CryptoJS.SHA256('abc').toString() === out.sha256;
    `);
    expect(out).toMatchObject({
      md5Empty: 'd41d8cd98f00b204e9800998ecf8427e',
      md5: '900150983cd24fb0d6963f7d28e17f72',
      sha1: 'a9993e364706816aba3e25717850c26c9cd0d89d',
      sha224: '23097d223405d8228642a477bda255b32aadbce4bda0b3f7e36c9da7',
      sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      sha384: 'cb00753f45a35e8bb5a03d699ac65007',
      sha512: 'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f',
      sha3: '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45', // CryptoJS "SHA3" is Keccak-256 (pre-FIPS padding), same as upstream
      ripemd: '8eb208f7e05d987a9b044a8e98c6b087f15a0bfc',
      hmacSha256: '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
      hmacMd5: '80070713463e7749b90c2dc24911e275',
      hmacSha1: 'de7c9b85b8b78aa6bc8a7a36f70a90701c9db4d9',
      hmacSha512: '164b7a7bfcf819e2e395fbe73b56e0a3',
      b64: 'aGVsbG8=',
      hex: 64,
      utf8: 'hello',
      latin1: 'AB',
      pbkdf2: '120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b',
      global: true,
    });
  });

  it('AES encrypt/decrypt: passphrase round-trip, OpenSSL-compatible key/iv output, random IV source', async () => {
    const key = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8');
    const iv = Buffer.from('fedcba9876543210', 'utf8');
    const cipher = createCipheriv('aes-256-cbc', key, iv);
    const expected = Buffer.concat([cipher.update('hello world', 'utf8'), cipher.final()]).toString('base64');
    const out = await probe(`
      const C = require('crypto-js');
      const enc = C.AES.encrypt('hello world', 'passphrase');
      out.roundTrip = C.AES.decrypt(enc.toString(), 'passphrase').toString(C.enc.Utf8);
      out.saltedPrefix = enc.toString().slice(0, 8);
      out.differentSalt = C.AES.encrypt('hello world', 'passphrase').toString() !== enc.toString();
      const k = C.enc.Utf8.parse('0123456789abcdef0123456789abcdef');
      const i = C.enc.Utf8.parse('fedcba9876543210');
      out.fixed = C.AES.encrypt('hello world', k, { iv: i, mode: C.mode.CBC, padding: C.pad.Pkcs7 }).toString();
      out.fixedBack = C.AES.decrypt(out.fixed, k, { iv: i }).toString(C.enc.Utf8);
      out.random = C.lib.WordArray.random(16).toString().length;
      out.randomDiffers = C.lib.WordArray.random(16).toString() !== C.lib.WordArray.random(16).toString();
      out.tripleDes = C.TripleDES.decrypt(C.TripleDES.encrypt('x', 'k').toString(), 'k').toString(C.enc.Utf8);
    `);
    expect(out.roundTrip).toBe('hello world');
    expect(out.saltedPrefix).toBe('U2FsdGVk'); // "Salted__"
    expect(out.differentSalt).toBe(true);
    expect(out.fixed).toBe(expected);
    expect(out.fixedBack).toBe('hello world');
    expect(out.random).toBe(32);
    expect(out.randomDiffers).toBe(true);
    expect(out.tripleDes).toBe('x');
  });

  it('a secret may be hashed (result kept) but is still redacted when logged', async () => {
    const SECRET = 'sk_live_9f8e7d6c5b4a';
    const r = await runScript(
      makeInput(
        `
        const digest = CryptoJS.SHA256(pm.environment.get('apiKey')).toString();
        pm.environment.set('digest', digest);
        console.log('value', pm.environment.get('apiKey'), 'sha256', digest);
        pm.variables.set('sig', CryptoJS.HmacSHA256('payload', pm.environment.get('apiKey')).toString());
        `,
        { variables: { environment: { apiKey: SECRET } }, secretValues: [SECRET] },
      ),
    );
    expectOk(r);
    expect(r.variables.environment.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(r.variables.variables.sig).toMatch(/^[0-9a-f]{64}$/);
    expect(r.console[0]!.message).toBe(`value [REDACTED] sha256 ${r.variables.environment.digest}`);
    expect(JSON.stringify(r.console)).not.toContain(SECRET);
  });
});

describe('uuid, lodash, moment', () => {
  it('uuid v1/v3/v4/v5/v7 with RFC 4122 vectors and host-backed randomness', async () => {
    const out = await probe(`
      const uuid = require('uuid');
      out.v4 = uuid.v4();
      out.v4Distinct = new Set(Array.from({ length: 50 }, () => uuid.v4())).size;
      out.v1Valid = uuid.validate(uuid.v1()) && uuid.version(uuid.v1()) === 1;
      out.v7Version = uuid.version(uuid.v7());
      out.v5 = uuid.v5('www.example.com', uuid.v5.DNS);
      out.v3 = uuid.v3('www.example.com', uuid.v3.DNS);
      out.nil = uuid.NIL;
      out.parse = Array.from(uuid.parse('6ec0bd7f-11c0-43da-975e-2a8ad9ebae0b')).length;
      out.invalid = uuid.validate('nope');
    `);
    expect(out.v4).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(out.v4Distinct).toBe(50);
    expect(out.v1Valid).toBe(true);
    expect(out.v7Version).toBe(7);
    expect(out.v5).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2');
    expect(out.v3).toBe('5df41881-3aed-3515-88a7-2f4a814cf09e');
    expect(out.nil).toBe('00000000-0000-0000-0000-000000000000');
    expect(out.parse).toBe(16);
    expect(out.invalid).toBe(false);
  });

  it('lodash smoke: collections, strings, templates, chaining', async () => {
    const out = await probe(`
      out.get = _.get({ a: { b: [1, { c: 'deep' }] } }, 'a.b[1].c');
      out.chunk = _.chunk([1, 2, 3, 4, 5], 2);
      out.groupBy = _.groupBy(['one', 'two', 'three'], 'length');
      out.camel = _.camelCase('Foo Bar_baz');
      out.template = _.template('Hello <%= name %>!')({ name: 'Ada' });
      out.chain = _([3, 1, 2]).sortBy().map((x) => x * 2).value();
      out.cloneDeepEqual = _.isEqual(_.cloneDeep({ a: [1, { b: 2 }] }), { a: [1, { b: 2 }] });
      out.debounceType = typeof _.debounce(() => {}, 10);
      out.uniq = _.uniqBy([{ id: 1 }, { id: 1 }, { id: 2 }], 'id').length;
      out.noConflict = typeof _.noConflict;
    `);
    expect(out).toEqual({
      get: 'deep',
      chunk: [[1, 2], [3, 4], [5]],
      groupBy: { 3: ['one', 'two'], 5: ['three'] },
      camel: 'fooBarBaz',
      template: 'Hello Ada!',
      chain: [2, 4, 6],
      cloneDeepEqual: true,
      debounceType: 'function',
      uniq: 2,
      noConflict: 'function',
    });
  });

  it('moment smoke: parsing, formatting, arithmetic, durations, utc', async () => {
    const out = await probe(`
      const moment = require('moment');
      out.format = moment.utc('2024-03-05T06:07:08Z').format('YYYY-MM-DD HH:mm:ss');
      out.add = moment.utc('2024-01-31').add(1, 'month').format('YYYY-MM-DD');
      out.diff = moment.utc('2024-03-01').diff(moment.utc('2024-02-01'), 'days');
      out.duration = moment.duration(90, 'minutes').asHours();
      out.iso = moment.utc(0).toISOString();
      out.valid = moment('not a date').isValid();
      out.unix = moment.unix(1700000000).utc().format('YYYY-MM-DD');
      out.custom = moment.utc('05/03/2024', 'DD/MM/YYYY').format('MMMM D, YYYY');
      out.startOf = moment.utc('2024-03-05T06:07:08Z').startOf('day').toISOString();
      out.global = typeof moment === typeof globalThis.moment;
    `);
    expect(out).toEqual({
      format: '2024-03-05 06:07:08',
      add: '2024-02-29',
      diff: 29,
      duration: 1.5,
      iso: '1970-01-01T00:00:00.000Z',
      valid: false,
      unix: '2023-11-14',
      custom: 'March 5, 2024',
      startOf: '2024-03-05T00:00:00.000Z',
      global: true,
    });
  });
});

describe('JSON schema (ajv / tv4)', () => {
  it('pm.response.to.have.jsonSchema resolves $ref, validates formats and reports precise errors', async () => {
    const r = await runScript(
      testPhase(`
        const schema = {
          $schema: 'http://json-schema.org/draft-07/schema#',
          definitions: { id: { type: 'integer', minimum: 1 }, tag: { type: 'string', pattern: '^[a-z]$' } },
          type: 'object',
          required: ['id', 'name', 'tags'],
          properties: { id: { $ref: '#/definitions/id' }, name: { type: 'string' }, tags: { type: 'array', items: { $ref: '#/definitions/tag' } }, nested: { type: 'object', properties: { x: { const: 1 } } } },
          additionalProperties: false,
        };
        pm.test('valid with refs', () => pm.response.to.have.jsonSchema(schema));
        pm.test('ref violation', () => pm.response.to.have.jsonSchema({ definitions: { id: { type: 'string' } }, properties: { id: { $ref: '#/definitions/id' } } }));
        pm.test('additionalProperties', () => pm.response.to.have.jsonSchema({ type: 'object', properties: { id: {} }, additionalProperties: false }));
        pm.test('format ok', () => pm.response.to.have.jsonSchema({ properties: { name: { type: 'string', format: 'hostname' } } }));
        pm.test('format violation', () => pm.response.to.have.jsonSchema({ properties: { name: { type: 'string', format: 'email' } } }));
        pm.test('nested const', () => pm.response.to.have.jsonSchema({ properties: { nested: { properties: { x: { const: 2 } } } } }));
        pm.test('draft-04 via tv4', () => pm.response.to.have.jsonSchema({ $schema: 'http://json-schema.org/draft-04/schema#', type: 'object', required: ['id'], properties: { id: { type: 'integer' } } }));
        pm.test('draft-04 violation', () => pm.response.to.have.jsonSchema({ $schema: 'http://json-schema.org/draft-04/schema#', properties: { id: { type: 'string' } } }));
        pm.test('draft-06 meta', () => pm.response.to.have.jsonSchema({ $schema: 'http://json-schema.org/draft-06/schema#', properties: { tags: { contains: { const: 'a' } } } }));
        pm.test('invalid schema', () => pm.response.to.have.jsonSchema({ type: 'object', properties: { id: { type: 'not-a-type' } } }));
        pm.test('not a schema', () => pm.response.to.have.jsonSchema('{"type":"object"}'));
        pm.test('negated', () => pm.response.to.not.have.jsonSchema({ type: 'string' }));
      `),
    );
    expectOk(r);
    expect(r.tests.map((t) => [t.name, t.passed])).toEqual([
      ['valid with refs', true],
      ['ref violation', false],
      ['additionalProperties', false],
      ['format ok', true],
      ['format violation', false],
      ['nested const', false],
      ['draft-04 via tv4', true],
      ['draft-04 violation', false],
      ['draft-06 meta', true],
      ['invalid schema', false],
      ['not a schema', false],
      ['negated', true],
    ]);
    expect(testByName(r, 'ref violation').error).toContain('$.id must be string');
    expect(testByName(r, 'additionalProperties').error).toContain('must NOT have additional properties ("name")');
    expect(testByName(r, 'format violation').error).toContain('$.name must match format "email"');
    expect(testByName(r, 'nested const').error).toContain('$.nested.x must be equal to constant');
    expect(testByName(r, 'draft-04 violation').error).toMatch(/\$\.id Invalid type: number/);
    expect(testByName(r, 'invalid schema').error).toContain('Invalid JSON schema');
    expect(testByName(r, 'not a schema').error).toContain('expects a JSON schema object');
  });

  it('supports the common string/number formats', async () => {
    const out = await probe(`
      const Ajv = require('ajv');
      const check = (format, value) => new Ajv({ strict: false }).validate({ format }, value);
      out.good = ['date:2024-02-29', 'date-time:2024-02-29T12:00:00Z', 'date-time:2024-02-29T12:00:00.5+01:00', 'time:12:00:00Z', 'email:a.b+c@example.co.uk', 'hostname:api.example.com', 'ipv4:10.0.0.255',
        'ipv6:::1', 'ipv6:2001:db8::ff00:42:8329', 'ipv6:::ffff:192.168.1.1', 'uri:https://x.test/a?b=1#c', 'uri-reference:/relative/path', 'uuid:6ec0bd7f-11c0-43da-975e-2a8ad9ebae0b', 'regex:^a+$', 'json-pointer:/a/b~1c', 'byte:aGVsbG8=', 'url:https://x.test']
        .filter((s) => { const i = s.indexOf(':'); return check(s.slice(0, i), s.slice(i + 1)); }).length;
      out.bad = ['date:2023-02-29', 'date-time:2024-02-29 12:00:00', 'time:25:00:00Z', 'email:not an email', 'hostname:-bad.example', 'ipv4:256.1.1.1', 'ipv6:12345::', 'ipv6:1:2:3:4:5:6:7:8:9', 'uri:not a uri', 'uuid:xyz', 'regex:(', 'json-pointer:a/b', 'byte:@@@']
        .filter((s) => { const i = s.indexOf(':'); return check(s.slice(0, i), s.slice(i + 1)); });
      out.int32 = [check('int32', 2147483647), check('int32', 2147483648), check('int64', 1.5)];
      out.unknownFormatIsIgnored = check('nope', 'x');
      out.tv4Format = tv4.validate('a@b.co', { type: 'string', format: 'email' }) && !tv4.validate('nope', { type: 'string', format: 'email' });
    `);
    expect(out.good).toBe(17);
    expect(out.bad).toEqual([]);
    expect(out.int32).toEqual([true, false, false]);
    expect(out.unknownFormatIsIgnored).toBe(true);
    expect(out.tv4Format).toBe(true);
  });
});

describe('xml2Json, xml2js, csv-parse, Buffer, atob/btoa', () => {
  it('xml2Json and xml2js produce xml2js-shaped objects', async () => {
    const out = await probe(`
      const xml = '<?xml version="1.0"?><root a="1"><item id="x">one</item><item id="y">two</item><single>z</single><empty/></root>';
      out.xml2Json = xml2Json(xml);
      const xml2js = require('xml2js');
      xml2js.parseString(xml, (err, res) => { out.parseString = res; out.err = err; });
      out.promise = await xml2js.parseStringPromise('<r><c>z</c></r>');
      out.parser = await new xml2js.Parser({ explicitArray: false, explicitRoot: false }).parseStringPromise('<r><c>z</c></r>');
      xml2js.parseString('<unclosed>', (err) => { out.badErr = err ? err.name : 'none'; });
      out.text = xml2Json('<a>5</a>').a;
      out.builder = new xml2js.Builder().buildObject({ r: { $: { id: '1' }, c: 'z' } });
      out.entities = xml2Json('<a>&lt;b&gt; &amp; &#65;</a>').a;
    `);
    expect(out.xml2Json).toEqual({ root: { $: { a: '1' }, item: [{ _: 'one', $: { id: 'x' } }, { _: 'two', $: { id: 'y' } }], single: 'z', empty: '' } });
    expect(out.parseString).toEqual({ root: { $: { a: '1' }, item: [{ _: 'one', $: { id: 'x' } }, { _: 'two', $: { id: 'y' } }], single: ['z'], empty: [''] } });
    expect(out.err).toBeNull();
    expect(out.promise).toEqual({ r: { c: ['z'] } });
    expect(out.parser).toEqual({ c: 'z' });
    expect(out.badErr).toBe('Error');
    expect(out.text).toBe('5'); // values stay strings, like xml2js
    expect(out.builder).toContain('<r id="1"><c>z</c></r>');
    expect(out.entities).toBe('<b> & A');
  });

  it('csv-parse/lib/sync parses RFC 4180 input with the common options', async () => {
    const out = await probe(`
      const parse = require('csv-parse/lib/sync');
      out.plain = parse('a,b\\n1,"x,y"\\n2,"he said ""hi"""\\n');
      out.columns = parse('a,b\\r\\n1,2\\r\\n', { columns: true });
      out.named = parse('1;2', { columns: ['x', 'y'], delimiter: ';' });
      out.skip = parse('a\\n\\nb\\n', { skip_empty_lines: true });
      out.trim = parse(' a , b ', { trim: true });
      out.comment = parse('# hello\\na,b', { comment: '#' });
      out.multiline = parse('a,"line1\\nline2"')[0][1];
      out.bom = parse('\\ufeffa,b')[0][0];
      out.fromTo = parse('h\\n1\\n2\\n3', { from_line: 2, to_line: 3 });
      out.cast = parse('1,x', { cast: (v) => (/^\\d+$/.test(v) ? Number(v) : v) })[0];
      out.relax = parse('a,b\\nc', { relax_column_count: true });
      try { parse('a,b\\nc'); } catch (e) { out.strict = e.message; }
      try { parse('"unterminated'); } catch (e) { out.quote = e.message; }
      out.sync = typeof require('csv-parse/sync').parse;
    `);
    expect(out.plain).toEqual([['a', 'b'], ['1', 'x,y'], ['2', 'he said "hi"']]);
    expect(out.columns).toEqual([{ a: '1', b: '2' }]);
    expect(out.named).toEqual([{ x: '1', y: '2' }]);
    expect(out.skip).toEqual([['a'], ['b']]);
    expect(out.trim).toEqual([['a', 'b']]);
    expect(out.comment).toEqual([['a', 'b']]);
    expect(out.multiline).toBe('line1\nline2');
    expect(out.bom).toBe('a');
    expect(out.fromTo).toEqual([['1'], ['2']]);
    expect(out.cast).toEqual([1, 'x']);
    expect(out.relax).toEqual([['a', 'b'], ['c']]);
    expect(out.strict).toContain('Invalid Record Length');
    expect(out.quote).toContain('quote');
    expect(out.sync).toBe('function');
  });

  it('Buffer subset: encodings, concat, byteLength, JSON shape, reads/writes', async () => {
    const out = await probe(`
      out.b64 = Buffer.from('hi €').toString('base64');
      out.back = Buffer.from('aGkg4oKs', 'base64').toString();
      out.hex = Buffer.from('ABC').toString('hex');
      out.fromHex = Buffer.from('414243', 'hex').toString('utf8');
      out.latin1 = Buffer.from('ÿ', 'latin1').length;
      out.byteLength = [Buffer.byteLength('€'), Buffer.byteLength('abc', 'base64')];
      out.concat = Buffer.concat([Buffer.from('a'), Buffer.from('b')]).toString();
      out.json = JSON.stringify(Buffer.from([1, 2]));
      out.isBuffer = [Buffer.isBuffer(Buffer.alloc(1)), Buffer.isBuffer(new Uint8Array(1))];
      out.alloc = Buffer.alloc(3, 'ab').toString();
      out.slice = Buffer.from('hello').slice(1, 3).toString();
      out.equals = Buffer.from('x').equals(Buffer.from('x'));
      const b = Buffer.alloc(4); b.writeUInt32BE(0xdeadbeef, 0);
      out.read = [b.readUInt32BE(0).toString(16), b.readUInt16LE(0), b.readInt8(0)];
      out.indexOf = Buffer.from('hello world').indexOf('world');
      out.emoji = Buffer.from('😀').toString('hex');
      out.ucs2 = Buffer.from('ab', 'ucs2').toString('hex');
      out.required = require('buffer').Buffer === Buffer;
      out.typedArray = Buffer.from('x') instanceof Uint8Array;
      try { Buffer.alloc(-1); } catch (e) { out.badSize = e.name; }
      try { Buffer.from('x').toString('ebcdic'); } catch (e) { out.badEnc = e.name; }
      out.atob = atob(btoa('ok')) + require('atob')('b2s=') + require('btoa')('ok');
    `);
    expect(out).toEqual({
      b64: 'aGkg4oKs',
      back: 'hi €',
      hex: '414243',
      fromHex: 'ABC',
      latin1: 1,
      byteLength: [3, 2],
      concat: 'ab',
      json: '{"type":"Buffer","data":[1,2]}',
      isBuffer: [true, false],
      alloc: 'aba',
      slice: 'el',
      equals: true,
      read: ['deadbeef', 44510, -34],
      indexOf: 6,
      emoji: 'f09f9880',
      ucs2: '61006200',
      required: true,
      typedArray: true,
      badSize: 'RangeError',
      badEnc: 'TypeError',
      atob: 'okokb2s=',
    });
  });
});

describe('caps on the host bridges', () => {
  it('randomness: per-call size cap and per-run call cap', async () => {
    const r = await runScript(
      makeInput(
        `
        try { CryptoJS.lib.WordArray.random(${MAX_RANDOM_BYTES_PER_CALL + 1}); } catch (e) { pm.variables.set('big', e.name); }
        pm.variables.set('max', String(CryptoJS.lib.WordArray.random(${MAX_RANDOM_BYTES_PER_CALL}).sigBytes));
        const uuid = require('uuid');
        let n = 0;
        try { for (let i = 0; i < ${MAX_RANDOM_CALLS + 10}; i++) { uuid.v4(); n++; } } catch (e) { pm.variables.set('cap', e.message); }
        pm.variables.set('n', String(n));
        `,
        { limits: { timeoutMs: 120_000 } },
      ),
    );
    expectOk(r);
    expect(r.variables.variables.big).toBe('RangeError');
    expect(r.variables.variables.max).toBe(String(MAX_RANDOM_BYTES_PER_CALL));
    expect(r.variables.variables.cap).toContain('limit exceeded');
    // the oversized probe is rejected before it counts; the max-size call is the first counted call of this run
    expect(Number(r.variables.variables.n)).toBe(MAX_RANDOM_CALLS - 1);
  }, 180_000);

  it('cookie jar: operation cap and oversized/invalid operations are rejected before reaching the host', async () => {
    const ops: ScriptCookieJarOp[] = [];
    const host = { sendRequest: fakeHost().sendRequest, cookieJar: async (op: ScriptCookieJarOp): Promise<ScriptCookieJarResult> => { ops.push(op); return { cookies: [] }; } };
    const r = await runScript(
      makeInput(
        `
        const jar = pm.cookies.jar();
        const errs = {};
        try { await jar.set('https://a.test', 'big', 'v'.repeat(70000)); } catch (e) { errs.big = e.message; }
        try { await jar.set('', 'a', 'b'); } catch (e) { errs.url = e.message; }
        try { await jar.set('https://a.test', '', 'b'); } catch (e) { errs.name = e.message; }
        try { await jar.set('https://a.test', { name: 'x', value: 'y', maxAge: 'soon' }); } catch (e) { errs.maxAge = e.message; }
        try { await jar.set('https://a.test', { name: 'x', value: 'y', expires: 'not a date' }); } catch (e) { errs.expires = e.message; }
        let ok = 0, rejected = 0;
        for (let i = 0; i < ${MAX_COOKIE_OPS + 3}; i++) { try { await jar.getAll('https://a.test'); ok++; } catch (e) { rejected++; errs.cap = e.message; } }
        pm.variables.set('out', JSON.stringify({ errs, ok, rejected }));
        `,
        { host },
      ),
    );
    expectOk(r);
    const out = JSON.parse(r.variables.variables.out!) as { errs: Record<string, string>; ok: number; rejected: number };
    expect(out.errs.big).toContain('too long');
    expect(out.errs.url).toContain('"url" is required');
    expect(out.errs.name).toContain('cookie name is required');
    expect(out.errs.maxAge).toContain('maxAge');
    expect(out.errs.expires).toContain('expires');
    expect(out.errs.cap).toContain(`max ${MAX_COOKIE_OPS}`);
    expect(out.ok).toBe(MAX_COOKIE_OPS);
    expect(out.rejected).toBe(3);
    expect(ops).toHaveLength(MAX_COOKIE_OPS);
  });
});

describe('pm.cookies.jar() through a host', () => {
  function jarHost() {
    const store = new Map<string, { name: string; value: string; domain: string; path: string; secure: boolean; httpOnly: boolean }>();
    store.set('sid', { name: 'sid', value: 'server-only', domain: 'a.test', path: '/', secure: true, httpOnly: true });
    const ops: ScriptCookieJarOp[] = [];
    const host = {
      sendRequest: fakeHost().sendRequest,
      cookieJar: async (op: ScriptCookieJarOp): Promise<ScriptCookieJarResult> => {
        ops.push(op);
        const visible = () => [...store.values()].filter((c) => !c.httpOnly);
        switch (op.op) {
          case 'get':
            return { cookies: visible().filter((c) => c.name === op.name) };
          case 'getAll':
            return { cookies: [...store.values()] }; // deliberately leaks httpOnly: the sandbox must filter it
          case 'set': {
            if (store.get(op.cookie.name)?.httpOnly) throw new Error(`Cookie "${op.cookie.name}" is httpOnly and cannot be modified by scripts`);
            const c = { name: op.cookie.name, value: op.cookie.value, domain: op.cookie.domain ?? 'a.test', path: op.cookie.path ?? '/', secure: !!op.cookie.secure, httpOnly: false };
            store.set(c.name, c);
            return { cookies: [c] };
          }
          case 'unset':
            if (store.get(op.name)?.httpOnly) throw new Error('httpOnly');
            store.delete(op.name);
            return { cookies: [] };
          case 'clear':
            for (const c of visible()) store.delete(c.name);
            return { cookies: [] };
        }
      },
    };
    return { host, ops, store };
  }

  it('set/get/getAll/unset/clear with callbacks and promises; httpOnly cookies stay invisible and immutable', async () => {
    const { host, ops, store } = jarHost();
    const r = await runScript(
      makeInput(
        `
        const jar = pm.cookies.jar();
        const out = {};
        const stored = await jar.set('https://a.test/x', 'lang', 'en');
        out.stored = stored;
        await jar.set('https://a.test', { name: 'theme', value: 'dark', path: '/app', secure: true, expires: new Date('2030-01-01T00:00:00Z'), sameSite: 'Lax' });
        await jar.set('https://a.test', { key: 'viaKey', value: 42, maxAge: 3600 });
        out.get = await jar.get('https://a.test', 'lang');
        out.missing = await jar.get('https://a.test', 'nope');
        out.hidden = await jar.get('https://a.test', 'sid');
        out.all = (await jar.getAll('https://a.test')).map((c) => c.name + '=' + c.value);
        jar.get('https://a.test', 'theme', (err, value) => { out.cbGet = [err, value]; });
        jar.getAll('https://a.test', (err, cookies) => { out.cbAll = cookies.length; });
        jar.set('https://a.test', 'cb', 'yes', (err, cookie) => { out.cbSet = [err, cookie && cookie.name]; });
        try { await jar.set('https://a.test', 'sid', 'hijack'); } catch (e) { out.setHttpOnly = e.message; }
        try { await jar.unset('https://a.test', 'sid'); } catch (e) { out.unsetHttpOnly = e.message; }
        jar.unset('https://a.test', 'lang', (err) => { out.cbUnset = err; });
        await new Promise((res) => setTimeout(res, 0));
        out.afterUnset = await jar.get('https://a.test', 'lang');
        await jar.clear('https://a.test');
        out.afterClear = (await jar.getAll('https://a.test')).length;
        pm.variables.set('out', JSON.stringify(out));
        `,
        { host },
      ),
    );
    expectOk(r);
    const out = JSON.parse(r.variables.variables.out!) as Record<string, unknown>;
    expect(out.stored).toEqual({ name: 'lang', value: 'en', domain: 'a.test', path: '/', secure: false, httpOnly: false });
    expect(out.get).toBe('en');
    expect(out.missing).toBeUndefined();
    expect(out.hidden).toBeUndefined();
    expect(out.all).toEqual(['lang=en', 'theme=dark', 'viaKey=42']); // 'sid' filtered by the sandbox even though the host leaked it
    expect(out.cbGet).toEqual([null, 'dark']);
    expect(out.cbAll).toBe(3); // lang, theme, viaKey ('sid' filtered; 'cb' not stored yet)
    expect(out.cbSet).toEqual([null, 'cb']);
    expect(out.setHttpOnly).toContain('httpOnly');
    expect(out.unsetHttpOnly).toContain('httpOnly');
    expect(out.cbUnset).toBeNull();
    expect(out.afterUnset).toBeUndefined();
    expect(out.afterClear).toBe(0);
    expect(store.get('sid')?.value).toBe('server-only');
    expect(ops.find((o) => o.op === 'set' && o.cookie.name === 'theme')).toEqual({
      op: 'set',
      url: 'https://a.test',
      cookie: { name: 'theme', value: 'dark', path: '/app', secure: true, expires: '2030-01-01T00:00:00.000Z', sameSite: 'Lax' },
    });
    expect(ops.find((o) => o.op === 'set' && o.cookie.name === 'viaKey')).toMatchObject({ cookie: { name: 'viaKey', value: '42', maxAge: 3600 } });
    expect(JSON.stringify(r)).not.toContain('server-only');
  });

  it('host failures and in-flight operations respect the deadline', async () => {
    const slow = { sendRequest: fakeHost().sendRequest, cookieJar: () => new Promise<ScriptCookieJarResult>(() => {}) };
    const r = await runScript(makeInput(`pm.environment.set('before', '1'); await pm.cookies.jar().getAll('https://a.test'); pm.environment.set('after', '1');`, { host: slow, limits: { timeoutMs: 300 } }));
    expect(r.error?.code).toBe('SCRIPT_TIMEOUT');
    expect(r.variables.environment).toEqual({ before: '1' });

    const failing = {
      sendRequest: fakeHost().sendRequest,
      cookieJar: async () => {
        throw new Error('jar exploded with sk_live_9f8e7d6c5b4a');
      },
    };
    const f = await runScript(makeInput(`try { await pm.cookies.jar().clear('https://a.test'); } catch (e) { pm.variables.set('m', e.message); }`, { host: failing, secretValues: ['sk_live_9f8e7d6c5b4a'] }));
    expectOk(f);
    expect(f.variables.variables.m).toBe('jar exploded with [REDACTED]');
  });
});

describe('pm.visualizer', () => {
  it('renders Handlebars templates with data, helpers and options; clear() removes the output', async () => {
    const r = await runScript(
      testPhase(`
        const template = '<table>{{#each items}}<tr class="{{@index}}"><td>{{name}}</td><td>{{#if active}}yes{{else}}no{{/if}}</td></tr>{{/each}}</table><p>{{total}} {{response.code}}</p>';
        pm.visualizer.set(template, { items: [{ name: 'A & B', active: true }, { name: '<i>x</i>', active: false }], total: 2, response: pm.response.json ? { code: pm.response.code } : {} });
        pm.variables.set('setTwice', 'yes');
      `),
    );
    expectOk(r);
    expect(r.visualizer).toBe('<table><tr class="0"><td>A &amp; B</td><td>yes</td></tr><tr class="1"><td>&lt;i&gt;x&lt;/i&gt;</td><td>no</td></tr></table><p>2 200</p>');

    const cleared = await runScript(makeInput(`pm.visualizer.set('<b>x</b>'); pm.visualizer.clear();`));
    expectOk(cleared);
    expect(cleared.visualizer).toBeUndefined();

    const lastWins = await runScript(makeInput(`pm.visualizer.set('<b>1</b>'); pm.visualizer.set('<b>{{n}}</b>', { n: 2 });`));
    expect(lastWins.visualizer).toBe('<b>2</b>');

    const noEscape = await runScript(makeInput(`pm.visualizer.set('{{v}}', { v: '<em>raw</em>' }, { noEscape: true });`));
    expect(noEscape.visualizer).toBe('<em>raw</em>');

    const none = await runScript(makeInput(`pm.variables.set('x', '1');`));
    expect(none.visualizer).toBeUndefined();
  });

  it('template errors are thrown to the script; non-string templates are rejected; secrets are redacted', async () => {
    const r = await runScript(
      makeInput(
        `
        try { pm.visualizer.set('{{#each}}'); } catch (e) { pm.variables.set('parse', e.name); }
        try { pm.visualizer.set({ html: 'x' }); } catch (e) { pm.variables.set('type', e.name); }
        pm.visualizer.set('<p>{{token}}</p>', { token: pm.environment.get('token') });
        `,
        { variables: { environment: { token: 'sk_live_9f8e7d6c5b4a' } }, secretValues: ['sk_live_9f8e7d6c5b4a'] },
      ),
    );
    expectOk(r);
    expect(r.variables.variables.parse).toBe('Error');
    expect(r.variables.variables.type).toBe('TypeError');
    expect(r.visualizer).toBe('<p>[REDACTED]</p>');
  });

  it('prototype access is blocked by Handlebars and the rendered output cannot carry scripts', async () => {
    const r = await runScript(makeInput(`pm.visualizer.set('{{constructor.name}}|{{__proto__}}|{{{html}}}', { html: '<svg onload="x()"></svg><a href="JavaScript:void(0)">l</a>' });`));
    expectOk(r);
    expect(r.visualizer).toBe('||<svg></svg><a>l</a>');
  });
});

describe('pm.request.auth and pm.sendRequest auth/trace', () => {
  it('pm.request.auth is a frozen view with credential parameters masked', async () => {
    const out = await probe(
      `
      const a = pm.request.auth;
      out.type = a.type;
      out.params = a.bearer;
      out.list = a.parameters().toObject();
      out.json = a.toJSON();
      out.str = String(a);
      a.type = 'none'; try { a.bearer.push({}); } catch (e) {}
      out.frozen = [a.type, a.bearer.length];
      try { pm.request.auth = null; } catch (e) {}
      out.assign = typeof pm.request.auth;
      `,
      { auth: { type: 'bearer', params: { token: 'super-secret-token', prefix: 'Bearer' } } },
    );
    expect(out.type).toBe('bearer');
    expect(out.params).toEqual([{ key: 'token', value: '[REDACTED]', type: 'string' }, { key: 'prefix', value: 'Bearer', type: 'string' }]);
    expect(out.list).toEqual({ token: '[REDACTED]', prefix: 'Bearer' });
    expect(out.json).toEqual({ type: 'bearer', bearer: [{ key: 'token', value: '[REDACTED]', type: 'string' }, { key: 'prefix', value: 'Bearer', type: 'string' }] });
    expect(out.str).toBe('bearer');
    expect(out.frozen).toEqual(['bearer', 2]);
    expect(out.assign).toBe('object');
    expect(JSON.stringify(out)).not.toContain('super-secret');
  });

  it('masks by key for every auth type, by heuristic for custom auth and by value for known secrets', async () => {
    const cases: Array<[Record<string, unknown>, string[], Record<string, unknown>]> = [
      [{ type: 'basic', params: { username: 'u', password: 'p' } }, [], { username: 'u', password: '[REDACTED]' }],
      [{ type: 'apikey', params: { key: 'X-Api-Key', value: 'k', in: 'header' } }, [], { key: 'X-Api-Key', value: '[REDACTED]', in: 'header' }],
      [{ type: 'oauth2', params: { clientId: 'id', clientSecret: 's', accessToken: 't', scope: 'read', addTokenTo: 'header' } }, [], { clientId: 'id', clientSecret: '[REDACTED]', accessToken: '[REDACTED]', scope: 'read', addTokenTo: 'header' }],
      [{ type: 'awsv4', params: { accessKey: 'AKIA', secretKey: 'sk', region: 'eu-1', service: 's3' } }, [], { accessKey: 'AKIA', secretKey: '[REDACTED]', region: 'eu-1', service: 's3' }],
      [{ type: 'jwt', params: { algorithm: 'HS256', secret: 'x', privateKey: 'y', payload: '{}' } }, [], { algorithm: 'HS256', secret: '[REDACTED]', privateKey: '[REDACTED]', payload: '{}' }],
      [{ type: 'custom', params: { 'x-signature-secret': 'a', mode: 'hmac', api_key: 'b' } }, [], { 'x-signature-secret': '[REDACTED]', mode: 'hmac', api_key: '[REDACTED]' }],
      [{ type: 'basic', params: { username: 'leaked-value', password: 'p' } }, ['leaked-value'], { username: '[REDACTED]', password: '[REDACTED]' }],
      [{ type: 'none', params: {} }, [], {}],
    ];
    for (const [auth, secretValues, expected] of cases) {
      const out = await probe(`out.type = pm.request.auth.type; out.params = pm.request.auth.parameters().toObject();`, { auth: auth as never, secretValues });
      expect(out.params, auth.type as string).toEqual(expected);
      expect(out.type).toBe(auth.type === 'none' ? 'noauth' : auth.type);
    }
    const absent = await probe(`out.auth = typeof pm.request.auth; out.json = pm.request.toJSON().auth;`);
    expect(absent).toEqual({ auth: 'undefined' });
  });

  it('pm.sendRequest applies the auth option (basic, bearer, apikey header/query; Postman array style) and logs a trace', async () => {
    const host = fakeHost(async (req) => okResponse({ bodyText: JSON.stringify({ url: req.url, headers: req.headers }), responseTimeMs: 5, responseSizeBytes: 9 }));
    const r = await runScript(
      makeInput(
        `
        const see = async (auth, url) => (await pm.sendRequest({ url: url || 'https://h.test/a', method: 'POST', auth })).json();
        const out = {};
        out.basic = (await see({ type: 'basic', username: 'ad:min', password: 'pä$$' })).headers;
        out.basicArray = (await see({ type: 'basic', basic: [{ key: 'username', value: 'u' }, { key: 'password', value: 'p' }] })).headers;
        out.bearer = (await see({ type: 'bearer', bearer: { token: 'tok' } })).headers;
        out.apikeyHeader = (await see({ type: 'apikey', key: 'X-Api-Key', value: 'v1' })).headers;
        out.apikeyQuery = (await see({ type: 'apikey', apikey: [{ key: 'key', value: 'api key' }, { key: 'value', value: 'v&2' }, { key: 'in', value: 'query' }] }, 'https://h.test/q?x=1')).url;
        out.noauth = (await see({ type: 'noauth' })).headers;
        try { await see({ type: 'oauth1' }); } catch (e) { out.unsupported = e.message; }
        try { await see('basic'); } catch (e) { out.notObject = e.message; }
        pm.variables.set('out', JSON.stringify(out));
        `,
        { host, secretValues: ['tok'] },
      ),
    );
    expectOk(r);
    const out = JSON.parse(r.variables.variables.out!) as Record<string, unknown>;
    const basicToken = Buffer.from('ad:min:pä$$', 'utf8').toString('base64');
    expect(out.basic).toEqual([{ name: 'Authorization', value: `Basic ${basicToken}` }]);
    expect(out.basicArray).toEqual([{ name: 'Authorization', value: `Basic ${Buffer.from('u:p').toString('base64')}` }]);
    expect(out.bearer).toEqual([{ name: 'Authorization', value: 'Bearer tok' }]);
    expect(out.apikeyHeader).toEqual([{ name: 'X-Api-Key', value: 'v1' }]);
    expect(out.apikeyQuery).toBe('https://h.test/q?x=1&api%20key=v%262');
    expect(out.noauth).toEqual([]);
    expect(out.unsupported).toContain('unsupported auth type "oauth1"');
    expect(out.notObject).toContain('"auth" must be an object');

    const trace = r.console.filter((c) => c.message.startsWith('->') || c.message.startsWith('<-')).map((c) => [c.level, c.message]);
    expect(trace[0]).toEqual(['info', '-> POST https://h.test/a']);
    expect(trace[1]).toEqual(['info', '<- 200 OK POST https://h.test/a (5 ms, 9 B)']);
    expect(trace.filter((t) => t[1]!.startsWith('->'))).toHaveLength(6);
    expect(JSON.stringify(r.console)).not.toContain('"tok"');
  });

  it('pm.sendRequest failures are traced as errors with the duration and the limit message', async () => {
    const host = fakeHost(async () => {
      throw new Error('ECONNREFUSED 127.0.0.1:1');
    });
    const r = await runScript(makeInput(`try { await pm.sendRequest('https://down.test/x?token=abc'); } catch (e) {}`, { host, secretValues: ['abc'] }));
    expectOk(r);
    expect(r.console.map((c) => [c.level, c.message])).toEqual([
      ['info', '-> GET https://down.test/x?token=[REDACTED]'],
      ['error', expect.stringMatching(/^<- GET https:\/\/down\.test\/x\?token=\[REDACTED\] failed after \d+ ms: ECONNREFUSED 127\.0\.0\.1:1$/)],
    ]);
  });
});

describe('end to end through the request executor', () => {
  let server: TestServer;
  let t: TestApp;
  let workspaceId = '';
  beforeAll(async () => {
    server = await startServer();
    t = createTestApp();
    workspaceId = (await t.api.workspaces.create({ name: 'Scripting libs' })).id;
    const env = await t.api.environments.create({ workspaceId, name: 'Staging EU' });
    await t.api.variables.set({
      scope: 'environment',
      ownerId: env.id,
      entries: [
        { key: 'baseUrl', initialValue: server.url, isSecret: false, enabled: true },
        { key: 'apiKey', initialValue: 'sk_live_9f8e7d6c5b4a', isSecret: true, enabled: true },
      ],
    });
    await t.api.environments.setActive({ workspaceId, id: env.id });
  });
  afterAll(async () => {
    await t.close();
    await server.close();
  });

  it('pm.cookies.jar().set() in a pre-request script persists, is sent with the request, audited and reported', async () => {
    const draft = emptyRequestDraft({
      name: 'Jar writer',
      url: '{{baseUrl}}/cookie-echo',
      auth: { type: 'bearer', params: { token: '{{apiKey}}' } },
      scripts: [
        {
          type: 'prerequest',
          language: 'javascript',
          enabled: true,
          source: [
            "const base = pm.environment.get('baseUrl');",
            "await pm.cookies.jar().set(base, 'fromScript', 'yes-' + require('uuid').v5('x', require('uuid').v5.URL).slice(0, 8));",
            "await pm.cookies.jar().set(base, { name: 'signed', value: CryptoJS.HmacSHA256('body', pm.environment.get('apiKey')).toString().slice(0, 16) });",
            "pm.variables.set('envName', pm.environment.name);",
            "pm.variables.set('authType', pm.request.auth.type + ':' + pm.request.auth.parameters().get('token'));",
          ].join('\n'),
        },
        {
          type: 'test',
          language: 'javascript',
          enabled: true,
          source: [
            "pm.test('cookie header was sent', () => pm.expect(pm.response.json().cookie).to.include('fromScript=yes-'));",
            "pm.test('env name', () => pm.expect(pm.variables.get('envName')).to.equal('Staging EU'));",
            "pm.test('auth masked', () => pm.expect(pm.variables.get('authType')).to.equal('bearer:[REDACTED]'));",
            "pm.visualizer.set('<ul>{{#each cookies}}<li>{{this}}</li>{{/each}}</ul><script>alert(1)</script>', { cookies: pm.response.json().cookie.split('; ') });",
          ].join('\n'),
        },
      ],
    });
    const result = await t.api.execution.send({ executionId: newId(), workspaceId, draft });
    expect(result.ok).toBe(true);
    expect(result.tests.map((x) => [x.name, x.passed, x.error])).toEqual([
      ['cookie header was sent', true, undefined],
      ['env name', true, undefined],
      ['auth masked', true, undefined],
    ]);
    expect(result.warnings.filter((w) => w.startsWith('Cookies changed by script'))).toEqual([
      expect.stringContaining('(set): fromScript@'),
      expect.stringContaining('(set): signed@'),
    ]);
    expect(result.visualizer).toMatch(/^<ul><li>fromScript&#x3D;yes-[0-9a-f]{8}<\/li><li>signed&#x3D;[0-9a-f]{16}<\/li><\/ul>$/); // Handlebars escapes '='
    expect(result.visualizer).not.toContain('<script');

    const cookies = await t.api.cookies.list({ workspaceId });
    expect(cookies.map((c) => c.name).sort()).toEqual(['fromScript', 'signed']);
    expect(cookies.every((c) => !c.httpOnly)).toBe(true);

    const audit = await t.api.audit.list({ action: 'SCRIPT_COOKIE_WRITE' });
    expect(audit.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(audit)).toContain('fromScript@');
    expect(JSON.stringify(audit)).not.toContain('yes-');
  });

  it('httpOnly cookies set by a server stay invisible and immutable; unset/clear remove only script-visible cookies', async () => {
    await t.api.execution.send({ executionId: newId(), workspaceId, draft: emptyRequestDraft({ name: 'set', url: '{{baseUrl}}/cookie-set' }) });
    const before = await t.api.cookies.list({ workspaceId });
    expect(before.map((c) => c.name).sort()).toEqual(['fromScript', 'sid', 'signed', 'theme']);

    const draft = emptyRequestDraft({
      name: 'Jar reader',
      url: '{{baseUrl}}/cookie-echo',
      scripts: [
        {
          type: 'test',
          language: 'javascript',
          enabled: true,
          source: [
            "const base = pm.environment.get('baseUrl');",
            'const jar = pm.cookies.jar();',
            "pm.test('sid invisible', async () => { pm.expect(await jar.get(base, 'sid')).to.equal(undefined); pm.expect((await jar.getAll(base)).map((c) => c.name)).to.not.include('sid'); });",
            "pm.test('sid immutable', async () => { let m = ''; try { await jar.set(base, 'sid', 'hijack'); } catch (e) { m = e.message; } pm.expect(m).to.include('httpOnly'); });",
            "pm.test('sid not unsettable', async () => { let m = ''; try { await jar.unset(base, 'sid'); } catch (e) { m = e.message; } pm.expect(m).to.include('httpOnly'); });",
            "await jar.unset(base, 'theme');",
            'await jar.clear(base);',
            "pm.test('cleared', async () => pm.expect((await jar.getAll(base)).length).to.equal(0));",
          ].join('\n'),
        },
      ],
    });
    const result = await t.api.execution.send({ executionId: newId(), workspaceId, draft });
    expect(result.tests.map((x) => [x.name, x.passed, x.error])).toEqual([
      ['sid invisible', true, undefined],
      ['sid immutable', true, undefined],
      ['sid not unsettable', true, undefined],
      ['cleared', true, undefined],
    ]);
    const after = await t.api.cookies.list({ workspaceId });
    expect(after.map((c) => [c.name, c.httpOnly])).toEqual([['sid', true]]);
    expect(result.warnings.filter((w) => w.startsWith('Cookies changed by script'))).toEqual([expect.stringContaining('(unset): theme@'), expect.stringContaining('(clear): fromScript@')]);
    // the server echoes the Cookie header in the body, but the httpOnly value never reaches the script's view of the jar
    expect(JSON.stringify([result.tests, result.console, result.warnings])).not.toContain('abc123');
  });
});
