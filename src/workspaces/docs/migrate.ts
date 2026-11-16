/**
 * Notes from before documents existed become pages under "Notes". Ids are derived from the note,
 * so two computers moving the same notes write the same pages instead of copies.
 */
import { useEffect } from 'react';
import { t } from '../../i18n';
import type { WorkspaceStore } from '../../stores/workspace';
import type { DocsBackend } from '../../platform/docs';
import { isTrashed } from '../../features/notes/model';
import { markdownToBlocks } from './markdown';
import { blockId, childrenOf, orderBetween, type Block, type Page } from './model';
import type { DocsRuntime } from './runtime';

type NoteRecord = {
  id: string;
  project: string;
  type?: string;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
  migratedTo?: string;
  sources?: { title?: string; path?: string; page?: number }[];
};
const notesPage = (projectId: string) => `notes-${projectId}`;
export const migratedPageId = (noteId: string) => `note-${noteId}`;

function pending(store: WorkspaceStore, projectId: string) {
  return (store.getState().data?.records ?? []).filter(
    (record) =>
      record.project === projectId &&
      (record.type ?? 'note') === 'note' &&
      !(record as NoteRecord).migratedTo,
  ) as unknown as NoteRecord[];
}

function sourcesBlock(note: NoteRecord): Block[] {
  const titles = (note.sources ?? [])
    .map((source) =>
      [source.title, source.page ? t('第 {page} 页', { page: source.page }) : '']
        .filter(Boolean)
        .join(' '),
    )
    .filter(Boolean);
  return titles.length
    ? [
        {
          id: blockId(),
          type: 'callout',
          props: { emoji: '🔗' },
          content: [{ text: t('来源：') + titles.join('；') }],
        },
      ]
    : [];
}

/** Moves a project's remaining notes into documents; returns how many moved. */
export async function migrateNotes(
  store: WorkspaceStore,
  docs: DocsBackend,
  projectId: string,
  runtime?: DocsRuntime,
) {
  const notes = pending(store, projectId);
  if (!notes.length) return 0;
  const existing = (await docs.list(projectId)) ?? [];
  const ids = new Set(existing.map((page) => page.id));
  const now = new Date().toISOString();
  const parent = notesPage(projectId);
  if (!ids.has(parent)) {
    const top = childrenOf(existing, null);
    const page: Page = {
      schema: 1,
      id: parent,
      title: t('笔记'),
      icon: '📒',
      parent: null,
      order: orderBetween(top.at(-1)?.order ?? null, null),
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      blocks: [
        { id: blockId(), type: 'paragraph', content: [{ text: t('以前的笔记都在这里。') }] },
      ],
    };
    await docs.write(projectId, page, null).catch(() => {});
  }
  let order: string | null = null;
  const moved: Record<string, string> = {};
  for (const note of [...notes].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const id = migratedPageId(note.id);
    order = orderBetween(order, null);
    if (!ids.has(id)) {
      const page: Page = {
        schema: 1,
        id,
        title: note.title || t('无标题'),
        icon: null,
        parent,
        order,
        createdAt: note.createdAt || now,
        updatedAt: note.updatedAt || now,
        deletedAt: isTrashed(note) ? (note.deletedAt ?? now) : null,
        blocks: [...markdownToBlocks(note.body ?? ''), ...sourcesBlock(note)],
      };
      if (!page.blocks.length) page.blocks = [{ id: blockId(), type: 'paragraph' }];
      try {
        await docs.write(projectId, page, null);
      } catch (reason) {
        // Already written by another computer or an earlier try: the page is there.
        if (!String(reason).includes('已存在')) continue;
      }
    }
    moved[note.id] = id;
  }
  if (Object.keys(moved).length)
    await store.getState().update((data) => {
      for (const record of data.records)
        if (record.project === projectId && moved[record.id])
          (record as unknown as NoteRecord).migratedTo = moved[record.id];
    });
  await runtime?.load(true);
  return Object.keys(moved).length;
}

/** Moves notes over when the documents open and whenever old notes arrive (sync, an old AI chat). */
export function useNoteMigration(
  store: WorkspaceStore,
  docs: DocsBackend,
  projectId: string,
  runtime: DocsRuntime,
) {
  useEffect(() => {
    if (!docs.available()) return;
    let running = false;
    let again = false;
    const run = async () => {
      if (running) {
        again = true;
        return;
      }
      running = true;
      try {
        do {
          again = false;
          await migrateNotes(store, docs, projectId, runtime);
        } while (again);
      } catch {
        /* Tried again on the next change. */
      } finally {
        running = false;
      }
    };
    void run();
    return store.subscribe((state, previous) => {
      if (state.data?.records !== previous.data?.records && pending(store, projectId).length)
        void run();
    });
  }, [docs, projectId, runtime, store]);
}
