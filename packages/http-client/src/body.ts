import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import path from 'node:path';
import { AppError, type BodySpec } from '@aegis/core';
import { assertSafeFilePath } from '@aegis/security';

export interface EncodedBody {
  /** Content-Type to use when the caller did not set one. */
  contentType?: string;
  /** Known length in bytes (always known here, so we can send Content-Length). */
  length: number;
  /** Fresh payload for each attempt (redirects may re-send). */
  open(): Buffer | Readable | undefined;
}

const escapeQuotes = (s: string): string => s.replace(/[\r\n]/g, ' ').replace(/"/g, '%22');

function checkSize(length: number, max: number): void {
  if (length > max) throw new AppError('REQUEST_TOO_LARGE', 'The request body exceeds the configured maximum request size.', { limit: max, size: length });
}

export interface EncodeBodyOptions {
  /**
   * The only directory a RELATIVE file path (e.g. an imported Postman `src`) may resolve inside.
   * Absolute paths chosen by the user are validated as before and are not restricted to it.
   * Without it relative paths are rejected (`PATH_NOT_ALLOWED`).
   */
  workingDirectory?: string;
}

/** Validate an upload path: relative paths only inside the working directory, absolute paths with the usual checks. */
export function resolveUploadPath(filePath: string, options: EncodeBodyOptions = {}): string {
  if (typeof filePath !== 'string' || filePath === '') return assertSafeFilePath(filePath);
  if (path.isAbsolute(filePath)) return assertSafeFilePath(filePath);
  if (!options.workingDirectory) {
    throw new AppError('PATH_NOT_ALLOWED', 'Relative file paths need a working directory (Settings → General → Working directory).', { path: filePath.slice(0, 200) });
  }
  const root = path.resolve(options.workingDirectory);
  return assertSafeFilePath(filePath, { allowedRoots: [root] });
}

async function fileSize(filePath: string, options: EncodeBodyOptions): Promise<number> {
  const safe = resolveUploadPath(filePath, options);
  try {
    const s = await stat(safe);
    if (!s.isFile()) throw new AppError('VALIDATION_FAILED', 'The selected path is not a file.', { path: path.basename(safe) });
    return s.size;
  } catch (cause) {
    if (cause instanceof AppError) throw cause;
    throw new AppError('VALIDATION_FAILED', `Cannot read file "${path.basename(safe)}" for upload.`, {}, { cause });
  }
}

/** Convert a `BodySpec` to a sendable payload. Files are streamed from disk, never fully loaded. */
export async function encodeBody(body: BodySpec, maxBytes: number, options: EncodeBodyOptions = {}): Promise<EncodedBody> {
  switch (body.kind) {
    case 'none':
      return { length: 0, open: () => undefined };
    case 'text': {
      const buf = Buffer.from(body.text, 'utf8');
      checkSize(buf.length, maxBytes);
      return { length: buf.length, open: () => buf };
    }
    case 'urlencoded': {
      const text = new URLSearchParams(body.entries.map((e) => [e.name, e.value] as [string, string])).toString();
      const buf = Buffer.from(text, 'utf8');
      checkSize(buf.length, maxBytes);
      return { contentType: 'application/x-www-form-urlencoded', length: buf.length, open: () => buf };
    }
    case 'file': {
      const size = await fileSize(body.path, options);
      checkSize(size, maxBytes);
      const safe = resolveUploadPath(body.path, options);
      return { contentType: 'application/octet-stream', length: size, open: () => createReadStream(safe) };
    }
    case 'multipart': {
      const boundary = `----AegisFormBoundary${randomBytes(12).toString('hex')}`;
      const segments: Array<{ head: Buffer; tail: Buffer; file?: string; text?: Buffer; length: number }> = [];
      let total = 0;
      for (const part of body.parts) {
        if (part.kind === 'text') {
          const headers =
            `--${boundary}\r\nContent-Disposition: form-data; name="${escapeQuotes(part.name)}"` +
            (part.contentType ? `\r\nContent-Type: ${part.contentType}` : '') +
            '\r\n\r\n';
          const head = Buffer.from(headers, 'utf8');
          const text = Buffer.from(part.value, 'utf8');
          const tail = Buffer.from('\r\n');
          segments.push({ head, text, tail, length: head.length + text.length + tail.length });
        } else {
          const size = await fileSize(part.path, options);
          const filename = part.filename ?? path.basename(part.path);
          const headers =
            `--${boundary}\r\nContent-Disposition: form-data; name="${escapeQuotes(part.name)}"; filename="${escapeQuotes(filename)}"` +
            `\r\nContent-Type: ${part.contentType ?? 'application/octet-stream'}\r\n\r\n`;
          const head = Buffer.from(headers, 'utf8');
          const tail = Buffer.from('\r\n');
          segments.push({ head, tail, file: resolveUploadPath(part.path, options), length: head.length + size + tail.length });
        }
        total += segments[segments.length - 1]!.length;
        checkSize(total, maxBytes);
      }
      const closing = Buffer.from(`--${boundary}--\r\n`);
      total += closing.length;
      checkSize(total, maxBytes);
      return {
        contentType: `multipart/form-data; boundary=${boundary}`,
        length: total,
        open: () =>
          Readable.from(
            (async function* () {
              for (const s of segments) {
                yield s.head;
                if (s.text) yield s.text;
                else if (s.file) for await (const chunk of createReadStream(s.file)) yield chunk as Buffer;
                yield s.tail;
              }
              yield closing;
            })(),
          ),
      };
    }
  }
}
