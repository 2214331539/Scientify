import { invoke, isTauri } from '@tauri-apps/api/core';
import type { Experiment, Workspace } from '../../domain/workspace';
import type { WorkspaceStore } from '../../stores/workspace';

export const experimentCatalog = {
  available: () => isTauri(),
  prepare: (projectId: string, source: 'existing' | 'empty', directory?: string) =>
    invoke<{ id: string; root: string; source: 'existing' | 'empty' }>('experiment_prepare', {
      projectId,
      source,
      directory,
    }),
};
export function experimentsFor(data: Workspace | null, project: string) {
  return (data?.experiments ?? []).filter((experiment) => experiment.project === project);
}
export function sameCodeRoot(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const normalize = (value: string) => {
    const path = value
      .replace(/^\\\\\?\\/, '')
      .replaceAll('\\', '/')
      .replace(/\/$/, '');
    return /^[a-z]:\//i.test(path) ? path.toLowerCase() : path;
  };
  return normalize(a) === normalize(b);
}
export async function registerExperiment(
  store: WorkspaceStore,
  project: string,
  name: string,
  purpose: string,
  source: 'existing' | 'empty',
  directory?: string,
): Promise<Experiment> {
  const prepared = await experimentCatalog.prepare(project, source, directory);
  const now = new Date().toISOString();
  const experiment: Experiment = {
    ...prepared,
    project,
    name: name.trim(),
    purpose: purpose.trim(),
    createdAt: now,
    updatedAt: now,
    runConfigurations: [],
  };
  if (
    !(await store.getState().update((data) => {
      if (!data.projects.some((p) => p.id === project)) throw new Error('项目不存在。');
      (data.experiments ??= []).push(experiment);
    }))
  )
    throw new Error(store.getState().error ?? '实验保存失败。');
  return experiment;
}
