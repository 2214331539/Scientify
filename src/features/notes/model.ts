import { t } from '../../i18n';
import type { WorkContext } from '../../domain/context';
import type { ResearchRecord, Workspace } from '../../domain/workspace';
import type { WorkspaceStore } from '../../stores/workspace';

export const PERSONAL_SCOPE = '__inbox__';
export type NoteSource = WorkContext & { id: string; capturedAt: string; messageId?: string };
export type Note = ResearchRecord & { sources?: NoteSource[]; deletedAt?: string };
export const scopeFor = (context: WorkContext) => context.projectId ?? PERSONAL_SCOPE;

/** Deleted notes wait this long in the recycle bin before they are removed for good. */
export const TRASH_DAYS = 30;
/** A deleted note keeps its record with a deletion time, so the deletion syncs like an edit. */
export const isTrashed = (record: object) =>
  typeof (record as { deletedAt?: unknown }).deletedAt === 'string';

export function selectNotes(data: Workspace | null, scope: string, query = ''): Note[] {
  const term = query.trim().toLocaleLowerCase();
  return (data?.records ?? [])
    .filter(
      (note) =>
        note.project === scope &&
        !isTrashed(note) &&
        `${note.title} ${note.body}`.toLocaleLowerCase().includes(term),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) as Note[];
}

export function selectTrash(data: Workspace | null, scope: string): Note[] {
  return (
    (data?.records ?? []).filter((note) => note.project === scope && isTrashed(note)) as Note[]
  ).sort((a, b) => (b.deletedAt ?? '').localeCompare(a.deletedAt ?? ''));
}

function changeNote(
  store: WorkspaceStore,
  scope: string,
  id: string,
  change: (data: Workspace, index: number) => void,
) {
  return store.getState().update((data) => {
    const index = data.records.findIndex((record) => record.id === id && record.project === scope);
    if (index >= 0) change(data, index);
  });
}

export const trashNote = (store: WorkspaceStore, scope: string, id: string) =>
  changeNote(store, scope, id, (data, index) => {
    data.records[index] = { ...data.records[index], deletedAt: new Date().toISOString() };
  });

export const restoreNote = (store: WorkspaceStore, scope: string, id: string) =>
  changeNote(store, scope, id, (data, index) => {
    const { deletedAt: _deletedAt, ...note } = data.records[index];
    data.records[index] = note as Workspace['records'][number];
  });

export const purgeNote = (store: WorkspaceStore, scope: string, id: string) =>
  changeNote(store, scope, id, (data, index) => {
    data.records.splice(index, 1);
  });

/** Notes deleted more than {@link TRASH_DAYS} days ago. */
export function expiredNotes(data: Workspace | null, now = Date.now()) {
  const limit = now - TRASH_DAYS * 24 * 60 * 60 * 1000;
  return (data?.records ?? []).filter(
    (record) => isTrashed(record) && Date.parse(String(record.deletedAt)) < limit,
  );
}

/** Remove expired notes; writes nothing when there are none. */
export async function purgeExpiredNotes(store: WorkspaceStore) {
  if (!expiredNotes(store.getState().data).length) return true;
  return store.getState().update((data) => {
    const expired = new Set(expiredNotes(data).map((record) => record.id));
    data.records = data.records.filter((record) => !expired.has(record.id));
  });
}

export function createNote(scope: string, title = t('未命名笔记'), body = ''): Note {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    project: scope,
    title,
    body,
    type: 'note',
    status: 'draft',
    createdAt: now,
    updatedAt: now,
    sources: [],
  };
}

export function captureSource(context: WorkContext, messageId?: string): NoteSource {
  return {
    ...context,
    text: context.text?.slice(0, 12000),
    selection: context.selection?.slice(0, 12000),
    id: crypto.randomUUID(),
    capturedAt: new Date().toISOString(),
    ...(messageId ? { messageId } : {}),
  };
}

export const noteFingerprint = (note: Note) =>
  JSON.stringify([note.id, note.title, note.body, note.sources]);

export function readNoteSources(note: Note | null): NoteSource[] {
  if (!Array.isArray(note?.sources)) return [];
  return note.sources.filter(
    (source) =>
      source &&
      typeof source === 'object' &&
      typeof source.id === 'string' &&
      typeof source.title === 'string' &&
      ['overview', 'literature', 'notes', 'experiments', 'writing', 'files', 'projects'].includes(
        source.workspace,
      ) &&
      (source.projectId === undefined || typeof source.projectId === 'string'),
  );
}

export async function persistNote(store: WorkspaceStore, note: Note): Promise<boolean> {
  const snapshot = structuredClone(note);
  return store.getState().update((data) => {
    const index = data.records.findIndex(
      (record) => record.id === snapshot.id && record.project === snapshot.project,
    );
    const value = {
      ...snapshot,
      title: snapshot.title.trim() || t('未命名笔记'),
      updatedAt: new Date().toISOString(),
    };
    if (index < 0) data.records.push(value);
    else data.records[index] = { ...data.records[index], ...value };
  });
}
