import { create } from 'zustand';
import type { RunnerDoneEvent, RunnerItemEvent, RunnerOptions, RunSummary } from '@aegis/core';
import { api, errorMessage } from '../lib/api';
import { withProductionConfirm } from '../lib/confirm-production';
import { useApp } from './app';

export interface RunData {
  runId: string;
  label: string;
  items: RunnerItemEvent[];
  done: RunnerDoneEvent | null;
  startedAt: number;
}

export type StartOptions = RunnerOptions & { collectionName: string };

interface RunnerState {
  runs: Record<string, RunData>;
  order: string[];
  /** The run shown in the panel. */
  currentRunId: string | null;
  starting: boolean;
  error: string | null;
  lastOptions: StartOptions | null;

  start(options: StartOptions): Promise<boolean>;
  stop(): Promise<void>;
  /** Load the stored results of a previous run into the panel. */
  viewRun(summary: RunSummary): Promise<void>;
  setCurrent(runId: string | null): void;
  clearError(): void;
}

const MAX_RUNS = 6;
let subscribed = false;

function upsert(runId: string, update: (r: RunData) => RunData, label = 'Run') {
  useRunner.setState((s) => {
    const existing = s.runs[runId] ?? { runId, label, items: [], done: null, startedAt: Date.now() };
    const runs = { ...s.runs, [runId]: update(existing) };
    let order = s.order.includes(runId) ? s.order : [...s.order, runId];
    while (order.length > MAX_RUNS) {
      const drop = order.find((id) => id !== s.currentRunId && id !== runId) ?? order[0]!;
      delete runs[drop];
      order = order.filter((id) => id !== drop);
    }
    return { runs, order };
  });
}

/** Subscribe (once) to the runner events from the main process. Safe to call repeatedly. */
export function ensureRunnerSubscription(): void {
  if (subscribed) return;
  subscribed = true;
  api.events.on('runner:item', (ev) => {
    upsert(ev.runId, (r) => (r.items.some((i) => i.index === ev.index && i.iteration === ev.iteration) ? r : { ...r, items: [...r.items, ev] }));
  });
  api.events.on('runner:done', (ev) => {
    upsert(ev.runId, (r) => ({ ...r, done: ev }));
    if (useRunner.getState().currentRunId === ev.runId) {
      const msg = ev.status === 'completed' ? `Run finished: ${ev.totalRequests} requests, ${ev.failedTests} failed tests` : `Run ${ev.status}`;
      useApp.getState().toast(msg, ev.status === 'completed' && ev.failedTests === 0 ? 'success' : ev.status === 'failed' ? 'error' : 'info');
    }
  });
}

export const useRunner = create<RunnerState>((set, get) => ({
  runs: {},
  order: [],
  currentRunId: null,
  starting: false,
  error: null,
  lastOptions: null,

  async start(options) {
    ensureRunnerSubscription();
    if (get().starting) return false;
    set({ starting: true, error: null });
    try {
      const { collectionName, ...rest } = options;
      const res = await withProductionConfirm((confirmProduction) => api.runner.start({ ...rest, ...(confirmProduction ? { confirmProduction: true } : {}) }), 'run this collection');
      if (!res) {
        set({ starting: false });
        return false;
      }
      upsert(res.runId, (r) => ({ ...r, label: collectionName, startedAt: Date.now() }), collectionName);
      set({ currentRunId: res.runId, starting: false, lastOptions: options });
      return true;
    } catch (e) {
      set({ starting: false, error: errorMessage(e) });
      return false;
    }
  },

  async stop() {
    const id = get().currentRunId;
    if (!id) return;
    try {
      await api.runner.stop({ runId: id });
    } catch (e) {
      set({ error: errorMessage(e) });
    }
  },

  async viewRun(summary) {
    try {
      const items = await api.runner.items({ runId: summary.id });
      const done: RunnerDoneEvent = {
        runId: summary.id,
        status: summary.status === 'stopped' || summary.status === 'failed' ? summary.status : 'completed',
        totalRequests: summary.totalRequests,
        passedTests: summary.passedTests,
        failedTests: summary.failedTests,
        durationMs: summary.finishedAt ? Math.max(0, Date.parse(summary.finishedAt) - Date.parse(summary.startedAt)) : 0,
      };
      upsert(summary.id, (r) => ({ ...r, label: summary.collectionName, items, done, startedAt: Date.parse(summary.startedAt) || r.startedAt }), summary.collectionName);
      set({ currentRunId: summary.id, error: null });
    } catch (e) {
      set({ error: errorMessage(e) });
    }
  },

  setCurrent: (currentRunId) => set({ currentRunId }),
  clearError: () => set({ error: null }),
}));
