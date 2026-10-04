import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp, type AegisApp, type PlatformBridge } from '@aegis/app';
import type { AegisEvents } from '@aegis/core';
import { AuditLogger, Logger, MemoryLogSink, PolicyService } from '@aegis/security';
import { createTestStorage } from './storage';
import type { EnterprisePolicy } from '@aegis/core';

export interface TestApp {
  app: AegisApp;
  dir: string;
  events: Array<{ channel: string; payload: unknown }>;
  logs: MemoryLogSink;
  saveTargets: string[];
  /** Next path returned by the fake save dialog / pick dialog. */
  nextSave: { path: string | null };
  nextPick: { path: string | null; name?: string };
  api: AegisApp['api'];
  close(): Promise<void>;
}

export function createTestApp(options: { policy?: Partial<EnterprisePolicy> } = {}): TestApp {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'aegis-app-'));
  const storage = createTestStorage();
  const logs = new MemoryLogSink();
  const logger = new Logger([logs], 'DEBUG');
  const policy = new PolicyService();
  if (options.policy) policy.setPolicy({ ...policy.current, ...options.policy });
  const events: TestApp['events'] = [];
  const nextSave: TestApp['nextSave'] = { path: path.join(dir, 'export.json') };
  const nextPick: TestApp['nextPick'] = { path: null };
  const platform: PlatformBridge = {
    pickFile: async () => (nextPick.path ? { path: nextPick.path, name: nextPick.name ?? path.basename(nextPick.path), size: 1 } : null),
    saveFile: async () => nextSave.path,
    authorize: async () => {
      throw new Error('interactive authorization is not available in tests');
    },
  };
  const audit = new AuditLogger(storage.repos.audit, () => true);
  const app = createApp({
    storage,
    policy,
    logger,
    audit,
    platform,
    paths: { dataDir: dir, responsesDir: path.join(dir, 'responses'), backupsDir: path.join(dir, 'backups') },
    info: { name: 'Aegis API Client', version: 'test', platform: process.platform },
    emit: <K extends keyof AegisEvents>(channel: K, payload: AegisEvents[K]) => void events.push({ channel, payload }),
    secretStorageAvailable: true,
  });
  return {
    app,
    dir,
    events,
    logs,
    saveTargets: [],
    nextSave,
    nextPick,
    api: app.api,
    async close() {
      await app.dispose();
      storage.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
