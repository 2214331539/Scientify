import { listen } from '@tauri-apps/api/event';
import { isTauri } from '@tauri-apps/api/core';
import { localCommand } from './library';

export type ImportKind = 'zotero' | 'file';

export type ImportCollection = { id: string; name: string; parent: string | null; items: number };

/** What importing a source would bring, read once and imported as shown. */
export type ImportPreview = {
  id: string;
  kind: 'zotero' | 'bibtex' | 'ris';
  location: string;
  fromBackup: boolean;
  collections: ImportCollection[];
  unfiled: number;
  items: number;
  pdfs: number;
  missing: number;
  notes: number;
  highlights: number;
  withoutPdf: number;
  warnings: string[];
  folder: string;
};

export type ImportReport = {
  papers: number;
  duplicates: number;
  highlights: number;
  notes: number;
  references: number;
  withoutPdf: number;
  missing: number;
  failed: string[];
  cancelled: boolean;
  folder: string;
};

export type ImportProgress = { done: number; total: number; title: string };

/** Zotero, BibTeX and RIS into a project's literature folder. */
export interface ReferenceImport {
  sources(): Promise<{ zotero: string[] }>;
  pick(kind: ImportKind): Promise<string | null>;
  preview(kind: ImportKind, path?: string | null): Promise<ImportPreview>;
  run(
    projectId: string,
    previewId: string,
    collections: string[] | null,
    folder: string,
  ): Promise<ImportReport>;
  cancel(): Promise<void>;
  progress(callback: (progress: ImportProgress) => void): Promise<() => void>;
}

export const nativeReferenceImport: ReferenceImport = {
  sources: () => localCommand('library_import_sources'),
  pick: (kind) => localCommand('library_import_pick', { kind }),
  preview: (kind, path) => localCommand('library_import_preview', { kind, path: path ?? null }),
  run: (projectId, previewId, collections, folder) =>
    localCommand('library_import_run', { projectId, previewId, collections, folder }),
  cancel: () => localCommand('library_import_cancel'),
  progress: (callback) =>
    isTauri()
      ? listen<ImportProgress>('library-import-progress', (event) => callback(event.payload))
      : Promise.resolve(() => {}),
};
