import { createStore } from 'zustand/vanilla';
import { listen } from '@tauri-apps/api/event';
import { useStore } from 'zustand';
import { useCallback, useEffect, useState } from 'react';
import { gitApi, type GitSnapshot } from '../../platform/git';
import type { Project, Experiment } from '../../domain/workspace';
import { describeError } from './runtime';
// Selection is navigation state. Persisted native conversations own their original cwd.
function rememberedRoots(key = 'scientify.code.worktrees.v1'): Record<string, string> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? '{}');
    if (value && typeof value === 'object' && !Array.isArray(value))
      return Object.fromEntries(
        Object.entries(value).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      );
  } catch {
    /* Navigation preferences are optional. */
  }
  return {};
}
export const codeContext = createStore<{
  roots: Record<string, string>;
  experiments: Record<string, string>;
}>(() => ({
  roots: rememberedRoots(),
  experiments: rememberedRoots('scientify.code.experiments.v1'),
}));
codeContext.subscribe((state) => {
  try {
    localStorage.setItem('scientify.code.worktrees.v1', JSON.stringify(state.roots));
    localStorage.setItem('scientify.code.experiments.v1', JSON.stringify(state.experiments));
  } catch {
    /* The current selection stays usable. */
  }
});
export function selectCodeRoot(project: string, root: string) {
  codeContext.setState((state) => ({ roots: { ...state.roots, [project]: root } }));
}
export function clearCodeRoot(project: string) {
  codeContext.setState((state) => ({
    roots: Object.fromEntries(Object.entries(state.roots).filter(([id]) => id !== project)),
  }));
}
export function selectExperiment(project: string, experiment: Experiment) {
  codeContext.setState((state) => ({
    experiments: { ...state.experiments, [project]: experiment.id },
    roots: experiment.root
      ? { ...state.roots, [project]: experiment.root }
      : Object.fromEntries(Object.entries(state.roots).filter(([id]) => id !== project)),
  }));
}
export function useCodeWorkspace(project: Project, experiment?: Experiment) {
  const selected = useStore(codeContext, (state) => state.experiments[project.id]);
  const remembered = useStore(codeContext, (state) => state.roots[project.id]);
  const root =
    experiment && selected && selected !== experiment.id
      ? experiment.root || undefined
      : experiment?.root || remembered;
  const key = JSON.stringify([project.id, project.path ?? '', project.repo ?? '', root ?? '']);
  const [loaded, setLoaded] = useState<{ key: string; snapshot: GitSnapshot } | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((r) => r + 1), []);
  useEffect(() => {
    if (!gitApi.available()) return;
    let alive = true;
    let stop: (() => void) | undefined;
    void listen<{ projectId: string }>('code-git-event', ({ payload }) => {
      if (payload.projectId === project.id) refresh();
    })
      .then((unlisten) => {
        if (alive) stop = unlisten;
        else unlisten();
      })
      .catch(() => {});
    const changed = (event: Event) => {
      if ((event as CustomEvent).detail === project.id) refresh();
    };
    window.addEventListener('scientify-project-files-changed', changed);
    window.addEventListener('focus', refresh);
    return () => {
      alive = false;
      stop?.();
      window.removeEventListener('scientify-project-files-changed', changed);
      window.removeEventListener('focus', refresh);
    };
  }, [project.id, refresh]);
  useEffect(() => {
    if (!gitApi.available()) return;
    let alive = true;
    setLoading(true);
    setError('');
    void gitApi
      .inspect(project.id, root)
      .then((value) => {
        if (!alive) return;
        setLoaded({ key, snapshot: value });
        setError(value.error ?? '');
        if (root !== value.root) selectCodeRoot(project.id, value.root);
        if (experiment && selected !== experiment.id)
          codeContext.setState((state) => ({
            experiments: { ...state.experiments, [project.id]: experiment.id },
          }));
      })
      .catch((e) => {
        if (alive) {
          setLoaded(null);
          setError(describeError(e));
        }
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [project.id, project.path, project.repo, root, revision, key, experiment?.id, selected]);
  const snapshot = loaded?.key === key && loaded.snapshot.root === root ? loaded.snapshot : null;
  return { root, snapshot, ready: !gitApi.available() || !!snapshot, error, loading, refresh };
}
