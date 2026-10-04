import { createHash, createHmac } from 'node:crypto';
import { AppError, headerValue } from '@aegis/core';
import { bool, emptyResult, str, type AuthContext, type AuthProvider } from './types';

const sha256Hex = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string): Buffer => createHmac('sha256', key).update(data).digest();

const encodeRfc3986 = (s: string): string => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

function payloadHash(context: AuthContext): string {
  switch (context.body.kind) {
    case 'none':
      return sha256Hex('');
    case 'text':
      return sha256Hex(context.body.text);
    case 'urlencoded':
      return sha256Hex(new URLSearchParams(context.body.entries.map((e) => [e.name, e.value] as [string, string])).toString());
    default:
      // Streamed / multipart bodies cannot be hashed up front.
      return 'UNSIGNED-PAYLOAD';
  }
}

export interface SigV4Inputs {
  accessKey: string;
  secretKey: string;
  region: string;
  service: string;
  sessionToken?: string;
  date: Date;
}

/** AWS Signature Version 4 (header-based). Exported for tests with fixed dates. */
export function signAwsV4(inputs: SigV4Inputs, context: AuthContext): { headers: Array<{ name: string; value: string }>; canonicalRequest: string; signature: string } {
  const url = new URL(context.url);
  const amzDate = inputs.date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const hash = payloadHash(context);

  const host = url.host;
  const signed: Record<string, string> = { host, 'x-amz-date': amzDate };
  if (inputs.sessionToken) signed['x-amz-security-token'] = inputs.sessionToken;
  const contentType = headerValue([...context.headers], 'content-type');
  if (contentType) signed['content-type'] = contentType.trim();
  if (inputs.service === 's3') signed['x-amz-content-sha256'] = hash;

  const names = Object.keys(signed).sort();
  const canonicalHeaders = names.map((n) => `${n}:${signed[n]!.replace(/\s+/g, ' ').trim()}\n`).join('');
  const signedHeaders = names.join(';');

  const canonicalUri = url.pathname
    .split('/')
    .map((seg) => encodeRfc3986(decodeURIComponentSafe(seg)))
    .join('/') || '/';
  const query = [...url.searchParams.entries()]
    .map(([k, v]) => [encodeRfc3986(k), encodeRfc3986(v)] as [string, string])
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const canonicalRequest = [context.method.toUpperCase(), canonicalUri, query, canonicalHeaders, signedHeaders, hash].join('\n');
  const scope = `${dateStamp}/${inputs.region}/${inputs.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const kDate = hmac(`AWS4${inputs.secretKey}`, dateStamp);
  const kRegion = hmac(kDate, inputs.region);
  const kService = hmac(kRegion, inputs.service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  const headers = [
    { name: 'X-Amz-Date', value: amzDate },
    ...(inputs.sessionToken ? [{ name: 'X-Amz-Security-Token', value: inputs.sessionToken }] : []),
    ...(signed['x-amz-content-sha256'] ? [{ name: 'X-Amz-Content-Sha256', value: hash }] : []),
    {
      name: 'Authorization',
      value: `AWS4-HMAC-SHA256 Credential=${inputs.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  ];
  return { headers, canonicalRequest, signature };
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export const awsV4Provider: AuthProvider = {
  type: 'awsv4',
  apply(params, context) {
    const accessKey = str(params, 'accessKey');
    const secretKey = str(params, 'secretKey');
    if (!accessKey || !secretKey) throw new AppError('AUTH_FAILED', 'AWS Signature requires an access key and a secret key.');
    const url = new URL(context.url);
    const inferred = /^([^.]+)\.([a-z0-9-]+)\.amazonaws\.com/.exec(url.hostname);
    const service = str(params, 'service') || inferred?.[1] || 'execute-api';
    const region = str(params, 'region') || inferred?.[2] || 'us-east-1';
    const sessionToken = str(params, 'sessionToken');
    const signed = signAwsV4({ accessKey, secretKey, region, service, ...(sessionToken ? { sessionToken } : {}), date: new Date(context.now()) }, context);
    const result = emptyResult();
    if (bool(params, 'addAuthDataToQuery')) {
      result.notes.push('addAuthDataToQuery is not supported; signature sent in headers.');
    }
    result.headers.push(...signed.headers);
    result.notes.push(`AWS SigV4 (${service}/${region}).`);
    return result;
  },
};
