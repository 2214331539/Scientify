import { isTauri } from '@tauri-apps/api/core';
import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { Project } from '../../domain/workspace';
import { translateError } from '../../i18n';
import {
  collaboration,
  isSyncedProject,
  type CollaborationMember,
  type CollaborationProject,
  type CollaborationState,
  type ProjectSyncState,
} from '../../platform/collaboration';
import { isTeamProject } from './model';

/** What the project center knows about cloud projects; shared by the sidebar and every page. */
export type CloudSnapshot = {
  available: boolean;
  state: CollaborationState | null;
  /** The last list request reached the server. */
  reachable: boolean;
  loading: boolean;
  error: string;
  projects: CollaborationProject[];
  members: Record<string, CollaborationMember[] | undefined>;
  sync: Record<string, ProjectSyncState | undefined>;
  fetchedAt: string | null;
};

const cacheKey = 'scientify.cloud.cache';
const seenKey = 'scientify.cloud.seen';

function cached(): Pick<CloudSnapshot, 'projects' | 'members' | 'fetchedAt'> {
  try {
    const value = JSON.parse(localStorage.getItem(cacheKey) ?? 'null');
    if (value && Array.isArray(value.projects))
      return { projects: value.projects, members: value.members ?? {}, fetchedAt: value.fetchedAt };
  } catch {
    /* A missing cache only means there is nothing to show offline. */
  }
  return { projects: [], members: {}, fetchedAt: null };
}

export const cloudStore = createStore<CloudSnapshot>(() => ({
  available: isTauri(),
  state: null,
  reachable: true,
  loading: false,
  error: '',
  sync: {},
  ...cached(),
}));

export function useCloud() {
  return useStore(cloudStore);
}

let running: Promise<void> | null = null;
/** Reload the account, the cloud project list, members and local sync states. */
export function refreshCloud(local: Project[]): Promise<void> {
  if (!isTauri()) {
    cloudStore.setState({ available: false });
    return Promise.resolve();
  }
  if (running) return running;
  running = (async () => {
    cloudStore.setState({ available: true, loading: true });
    let state: CollaborationState | null;
    try {
      state = (await collaboration.status()) ?? null;
    } catch (reason) {
      cloudStore.setState({ loading: false, error: translateError(String(reason)) });
      return;
    }
    if (!state?.authenticated) {
      cloudStore.setState({
        state,
        loading: false,
        reachable: true,
        error: '',
        projects: [],
        members: {},
        sync: {},
      });
      return;
    }
    cloudStore.setState({ state });
    try {
      const { projects } = await collaboration.projects();
      const members = Object.fromEntries(
        await Promise.all(
          projects.map(async (project) => [
            project.id,
            await collaboration
              .members(project.id)
              .then((result) => result.members)
              .catch(() => cloudStore.getState().members[project.id]),
          ]),
        ),
      );
      const synced = new Set(local.filter(isSyncedProject).map((project) => project.id));
      const sync = Object.fromEntries(
        await Promise.all(
          projects
            .filter((project) => synced.has(project.id))
            .map(async (project) => [
              project.id,
              await collaboration.syncState(project.id).catch(() => undefined),
            ]),
        ),
      );
      const fetchedAt = new Date().toISOString();
      cloudStore.setState({
        projects,
        members,
        sync,
        fetchedAt,
        reachable: true,
        error: '',
        loading: false,
      });
      remember(projects);
      try {
        localStorage.setItem(cacheKey, JSON.stringify({ projects, members, fetchedAt }));
      } catch {
        /* The cache only helps offline. */
      }
    } catch (reason) {
      cloudStore.setState({
        reachable: false,
        loading: false,
        error: translateError(String(reason)),
      });
    }
  })().finally(() => {
    running = null;
  });
  return running;
}

/** Reload one project's members after an invitation, role change or removal. */
export async function reloadMembers(projectId: string) {
  const { members } = await collaboration.members(projectId);
  cloudStore.setState((state) => ({ members: { ...state.members, [projectId]: members } }));
}

/** Sync one project now and show its new state. */
export async function syncNow(projectId: string) {
  try {
    await collaboration.syncProject(projectId);
  } finally {
    const state = await collaboration.syncState(projectId).catch(() => undefined);
    cloudStore.setState((current) => ({ sync: { ...current.sync, [projectId]: state } }));
  }
}

/** A cloud project is a team project unless it only has its owner, me, and no local team marker. */
export function isTeamCloudProject(
  remote: CollaborationProject,
  local: Project | undefined,
  members: CollaborationMember[] | undefined,
  userId: string | null | undefined,
) {
  if (local) return isTeamProject(local);
  if (remote.role !== 'owner') return true;
  if (!members) return true;
  return members.some((member) => member.id !== userId);
}

export type CloudEntry = {
  remote: CollaborationProject;
  local?: Project;
  members?: CollaborationMember[];
  sync?: ProjectSyncState;
};

/** Split the cloud list into team projects and my own projects that live on other devices. */
export function classifyCloud(snapshot: CloudSnapshot, local: Project[]) {
  const byId = new Map(local.map((project) => [project.id, project]));
  const team: CloudEntry[] = [];
  const elsewhere: CloudEntry[] = [];
  for (const remote of snapshot.projects) {
    const entry: CloudEntry = {
      remote,
      local: byId.get(remote.id),
      members: snapshot.members[remote.id],
      sync: snapshot.sync[remote.id],
    };
    if (isTeamCloudProject(remote, entry.local, entry.members, snapshot.state?.userId))
      team.push(entry);
    else if (!entry.local) elsewhere.push(entry);
  }
  return { team, elsewhere };
}

function readSeen(): string[] | null {
  try {
    const value = JSON.parse(localStorage.getItem(seenKey) ?? 'null');
    return Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}
function writeSeen(ids: string[]) {
  try {
    localStorage.setItem(seenKey, JSON.stringify(ids));
  } catch {
    /* Without storage every project counts as seen. */
  }
}
/** The first list on a device marks everything as known; later additions count as new. */
function remember(projects: CollaborationProject[]) {
  if (readSeen() === null) writeSeen(projects.map((project) => project.id));
}
export function isNewCloudProject(id: string) {
  const seen = readSeen();
  return seen !== null && !seen.includes(id);
}
export function markCloudSeen(id: string) {
  const seen = readSeen() ?? [];
  if (!seen.includes(id)) writeSeen([...seen, id]);
  cloudStore.setState({});
}
