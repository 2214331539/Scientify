import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { FileBackend } from './research';
import { collaboration, collaborationEntityId } from './collaboration';

export type LibraryPaper = { id: string; path: string; notePath: string; fingerprint: string };
export type LibraryEntry = {
  path: string;
  name: string;
  directory: boolean;
  pdf: boolean;
  note: boolean;
  size: number;
  paperId: string | null;
};
export type LibraryScan = {
  root: string | null;
  entries: LibraryEntry[];
  papers: LibraryPaper[];
  warnings: string[];
};
export type LibraryOperation =
  | { op: 'scan' | 'detach' }
  | { op: 'pruneMissing'; id: string }
  | { op: 'mkdir' | 'open' | 'delete'; path: string }
  | { op: 'transfer'; path: string; destination: string; copy: boolean }
  | { op: 'relink'; id: string; path: string };
export type LibraryNote = { content: string; revision: string | null };
export type LibraryFile = { path: string; content: string; version: string };
export interface LibraryBackend {
  choose(projectId: string): Promise<LibraryScan | null>;
  command(projectId: string, operation: LibraryOperation): Promise<LibraryScan>;
  open(projectId: string, path: string): Promise<LibraryPaper>;
  pdf(projectId: string, id: string): Promise<Uint8Array>;
  readFile?(projectId: string, path: string): Promise<LibraryFile>;
  note(projectId: string, id: string): Promise<LibraryNote>;
  saveNote(
    projectId: string,
    id: string,
    content: string,
    revision: string | null,
    copy?: string,
  ): Promise<LibraryNote>;
  external(projectId: string, path: string, open: boolean): Promise<void>;
  importFile(projectId: string, folder: string, file: File): Promise<LibraryScan>;
  changed(callback: (projectId: string, error?: string) => void): Promise<() => void>;
}
export function localCommand<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) return Promise.reject(new Error('请在桌面应用中使用本地文献目录和内嵌浏览器。'));
  return invoke<T>(name, args);
}

/** Persist a literature mutation locally first, then add it to the offline outbox. */
export async function queueLiteratureMutation(
  entityId: string,
  kind: string,
  payload: unknown,
): Promise<void> {
  if (!isTauri()) return;
  await collaboration.enqueueIfEnabled({
    operationId: crypto.randomUUID(),
    domain: 'literature',
    // Outbox identifiers are deliberately path-free; the original relative
    // path stays in the payload and is validated by the local library.
    entityId: collaborationEntityId(entityId),
    baseRevision: 0,
    kind,
    payload,
    createdAt: new Date().toISOString(),
  });
}
export const nativeLibrary: LibraryBackend = {
  choose: (projectId) => localCommand('library_choose', { projectId }),
  command: (projectId, operation) => localCommand('library_command', { projectId, operation }),
  open: (projectId, path) => localCommand('library_open', { projectId, path }),
  pdf: async (projectId, id) =>
    new Uint8Array(await localCommand<ArrayBuffer>('library_pdf', { projectId, id })),
  readFile: (projectId, path) => localCommand('library_read_file', { projectId, path }),
  note: (projectId, id) =>
    localCommand('library_note', { projectId, id, content: null, revision: null, copy: null }),
  saveNote: (projectId, id, content, revision, copy) =>
    localCommand('library_note', { projectId, id, content, revision, copy: copy ?? null }),
  external: (projectId, path, open) => localCommand('library_external', { projectId, path, open }),
  importFile: async (projectId, folder, file) => {
    if (file.size > 150 * 1024 * 1024) throw new Error('文件名无效或文件超过 150 MiB。');
    if (!isTauri()) throw new Error('请在桌面应用中使用本地文献目录和内嵌浏览器。');
    const metadata = JSON.stringify({ projectId, folder, name: file.name }).replace(
      /[\u007f-\uffff]/g,
      (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
    );
    return invoke('library_import_bytes', await file.arrayBuffer(), {
      headers: { 'x-scientify-file': metadata },
    });
  },
  changed: (callback) =>
    isTauri()
      ? listen<{ projectId: string; error?: string }>('library-changed', (event) =>
          callback(event.payload.projectId, event.payload.error),
        )
      : Promise.resolve(() => {}),
};

const adapters = new WeakMap<LibraryBackend, FileBackend>();
/** Reuse the proven file buffer/conflict runtime for adjacent paper notes. */
export function noteFiles(library: LibraryBackend): FileBackend {
  let adapter = adapters.get(library);
  if (adapter) return adapter;
  adapter = {
    readFile: async (project, id) => {
      const note = await library.note(project, id);
      return { path: id, content: note.content, version: note.revision ?? 'missing' };
    },
    writeFile: async (project, id, content, revision) => {
      const note = await library.saveNote(
        project,
        id,
        content,
        revision === 'missing' ? null : revision,
      );
      void queueLiteratureMutation(id, 'note-upsert', {
        path: id,
        content,
        revision: note.revision,
      }).catch((error) => console.warn('Scientify collaboration outbox unavailable:', error));
      return { path: id, content: note.content, version: note.revision ?? 'missing' };
    },
  };
  adapters.set(library, adapter);
  return adapter;
}
