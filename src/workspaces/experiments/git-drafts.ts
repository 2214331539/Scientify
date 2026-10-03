import { createStore } from 'zustand/vanilla';
import type { WorkspaceStore } from '../../stores/workspace';

type Drafts = { messages: Record<string, string>; pending: Record<string, true> };
const runtimes = new WeakMap<WorkspaceStore, ReturnType<typeof createDrafts>>();
function createDrafts(owner: WorkspaceStore) {
  const drafts = createStore<Drafts>(() => ({ messages: {}, pending: {} }));
  drafts.subscribe((state) => {
    owner.getState().setDirtySource('git-messages', Object.values(state.messages).some(Boolean));
    owner.getState().setDirtySource('git-operations', Object.keys(state.pending).length > 0);
  });
  return drafts;
}
export const gitDraftKey = (project: string, root: string) => JSON.stringify([project, root]);
export function gitDrafts(owner: WorkspaceStore) {
  let drafts = runtimes.get(owner);
  if (!drafts) {
    drafts = createDrafts(owner);
    runtimes.set(owner, drafts);
  }
  return drafts;
}
export function setGitMessage(owner: WorkspaceStore, key: string, message: string) {
  gitDrafts(owner).setState((state) => ({ messages: { ...state.messages, [key]: message } }));
}
export function beginGitOperation(owner: WorkspaceStore, key: string) {
  const drafts = gitDrafts(owner);
  if (drafts.getState().pending[key]) return null;
  drafts.setState((state) => ({ pending: { ...state.pending, [key]: true } }));
  return () =>
    drafts.setState((state) => ({
      pending: Object.fromEntries(Object.entries(state.pending).filter(([id]) => id !== key)),
    }));
}
