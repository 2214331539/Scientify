import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { emptyWorkspace, type Project } from '../../domain/workspace';
import { collaboration, type CollaborationMember } from '../../platform/collaboration';
import { createWorkspaceStore } from '../../stores/workspace';
import { changedProjects, reconcileAccount, sharedWithOthers, syncAccount } from './accountSync';
import type { CloudSnapshot } from './cloud';
import { COLLABORATION_TEAM_ID } from './model';

const me = 'user-me';
const project = (id: string, extra: Partial<Project> = {}): Project => ({
  id,
  name: id,
  question: '',
  space: 'personal',
  createdAt: '2026-11-01',
  ...extra,
});
const member = (id: string, pending = false): CollaborationMember => ({
  id,
  phone: '',
  role: id === me ? 'owner' : 'editor',
  pending,
});

async function setup(projects: Project[]) {
  const data = emptyWorkspace();
  data.projects = projects;
  const persistence = {
    load: async () => ({ workspace: data, directory: '', legacyAvailable: false }),
    save: vi.fn(async (value: typeof data) => value),
    restore: async () => data,
    migrateLegacy: async () => data,
    importWorkspace: async () => null,
    exportWorkspace: async () => true,
    chooseDirectory: async () => null,
  };
  const store = createWorkspaceStore(persistence);
  await store.getState().load();
  return { store, persistence };
}
const snapshot = (patch: Partial<CloudSnapshot>): CloudSnapshot => ({
  available: true,
  state: {
    authenticated: true,
    enabled: true,
    clientId: 'device',
    endpoint: '',
    userId: me,
    phone: null,
  },
  reachable: true,
  loading: false,
  error: '',
  projects: [],
  members: {},
  sync: {},
  fetchedAt: '2026-11-15T12:00:00Z',
  ...patch,
});
const byId = (store: Awaited<ReturnType<typeof setup>>['store'], id: string) =>
  store.getState().data!.projects.find((item) => item.id === id);

beforeEach(() => {
  vi.spyOn(collaboration, 'createProject').mockImplementation(async (name, id) => ({
    id: id!,
    name,
    role: 'owner',
  }));
});
afterEach(() => vi.restoreAllMocks());

it('publishes every project on this computer to the signed-in account', async () => {
  const { store } = await setup([
    project('proactive-1397'),
    project('foundation-4231'),
    project('shared-elsewhere', { collaborationRole: 'editor', space: COLLABORATION_TEAM_ID }),
  ]);
  const linked = await reconcileAccount(
    store,
    snapshot({
      projects: [
        { id: 'proactive-1397', name: 'Proactive', role: 'owner' },
        { id: 'shared-elsewhere', name: 'Shared', role: 'editor' },
      ],
      members: { 'proactive-1397': [member(me)] },
    }),
  );
  expect(linked.sort()).toEqual(['foundation-4231', 'proactive-1397']);
  // A cloud project with the same id is linked, not created again.
  expect(collaboration.createProject).toHaveBeenCalledTimes(1);
  expect(collaboration.createProject).toHaveBeenCalledWith('foundation-4231', 'foundation-4231');
  expect(byId(store, 'proactive-1397')).toMatchObject({
    collaborationRole: 'owner',
    space: 'personal',
  });
  expect(byId(store, 'foundation-4231')?.collaborationRole).toBe('owner');
});

it('adds every cloud project I am in, filed by who else is in it', async () => {
  const { store } = await setup([]);
  const linked = await reconcileAccount(
    store,
    snapshot({
      projects: [
        { id: 'agent-memory', name: 'Agent Memory', role: 'owner', createdAt: '2026-10-01' },
        { id: 'with-a-friend', name: 'Joint', role: 'owner' },
        { id: 'not-mine', name: 'Theirs', role: 'editor' },
        { id: 'members-unknown', name: 'Unknown', role: 'owner' },
      ],
      members: {
        'agent-memory': [member(me)],
        'with-a-friend': [member(me), member('invite:138', true)],
        'not-mine': [member('them'), member(me)],
      },
    }),
  );
  // Members still unknown: it waits for the next refresh.
  expect(linked).toEqual(['agent-memory', 'with-a-friend', 'not-mine']);
  expect(store.getState().data!.projects).toEqual([
    expect.objectContaining({
      id: 'agent-memory',
      name: 'Agent Memory',
      space: 'personal',
      collaborationRole: 'owner',
      createdAt: '2026-10-01',
    }),
    expect.objectContaining({ id: 'with-a-friend', space: COLLABORATION_TEAM_ID }),
    expect.objectContaining({
      id: 'not-mine',
      space: COLLABORATION_TEAM_ID,
      collaborationRole: 'editor',
    }),
  ]);
});

it('files a project under team projects only while someone else is in it', async () => {
  const { store } = await setup([
    project('alone-but-team', { collaborationRole: 'owner', space: COLLABORATION_TEAM_ID }),
    project('now-shared', { collaborationRole: 'owner' }),
    project('unknown', { collaborationRole: 'owner', space: COLLABORATION_TEAM_ID }),
  ]);
  await reconcileAccount(
    store,
    snapshot({
      projects: ['alone-but-team', 'now-shared', 'unknown'].map((id) => ({
        id,
        name: id,
        role: 'owner',
      })),
      members: {
        'alone-but-team': [member(me)],
        'now-shared': [member(me), member('invite:139', true)],
      },
    }),
  );
  expect(byId(store, 'alone-but-team')?.space).toBe('personal');
  expect(byId(store, 'now-shared')?.space).toBe(COLLABORATION_TEAM_ID);
  expect(store.getState().data!.teams.some((team) => team.id === COLLABORATION_TEAM_ID)).toBe(true);
  expect(byId(store, 'unknown')?.space).toBe(COLLABORATION_TEAM_ID);
  expect(sharedWithOthers({ id: 'x', name: 'x', role: 'viewer' }, undefined, me)).toBe(true);
});

it('does nothing while signed out or offline, and does not write when nothing changes', async () => {
  const { store, persistence } = await setup([project('local-only')]);
  expect(await reconcileAccount(store, snapshot({ state: null }))).toEqual([]);
  expect(await reconcileAccount(store, snapshot({ reachable: false }))).toEqual([]);
  expect(collaboration.createProject).not.toHaveBeenCalled();
  const synced = await setup([project('done', { collaborationRole: 'owner' })]);
  await reconcileAccount(
    synced.store,
    snapshot({
      projects: [{ id: 'done', name: 'done', role: 'owner' }],
      members: { done: [member(me)] },
    }),
  );
  expect(synced.persistence.save).not.toHaveBeenCalled();
  expect(persistence.save).not.toHaveBeenCalled();
});

it('keeps a project the server refuses on this computer without asking again', async () => {
  vi.mocked(collaboration.createProject).mockRejectedValue(new Error('项目标识已被使用。'));
  const { store } = await setup([project('left-team-project')]);
  expect(await reconcileAccount(store, snapshot({}))).toEqual([]);
  await reconcileAccount(store, snapshot({ fetchedAt: '2026-11-15T12:02:00Z' }));
  expect(collaboration.createProject).toHaveBeenCalledTimes(1);
  expect(byId(store, 'left-team-project')?.collaborationRole).toBeUndefined();
});

it('syncs every synced project except the open one, resuming any paused one', async () => {
  const { store } = await setup([
    project('a', { collaborationRole: 'owner' }),
    project('b', { collaborationRole: 'owner' }),
    project('open', { collaborationRole: 'owner' }),
    project('local'),
  ]);
  vi.spyOn(collaboration, 'syncState').mockImplementation(async (id) => ({
    lastSyncAt: null,
    lastError: null,
    conflicts: [],
    tracked: 0,
    libraryRoot: null,
    paused: id === 'b',
  }));
  const synced: string[] = [];
  vi.spyOn(collaboration, 'syncProject').mockImplementation(async (id) => {
    synced.push(id);
    return {
      pulled: 1,
      applied: 1,
      pushed: 0,
      conflicts: 0,
      skipped: 0,
      deferred: 0,
      errors: [],
      changed: ['record'],
      libraryRoot: null,
      lastSyncAt: '2026-11-15T12:00:00Z',
    };
  });
  const resume = vi.spyOn(collaboration, 'setProjectSync').mockResolvedValue();
  const reload = vi.spyOn(store.getState(), 'refreshSaved').mockResolvedValue(true);
  await syncAccount(store, { skip: 'open' });
  expect(synced).toEqual(['a', 'b']);
  expect(resume).toHaveBeenCalledWith('b', true);
  expect(reload).toHaveBeenCalledTimes(1);
  // A change on another computer is picked up from the cloud's change number.
  const cloud = snapshot({
    projects: ['a', 'b', 'open', 'elsewhere'].map((id) => ({
      id,
      name: id,
      role: 'owner',
      changeSeq: 4,
    })),
  });
  const local = store.getState().data!.projects;
  expect(changedProjects(cloud, local)).toEqual(['a', 'b', 'open']);
  synced.length = 0;
  await syncAccount(store, { only: ['a'], snapshot: cloud });
  expect(synced).toEqual(['a']);
  expect(changedProjects(cloud, local)).toEqual(['b', 'open']);
  const later = snapshot({ projects: [{ id: 'a', name: 'a', role: 'owner', changeSeq: 5 }] });
  expect(changedProjects(later, local)).toEqual(['a']);
});
