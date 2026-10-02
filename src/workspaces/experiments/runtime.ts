import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useEffect } from 'react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import type { WorkspaceStore } from '../../stores/workspace';
import type { FileContent, ResearchFile } from '../../platform/research';

export type RunConfiguration = {
  id: string;
  name: string;
  executable: string;
  args: string[];
  cwd: string;
};
export type Execution = {
  id: string;
  project: string;
  name: string;
  status: string;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  configuration: RunConfiguration;
  directory: string;
  executable: string;
  platform: string;
  gitCommit: string | null;
  gitChanges: string[];
  error: string | null;
  permission?: string;
  source?: {
    conversationId: string;
    threadId: string;
    turnId: string;
    callId: string;
    workspaceRoot: string;
  } | null;
};
export const experimentApi = {
  available: () => isTauri(),
  list: () => invoke<Execution[]>('experiment_list'),
  start: (projectId: string, configuration: RunConfiguration) =>
    invoke<Execution>('experiment_start', { projectId, configuration }),
  stop: (runId: string) => invoke<void>('experiment_stop', { runId }),
  log: (runId: string) => invoke<string>('experiment_log', { runId }),
  artifacts: (runId: string) => invoke<ResearchFile[]>('experiment_artifacts', { runId }),
  artifact: (runId: string, path: string) =>
    invoke<FileContent>('experiment_read_artifact', { runId, path }),
  diff: (projectId: string, path: string) =>
    invoke<string>('research_git_diff', { projectId, path }),
};
let generation = 0;
export const executionStore = createStore<{ runs: Execution[]; error: string }>(() => ({
  runs: [],
  error: '',
}));
// One native subscription per webview; panels only subscribe to this revision.
export const experimentOutput = createStore<{ revisions: Record<string, number> }>(() => ({
  revisions: {},
}));
export function openExecution(projectId: string, runId: string) {
  window.dispatchEvent(new CustomEvent('scientify-open-run', { detail: { projectId, runId } }));
}
export const describeError = (e: unknown) => (e instanceof Error ? e.message : String(e));
export function useExecutions(store: WorkspaceStore, enabled = true) {
  const snapshot = useStore(executionStore);
  useEffect(() => {
    if (!enabled || !experimentApi.available()) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    let unlisten: (() => void) | undefined;
    let polling = false;
    let pending = false;
    async function poll() {
      if (polling) {
        pending = true;
        return;
      }
      polling = true;
      clearTimeout(timer);
      try {
        const version = generation;
        const runs = await experimentApi.list();
        if (
          !Array.isArray(runs) ||
          runs.some(
            (run) =>
              !run ||
              typeof run.id !== 'string' ||
              typeof run.project !== 'string' ||
              typeof run.status !== 'string',
          )
        )
          throw new Error('Invalid experiment list response');
        if (version !== generation) {
          return;
        }
        if (!alive) return;
        const previous = executionStore.getState();
        if (JSON.stringify(previous.runs) !== JSON.stringify(runs) || previous.error)
          executionStore.setState({ runs, error: '' });
        const active = new Map(
          runs.filter((r) => r.status === 'running').map((r) => ['experiment:' + r.id, r.project]),
        );
        for (const key of Object.keys(store.getState().agentTasks))
          if (
            key.startsWith('experiment:') &&
            !key.startsWith('experiment:pending:') &&
            !active.has(key)
          )
            store.getState().setAgentTask(key, null);
        for (const [key, project] of active)
          if (store.getState().agentTasks[key] !== project)
            store.getState().setAgentTask(key, project);
      } catch (e) {
        if (alive) executionStore.setState({ error: describeError(e) });
      } finally {
        polling = false;
        if (alive) timer = setTimeout(() => void poll(), pending ? 80 : 1200);
        pending = false;
      }
    }
    void listen<{ runId: string }>('experiment-event', ({ payload }) => {
      if (!alive || typeof payload?.runId !== 'string') return;
      experimentOutput.setState((s) => ({
        revisions: { ...s.revisions, [payload.runId]: (s.revisions[payload.runId] ?? 0) + 1 },
      }));
      if (polling) {
        pending = true;
        return;
      }
      clearTimeout(timer);
      timer = setTimeout(() => void poll(), 80);
    })
      .then((stop) => {
        if (alive) unlisten = stop;
        else stop();
      })
      .catch(() => {});
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
      unlisten?.();
    };
  }, [store, enabled]);
  return snapshot;
}
export async function startExecution(
  store: WorkspaceStore,
  project: string,
  config: RunConfiguration,
) {
  generation++;
  const reservation = 'experiment:pending:' + crypto.randomUUID();
  store.getState().setAgentTask(reservation, project);
  try {
    const run = await experimentApi.start(project, config);
    generation++;
    executionStore.setState((s) => ({ runs: [...s.runs.filter((r) => r.id !== run.id), run] }));
    if (run.status === 'running') store.getState().setAgentTask('experiment:' + run.id, project);
    return run;
  } finally {
    store.getState().setAgentTask(reservation, null);
  }
}
export function configurationsOf(value: unknown): RunConfiguration[] {
  return Array.isArray(value)
    ? value.filter(
        (c): c is RunConfiguration =>
          c &&
          typeof c.id === 'string' &&
          typeof c.name === 'string' &&
          typeof c.executable === 'string' &&
          typeof c.cwd === 'string' &&
          Array.isArray(c.args) &&
          c.args.every((a: unknown) => typeof a === 'string'),
      )
    : [];
}
export function parseArguments(text: string): string[] {
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value) || !value.every((a) => typeof a === 'string'))
    throw new Error('参数必须是 JSON 字符串数组。');
  return value;
}
