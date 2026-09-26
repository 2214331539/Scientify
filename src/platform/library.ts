import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { ResearchBackend } from './research';

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
  | { op: 'mkdir' | 'open' | 'delete'; path: string }
  | { op: 'transfer'; path: string; destination: string; copy: boolean }
  | { op: 'relink'; id: string; path: string };
export type LibraryNote = { content: string; revision: string | null };
export interface LibraryBackend {
  choose(projectId: string): Promise<LibraryScan | null>;
  command(projectId: string, operation: LibraryOperation): Promise<LibraryScan>;
  open(projectId: string, path: string): Promise<LibraryPaper>;
  pdf(projectId: string, id: string): Promise<Uint8Array>;
  note(projectId: string, id: string): Promise<LibraryNote>;
  saveNote(
    projectId: string,
    id: string,
    content: string,
    revision: string | null,
    copy?: string,
  ): Promise<LibraryNote>;
  external(projectId: string, path: string, open: boolean): Promise<void>;
  import(projectId: string, migrate: boolean): Promise<LibraryScan | null>;
  changed(callback: (projectId: string, error?: string) => void): Promise<() => void>;
}
export function localCommand<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) return Promise.reject(new Error('请在桌面应用中使用本地文献目录和内嵌浏览器。'));
  return invoke<T>(name, args);
}
export const nativeLibrary: LibraryBackend = {
  choose: (projectId) => localCommand('library_choose', { projectId }),
  command: (projectId, operation) => localCommand('library_command', { projectId, operation }),
  open: (projectId, path) => localCommand('library_open', { projectId, path }),
  pdf: async (projectId, id) =>
    new Uint8Array(await localCommand<ArrayBuffer>('library_pdf', { projectId, id })),
  note: (projectId, id) =>
    localCommand('library_note', { projectId, id, content: null, revision: null, copy: null }),
  saveNote: (projectId, id, content, revision, copy) =>
    localCommand('library_note', { projectId, id, content, revision, copy: copy ?? null }),
  external: (projectId, path, open) => localCommand('library_external', { projectId, path, open }),
  import: (projectId, migrate) => localCommand('library_import', { projectId, migrate }),
  changed: (callback) =>
    isTauri()
      ? listen<{ projectId: string; error?: string }>('library-changed', (event) =>
          callback(event.payload.projectId, event.payload.error),
        )
      : Promise.resolve(() => {}),
};

const adapters = new WeakMap<LibraryBackend, ResearchBackend>();
/** Reuse the proven file buffer/conflict runtime for adjacent paper notes. */
export function noteFiles(library: LibraryBackend): ResearchBackend {
  let adapter = adapters.get(library);
  if (adapter) return adapter;
  const unsupported = async () => {
    throw new Error('该操作不适用于论文笔记。');
  };
  adapter = {
    listFiles: async () => [],
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
      return { path: id, content: note.content, version: note.revision ?? 'missing' };
    },
    importPdf: unsupported,
    readPdf: unsupported,
    gitStatus: unsupported,
    askAI: unsupported,
    fetchArxiv: unsupported,
  };
  adapters.set(library, adapter);
  return adapter;
}
