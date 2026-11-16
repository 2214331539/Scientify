import type { Project } from '../../domain/workspace';
import {
  collaboration,
  collaborationStateEvent,
  isSyncedProject,
  type CollaborationMember,
  type CollaborationProject,
} from '../../platform/collaboration';
import type { WorkspaceStore } from '../../stores/workspace';
import type { CloudSnapshot } from './cloud';
import { COLLABORATION_TEAM_ID, ensureCollaborationTeam } from './model';

/**
 * Whether anyone besides me is in a cloud project (members or pending invitations), or it is
 * someone else's; undefined while its members are unknown.
 */
export function sharedWithOthers(
  remote: CollaborationProject,
  members: CollaborationMember[] | undefined,
  userId: string | null | undefined,
): boolean | undefined {
  if (remote.role !== 'owner') return true;
  if (!members || !userId) return undefined;
  return members.some((member) => member.id !== userId);
}

// Projects the server refused to publish (their id belongs to another account, as after
// leaving a shared project): they stay on this computer and are not offered again.
const refused = new Set<string>();

/**
 * One account sees the same projects on every computer. Every project here is published to the
 * signed-in account (a cloud project with its id is simply linked), every cloud project I am in
 * is added here, mine from other computers and those others share with me, and a project counts
 * as a team project only while someone else is in it. Returns the projects that became synced,
 * so they can be synced right away; nobody has to download anything.
 */
export async function reconcileAccount(
  store: WorkspaceStore,
  snapshot: CloudSnapshot,
): Promise<string[]> {
  const data = store.getState().data;
  const userId = snapshot.state?.userId;
  if (!data || !snapshot.state?.authenticated || !snapshot.reachable || !snapshot.fetchedAt)
    return [];
  // Older versions had a switch to turn syncing off; signed in, it is always on now.
  if (!snapshot.state.enabled)
    await collaboration.configure(snapshot.state.endpoint, true).catch(() => undefined);
  const remote = new Map(snapshot.projects.map((project) => [project.id, project]));
  const roles = new Map<string, string>();
  for (const project of data.projects) {
    if (isSyncedProject(project) || refused.has(project.id)) continue;
    const linked = remote.get(project.id);
    if (linked) {
      roles.set(project.id, linked.role);
      continue;
    }
    try {
      const created = await collaboration.createProject(project.name, project.id);
      roles.set(project.id, created.role || 'owner');
    } catch {
      refused.add(project.id);
    }
  }
  const local = new Set(data.projects.map((project) => project.id));
  const arriving = snapshot.projects
    .filter((entry) => !local.has(entry.id))
    .map((entry) => ({
      entry,
      shared: sharedWithOthers(entry, snapshot.members[entry.id], userId),
    }))
    .filter((item) => item.shared !== undefined);
  const placement = (project: Project) => {
    const entry = remote.get(project.id);
    if (!entry || !(isSyncedProject(project) || roles.has(project.id))) return null;
    const shared = sharedWithOthers(entry, snapshot.members[project.id], userId);
    if (shared === undefined) return null;
    const space = shared ? COLLABORATION_TEAM_ID : 'personal';
    return project.space === space || (shared && project.space !== 'personal') ? null : space;
  };
  if (!roles.size && !arriving.length && !data.projects.some(placement)) return [];
  const timestamp = new Date().toISOString();
  const saved = await store.getState().update((value) => {
    for (const project of value.projects) {
      const role = roles.get(project.id);
      if (role && !isSyncedProject(project)) project.collaborationRole = role;
      const space = placement(project);
      if (space === COLLABORATION_TEAM_ID) ensureCollaborationTeam(value);
      if (space) project.space = space;
    }
    for (const { entry, shared } of arriving) {
      if (value.projects.some((project) => project.id === entry.id)) continue;
      if (shared) ensureCollaborationTeam(value);
      value.projects.push({
        id: entry.id,
        name: entry.name,
        question: '',
        createdAt: entry.createdAt ?? timestamp,
        updatedAt: entry.updatedAt ?? timestamp,
        space: shared ? COLLABORATION_TEAM_ID : 'personal',
        color: '#56746a',
        collaborationRole: entry.role,
      });
    }
  });
  return saved ? [...roles.keys(), ...arriving.map(({ entry }) => entry.id)] : [];
}

// The cloud's change number for each project when this computer last synced it.
const seen = new Map<string, number>();

/** Synced projects whose cloud copy changed since this computer last synced them. */
export function changedProjects(snapshot: CloudSnapshot, local: Project[]) {
  const synced = new Set(local.filter(isSyncedProject).map((project) => project.id));
  return snapshot.projects
    .filter(
      (remote) =>
        synced.has(remote.id) &&
        remote.changeSeq !== undefined &&
        seen.get(remote.id) !== remote.changeSeq,
    )
    .map((remote) => remote.id);
}

let syncing: Promise<void> | null = null;
/**
 * Syncs the synced projects on this computer one at a time (all of them, or `only` those),
 * except the open one, whose own schedule runs it. Projects not opened for a while still match
 * the other computers.
 */
export function syncAccount(
  store: WorkspaceStore,
  {
    skip,
    only,
    snapshot,
  }: { skip?: string | null; only?: string[]; snapshot?: CloudSnapshot } = {},
): Promise<void> {
  if (syncing) return syncing;
  syncing = (async () => {
    const ids = (store.getState().data?.projects ?? [])
      .filter(
        (project) =>
          isSyncedProject(project) && project.id !== skip && (!only || only.includes(project.id)),
      )
      .map((project) => project.id);
    let reload = false;
    for (const id of ids) {
      try {
        const state = await collaboration.syncState(id);
        if (state.syncing) continue;
        // Older versions could turn syncing off on one computer; it is always on now.
        if (state.paused) await collaboration.setProjectSync(id, true);
        const changeSeq = snapshot?.projects.find((remote) => remote.id === id)?.changeSeq;
        const outcome = await collaboration.syncProject(id);
        if (changeSeq !== undefined) seen.set(id, changeSeq);
        if (
          outcome.changed.some((kind) => ['project', 'record', 'experiment', 'run'].includes(kind))
        )
          reload = true;
      } catch {
        /* Offline or signed out: the next round tries again. */
      }
    }
    if (reload) await store.getState().refreshSaved();
    if (ids.length) window.dispatchEvent(new Event(collaborationStateEvent));
  })().finally(() => {
    syncing = null;
  });
  return syncing;
}
