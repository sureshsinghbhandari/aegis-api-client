import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { API_CHANNELS, AppError, toSerializedError, type IpcEnvelope } from '@aegis/core';
import type { HandlerMap } from '@aegis/app';
import type { Logger } from '@aegis/security';
import { IPC_SCHEMAS, assertSchemasComplete } from './ipc-schemas';

/** Only our own renderer (app:// protocol or the dev server in development) may call the API. */
export function isTrustedSender(event: IpcMainInvokeEvent, devUrl: string | undefined): boolean {
  const url = event.senderFrame?.url ?? '';
  if (url.startsWith('app://')) return true;
  return !!devUrl && url.startsWith(devUrl);
}

export function registerIpc(handlers: HandlerMap, logger: Logger, devUrl: string | undefined): void {
  assertSchemasComplete();
  for (const channel of API_CHANNELS) {
    ipcMain.handle(channel, async (event, raw: unknown): Promise<IpcEnvelope> => {
      try {
        if (!isTrustedSender(event, devUrl)) throw new AppError('POLICY_VIOLATION', 'Untrusted IPC sender.');
        const parsed = IPC_SCHEMAS[channel].safeParse(raw ?? undefined);
        if (!parsed.success) {
          // Never echo the offending value (it may contain secrets); only the path of the first issue.
          const issue = parsed.error.issues[0];
          throw new AppError('IPC_INVALID_ARGUMENT', `Invalid argument for ${channel}${issue ? `: ${issue.path.join('.') || 'value'} ${issue.message}` : ''}.`);
        }
        const value = await handlers[channel]((parsed.data ?? {}) as never);
        return { ok: true, value };
      } catch (error) {
        const serialized = toSerializedError(error);
        if (serialized.code === 'INTERNAL') logger.error(`ipc ${channel} failed`, error);
        return { ok: false, error: serialized };
      }
    });
  }
}
