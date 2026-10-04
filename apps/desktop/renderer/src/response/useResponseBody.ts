import type { ResponseView } from '@aegis/core';
import { useEffect, useMemo, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { CHUNK_BYTES, LARGE_BODY_BYTES } from '../lib/chunks';
import { detectContentKind, type ContentKind } from '../lib/format';
import { useApp } from '../store/app';

export interface ResponseBody {
  kind: ContentKind;
  /** Complete text of the body, when it is textual and small enough to hold in memory. */
  text: string | null;
  loading: boolean;
  error: string | null;
  /** Too large to put in an editor: use the chunked viewer. */
  large: boolean;
}

export async function copyText(text: string, what = 'Copied'): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    useApp.getState().toast(what, 'success');
  } catch {
    useApp.getState().toast('Could not access the clipboard.', 'error');
  }
}

/** Resolves the full text of a response body (preview when complete, chunked reads otherwise). */
export function useResponseBody(r: ResponseView): ResponseBody {
  const kind = useMemo(() => detectContentKind(r.contentType, r.bodyPreview.slice(0, 256), r.isBinary), [r.contentType, r.bodyPreview, r.isBinary]);
  const textual = kind === 'json' || kind === 'xml' || kind === 'html' || kind === 'text';
  const large = r.size > LARGE_BODY_BYTES;
  const complete = r.previewBytes >= r.size;
  const [fetched, setFetched] = useState<{ id: string; text: string } | null>(null);
  const [state, setState] = useState<{ loading: boolean; error: string | null }>({ loading: false, error: null });

  useEffect(() => {
    if (!textual || complete || large) return;
    let cancelled = false;
    setState({ loading: true, error: null });
    (async () => {
      let offset = 0;
      let text = '';
      while (offset < r.size) {
        const chunk = await api.responses.readChunk({ responseId: r.responseId, offset, length: Math.min(CHUNK_BYTES * 4, r.size - offset) });
        if (cancelled) return;
        text += chunk.text;
        if (chunk.bytesRead <= 0) break;
        offset += chunk.bytesRead;
      }
      if (!cancelled) {
        setFetched({ id: r.responseId, text });
        setState({ loading: false, error: null });
      }
    })().catch((e) => !cancelled && setState({ loading: false, error: errorMessage(e) }));
    return () => {
      cancelled = true;
    };
  }, [r.responseId, r.size, textual, complete, large]);

  let text: string | null = null;
  if (textual && !large) text = complete ? r.bodyPreview : fetched?.id === r.responseId ? fetched.text : null;
  return { kind, text, loading: state.loading && text === null, error: state.error, large };
}
