import { open, readFile, rm, copyFile, writeFile } from 'node:fs/promises';
import { AppError, newId, headerValue, type HttpResponse, type ResponseCookie, type ResponseView } from '@aegis/core';

const PREVIEW_LIMIT = 512 * 1024;
const IMAGE_PREVIEW_LIMIT = 2 * 1024 * 1024;
const MAX_STORED = 25;
const MAX_STORED_MEMORY = 200 * 1024 * 1024;

interface Entry {
  id: string;
  data?: Uint8Array;
  filePath?: string;
  size: number;
}

export function isTextualContentType(contentType: string): boolean {
  const ct = contentType.toLowerCase();
  return (
    ct.startsWith('text/') ||
    /(json|xml|javascript|ecmascript|html|yaml|x-www-form-urlencoded|csv|graphql|svg|markdown)/.test(ct) ||
    ct === ''
  );
}

function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 4096);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

export function parseSetCookie(raw: string): ResponseCookie {
  const parts = raw.split(';').map((p) => p.trim());
  const [pair, ...attrs] = parts;
  const eq = pair!.indexOf('=');
  const cookie: ResponseCookie = { name: eq === -1 ? pair! : pair!.slice(0, eq), value: eq === -1 ? '' : pair!.slice(eq + 1), secure: false, httpOnly: false };
  for (const a of attrs) {
    const [k, ...v] = a.split('=');
    const key = k!.toLowerCase();
    const val = v.join('=');
    if (key === 'domain') cookie.domain = val;
    else if (key === 'path') cookie.path = val;
    else if (key === 'expires') cookie.expires = val;
    else if (key === 'max-age') cookie.expires = new Date(Date.now() + Number(val) * 1000).toUTCString();
    else if (key === 'secure') cookie.secure = true;
    else if (key === 'httponly') cookie.httpOnly = true;
    else if (key === 'samesite') cookie.sameSite = val;
  }
  return cookie;
}

/** Keeps recent response bodies (memory or spilled file) so the UI can page through them. */
export class ResponseStore {
  private readonly entries = new Map<string, Entry>();

  put(response: HttpResponse): Entry {
    const entry: Entry = response.bodyFilePath
      ? { id: newId(), filePath: response.bodyFilePath, size: response.size }
      : { id: newId(), data: response.body, size: response.size };
    this.entries.set(entry.id, entry);
    void this.evict();
    return entry;
  }

  private async evict(): Promise<void> {
    let memory = 0;
    for (const e of this.entries.values()) memory += e.data?.length ?? 0;
    for (const [id, e] of this.entries) {
      if (this.entries.size <= MAX_STORED && memory <= MAX_STORED_MEMORY) break;
      memory -= e.data?.length ?? 0;
      await this.release(id);
    }
  }

  async release(id: string): Promise<void> {
    const e = this.entries.get(id);
    if (!e) return;
    this.entries.delete(id);
    if (e.filePath) await rm(e.filePath, { force: true });
  }

  async releaseAll(): Promise<void> {
    for (const id of [...this.entries.keys()]) await this.release(id);
  }

  private require(id: string): Entry {
    const e = this.entries.get(id);
    if (!e) throw new AppError('NOT_FOUND', 'The response is no longer available. Send the request again.');
    return e;
  }

  /** Read up to `length` bytes starting at `offset`, decoded as UTF-8 (a partial multibyte char at the edge is dropped). */
  async readChunk(id: string, offset: number, length: number): Promise<{ text: string; offset: number; bytesRead: number; total: number }> {
    const e = this.require(id);
    const len = Math.max(0, Math.min(length, 4 * 1024 * 1024));
    const off = Math.max(0, offset);
    let buf: Buffer;
    if (e.data) {
      buf = Buffer.from(e.data.subarray(off, off + len));
    } else {
      const fh = await open(e.filePath!, 'r');
      try {
        const out = Buffer.alloc(len);
        const { bytesRead } = await fh.read(out, 0, len, off);
        buf = out.subarray(0, bytesRead);
      } finally {
        await fh.close();
      }
    }
    // trim an incomplete trailing UTF-8 sequence so chunks decode cleanly
    let end = buf.length;
    if (off + buf.length < e.size) {
      let back = 0;
      while (back < 3 && end - back > 0 && (buf[end - back - 1]! & 0xc0) === 0x80) back++;
      if (end - back > 0 && buf[end - back - 1]! >= 0xc0) end = end - back - 1;
    }
    const slice = buf.subarray(0, end);
    return { text: slice.toString('utf8'), offset: off, bytesRead: slice.length, total: e.size };
  }

  /** First `max` bytes of the body (for scripts and previews). */
  async head(id: string, max: number): Promise<Buffer> {
    const e = this.require(id);
    if (e.data) return Buffer.from(e.data.subarray(0, max));
    const fh = await open(e.filePath!, 'r');
    try {
      const out = Buffer.alloc(Math.min(max, e.size));
      const { bytesRead } = await fh.read(out, 0, out.length, 0);
      return out.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  }

  async saveTo(id: string, destination: string): Promise<void> {
    const e = this.require(id);
    if (e.filePath) await copyFile(e.filePath, destination);
    else await writeFile(destination, e.data!);
  }

  async readAll(id: string, max: number): Promise<Buffer> {
    const e = this.require(id);
    if (e.size > max) throw new AppError('RESPONSE_TOO_LARGE', 'The response is too large to process in memory.');
    if (e.data) return Buffer.from(e.data);
    return readFile(e.filePath!);
  }
}

export async function buildResponseView(response: HttpResponse, responseId: string): Promise<ResponseView> {
  const contentType = headerValue(response.headers, 'content-type') ?? '';
  const previewBuf = Buffer.from(response.body.subarray(0, PREVIEW_LIMIT));
  const textual = isTextualContentType(contentType);
  const isBinary = !textual || looksBinary(previewBuf);
  const previewBytes = isBinary ? 0 : previewBuf.length;
  const cookies = response.setCookies.map(parseSetCookie);
  const imageOk = /^image\/(png|jpe?g|gif|webp|bmp|x-icon)/i.test(contentType) && response.size <= IMAGE_PREVIEW_LIMIT && !response.bodyFilePath;
  return {
    responseId,
    status: response.status,
    statusText: response.statusText,
    httpVersion: response.httpVersion,
    headers: response.headers,
    cookies,
    contentType,
    size: response.size,
    requestSize: response.requestSize,
    url: response.url,
    redirects: response.redirects,
    timings: { waitingMs: response.timings.waitingMs, downloadMs: response.timings.downloadMs, totalMs: response.timings.totalMs, startedAt: response.timings.startedAt },
    bodyPreview: isBinary ? '' : previewBuf.toString('utf8'),
    previewBytes,
    isBinary,
    ...(imageOk ? { imagePreviewBase64: Buffer.from(response.body).toString('base64') } : {}),
    notes: response.notes,
  };
}
