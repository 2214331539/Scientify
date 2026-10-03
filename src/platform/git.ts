import { invoke, isTauri } from '@tauri-apps/api/core';
import type { GitChange } from './research';
export type GitWorktree = {
  root: string;
  branch: string | null;
  head: string;
  locked: boolean;
  missing: boolean;
  busy: boolean;
  changes: number | null;
};
export type GitCommit = { sha: string; subject: string; author: string; time: string };
export type GitSnapshot = {
  root: string;
  repository: boolean;
  branch: string | null;
  head: string | null;
  changes: GitChange[];
  branches: { name: string; current: boolean }[];
  history: GitCommit[];
  stashes: { id: string; sha: string; subject: string }[];
  worktrees: GitWorktree[];
  busy: boolean;
  error?: string;
};
export type GitAction = {
  kind:
    | 'init'
    | 'stage'
    | 'unstage'
    | 'restore'
    | 'commit'
    | 'branch-create'
    | 'branch-switch'
    | 'branch-delete'
    | 'stash-save'
    | 'stash-apply'
    | 'stash-pop'
    | 'worktree-add'
    | 'worktree-remove';
  path?: string;
  name?: string;
  message?: string;
  revision?: string;
  target?: string;
  includeUntracked?: boolean;
  expectedSha?: string;
  expectedDiff?: string;
};
export const gitApi = {
  available: () => isTauri(),
  inspect: (projectId: string, workspaceRoot?: string) =>
    invoke<GitSnapshot>('code_git_inspect', { projectId, workspaceRoot }),
  diff: (
    projectId: string,
    workspaceRoot: string,
    path: string,
    staged: boolean,
    commit?: string,
  ) => invoke<string>('code_git_diff', { projectId, workspaceRoot, path, staged, commit }),
  action: (projectId: string, workspaceRoot: string, request: GitAction) =>
    invoke<string>('code_git_action', { projectId, workspaceRoot, request }),
};
