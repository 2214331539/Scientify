import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useEffect } from 'react';
import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { WorkspaceStore } from '../../stores/workspace';
import { confirmAction } from '../../components/prompts';
import { t } from '../../i18n';
import { describeError } from './runtime';

export type Interpreter = { executable: string; version: string; prefix: string; manager: string };
export type TerminalInfo = {
  id: string;
  project: string;
  experimentId: string;
  root: string;
  name: string;
  profile: string;
  environment: Interpreter | null;
  status: string;
  exitCode: number | null;
};
export type EnvironmentTask = {
  id: string;
  project: string;
  experimentId: string;
  root: string;
  kind: string;
  command: string[];
  prefix: string;
  status: string;
  exitCode: number | null;
  error: string | null;
  environment: Interpreter | null;
  startedAt: number;
};
export const developmentApi = {
  available: () => isTauri(),
  snapshot: () =>
    invoke<{ terminals: TerminalInfo[]; tasks: EnvironmentTask[] }>('development_snapshot'),
  trust: (projectId: string, experimentId: string, allow?: boolean) =>
    invoke<boolean>('experiment_trust', { projectId, experimentId, allow }),
  terminal: <T>(projectId: string, request: object) =>
    invoke<T>('terminal_command', { projectId, request }),
  python: <T>(projectId: string, experimentId: string, request: object) =>
    invoke<T>('python_command', { projectId, experimentId, request }),
};
export const developmentStore = createStore<{
  terminals: TerminalInfo[];
  tasks: EnvironmentTask[];
  error: string;
}>(() => ({ terminals: [], tasks: [], error: '' }));

export async function ensureExecutionTrust(project: string, experiment: string) {
  if (await developmentApi.trust(project, experiment)) return true;
  if (
    !(await confirmAction(
      t('信任此实验目录？终端、Python 和手动运行将使用本机用户权限，可访问本机文件与网络。'),
    ))
  )
    return false;
  return developmentApi.trust(project, experiment, true);
}
export function useDevelopment() {
  return useStore(developmentStore);
}
export function useDevelopmentRuntime(store: WorkspaceStore, enabled: boolean) {
  useEffect(() => {
    if (!enabled || !developmentApi.available()) return;
    let alive = true,
      polling = false,
      pending = false;
    let timer: ReturnType<typeof setTimeout>;
    const stops: (() => void)[] = [];
    async function poll() {
      if (polling) {
        pending = true;
        return;
      }
      polling = true;
      clearTimeout(timer);
      try {
        const { terminals, tasks } = await developmentApi.snapshot();
        if (!alive) return;
        const previous = developmentStore.getState();
        const sameTerminals = JSON.stringify(previous.terminals) === JSON.stringify(terminals);
        const sameTasks = JSON.stringify(previous.tasks) === JSON.stringify(tasks);
        if (!sameTerminals || !sameTasks || previous.error)
          developmentStore.setState({
            terminals: sameTerminals ? previous.terminals : terminals,
            tasks: sameTasks ? previous.tasks : tasks,
            error: '',
          });
        const active = new Map<string, string>([
          ...terminals
            .filter((t) => t.status === 'running')
            .map((t) => [`terminal:${t.id}`, t.project] as const),
          ...tasks
            .filter((t) => t.status === 'running')
            .map((t) => [`python:${t.id}`, t.project] as const),
        ]);
        for (const key of Object.keys(store.getState().agentTasks)) {
          if ((key.startsWith('terminal:') || key.startsWith('python:')) && !active.has(key))
            store.getState().setAgentTask(key, null);
        }
        for (const item of terminals)
          store
            .getState()
            .setAgentTask(`terminal:${item.id}`, active.get(`terminal:${item.id}`) ?? null);
        for (const item of tasks)
          store
            .getState()
            .setAgentTask(`python:${item.id}`, active.get(`python:${item.id}`) ?? null);
      } catch (reason) {
        if (alive) developmentStore.setState({ error: describeError(reason) });
      } finally {
        polling = false;
        if (alive) timer = setTimeout(() => void poll(), pending ? 80 : 1000);
        pending = false;
      }
    }
    for (const event of ['terminal-event', 'python-event']) {
      void listen(event, () => {
        if (alive) {
          clearTimeout(timer);
          timer = setTimeout(() => void poll(), 80);
        }
      })
        .then((stop) => {
          if (alive) stops.push(stop);
          else stop();
        })
        .catch(() => {});
    }
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
      stops.forEach((stop) => stop());
    };
  }, [enabled, store]);
}

export async function openTerminal(
  project: string,
  experiment: string,
  profile: string,
  path?: string,
  args?: string[],
) {
  if (!(await ensureExecutionTrust(project, experiment))) return null;
  const info = await developmentApi.terminal<TerminalInfo>(project, {
    action: 'open',
    experimentId: experiment,
    profile,
    path,
    args,
  });
  developmentStore.setState((data) => ({
    terminals: [...data.terminals.filter((t) => t.id !== info.id), info],
  }));
  return info;
}
export async function bindInterpreter(
  store: WorkspaceStore,
  experimentId: string,
  environment: Interpreter,
) {
  const ok = await store.getState().update((data) => {
    const experiment = data.experiments?.find((item) => item.id === experimentId);
    if (!experiment) throw new Error(t('实验不存在。'));
    experiment.python = environment;
    experiment.updatedAt = new Date().toISOString();
  });
  if (!ok) throw new Error(store.getState().error || t('保存失败'));
}
