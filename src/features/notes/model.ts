import { t } from '../../i18n';
import type { WorkContext } from '../../domain/context';
import type { ResearchRecord, Workspace } from '../../domain/workspace';

export const PERSONAL_SCOPE = '__inbox__';
export type NoteSource = WorkContext & { id: string; capturedAt: string; messageId?: string };
export type Note = ResearchRecord & { sources?: NoteSource[] };
export const scopeFor = (context: WorkContext) => context.projectId ?? PERSONAL_SCOPE;

export function selectNotes(data: Workspace | null, scope: string, query = ''): Note[] {
  const term = query.trim().toLocaleLowerCase();
  return (data?.records ?? [])
    .filter(
      (note) =>
        note.project === scope && `${note.title} ${note.body}`.toLocaleLowerCase().includes(term),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) as Note[];
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

export async function persistNote(
  store: import('../../stores/workspace').WorkspaceStore,
  note: Note,
): Promise<boolean> {
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
