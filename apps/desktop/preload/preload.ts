/**
 * Secure preload bridge. Exposes ONLY the allow-listed API channels as
 * `window.api` — never ipcRenderer, fs, process or any Node API.
 * Errors cross the context bridge as `AEGIS_ERR:<json>` messages.
 */
import { contextBridge, ipcRenderer } from 'electron';
import { API_CHANNELS, EVENT_CHANNELS, type IpcEnvelope } from '@aegis/core';

type Fn = (args?: unknown) => Promise<unknown>;
const api: Record<string, Record<string, Fn>> = {};

for (const channel of API_CHANNELS) {
  const [namespace, method] = channel.split('.') as [string, string];
  (api[namespace] ??= {})[method] = async (args?: unknown) => {
    const envelope = (await ipcRenderer.invoke(channel, args)) as IpcEnvelope;
    if (envelope.ok) return envelope.value;
    throw new Error(`AEGIS_ERR:${JSON.stringify(envelope.error)}`);
  };
}

const events = {
  on(channel: string, listener: (payload: unknown) => void): () => void {
    if (!(EVENT_CHANNELS as readonly string[]).includes(channel)) throw new Error(`Unknown event channel: ${channel}`);
    const handler = (_event: unknown, payload: unknown) => listener(payload);
    ipcRenderer.on(channel, handler);
    return () => {
      ipcRenderer.removeListener(channel, handler);
    };
  },
};

contextBridge.exposeInMainWorld('api', { ...api, events });
