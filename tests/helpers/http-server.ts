import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import type { HttpRequestSpec } from '@aegis/core';

export interface TestServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

async function readAll(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

export function requestHandler(): http.RequestListener {
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const body = await readAll(req);
    const json = (status: number, value: unknown, headers: Record<string, string | string[]> = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(JSON.stringify(value));
    };
    const parts = url.pathname.split('/').filter(Boolean);
    switch (parts[0]) {
      case 'echo':
        return json(200, {
          method: req.method,
          path: url.pathname + url.search,
          headers: req.headers,
          body: body.toString('utf8'),
          bodyLength: body.length,
        });
      case 'status':
        res.writeHead(Number(parts[1]), { 'Content-Type': 'text/plain' });
        return res.end(`status ${parts[1]}`);
      case 'delay':
        await new Promise((r) => setTimeout(r, Number(parts[1])));
        return json(200, { ok: true });
      case 'redirect': {
        const n = Number(parts[1]);
        if (n <= 0) return json(200, { arrived: true, headers: req.headers, method: req.method, body: body.toString() });
        res.writeHead(Number(url.searchParams.get('code') ?? 302), { Location: `/redirect/${n - 1}` });
        return res.end();
      }
      case 'redirect-abs': {
        res.writeHead(302, { Location: url.searchParams.get('to') ?? '/' });
        return res.end();
      }
      case 'gzip': {
        const payload = gzipSync(JSON.stringify({ gz: true }));
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });
        return res.end(payload);
      }
      case 'bomb': {
        // 20 MiB of zeros compresses to a few KiB
        const payload = gzipSync(Buffer.alloc(20 * 1024 * 1024));
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Encoding': 'gzip' });
        return res.end(payload);
      }
      case 'big': {
        const size = Number(parts[1] ?? 1) * 1024 * 1024;
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        const chunk = Buffer.alloc(64 * 1024, 97);
        let sent = 0;
        while (sent < size) {
          if (!res.write(chunk)) await new Promise((r) => res.once('drain', r));
          sent += chunk.length;
        }
        return res.end();
      }
      case 'cookie-set':
        return json(200, { set: true }, { 'Set-Cookie': ['sid=abc123; Path=/; HttpOnly', 'theme=dark; Path=/'] });
      case 'cookie-echo':
        return json(200, { cookie: req.headers.cookie ?? null });
      case 'hang':
        return; // never respond
      default:
        res.writeHead(404);
        return res.end('not found');
    }
  };
}

export async function startServer(): Promise<TestServer> {
  const server = http.createServer(requestHandler());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export async function startHttpsServer(key: string, cert: string): Promise<TestServer> {
  const server = https.createServer({ key, cert }, requestHandler());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `https://127.0.0.1:${port}`,
    port,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

let counter = 0;
export function makeSpec(overrides: Partial<HttpRequestSpec> & { url: string }): HttpRequestSpec {
  return {
    id: `req-${++counter}`,
    method: 'GET',
    headers: [],
    body: { kind: 'none' },
    timeoutMs: 10_000,
    followRedirects: true,
    maxRedirects: 10,
    maxResponseBytes: 50 * 1024 * 1024,
    maxRequestBytes: 50 * 1024 * 1024,
    tls: { rejectUnauthorized: true },
    ...overrides,
  };
}
