import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { Block, Page, PageSummary } from '../workspaces/docs/model';
import { requestProjectSync } from './collaboration';

export type DocHit = { id: string; title: string; icon?: string | null; snippet: string };
export type DocSnapshot = { at: string; size: number };
/** Written when another page changed: by sync, the AI or another view. */
export type DocsChange = { projectId: string; id?: string; version?: string };

export interface DocsBackend {
  available(): boolean;
  list(projectId: string): Promise<PageSummary[]>;
  read(projectId: string, id: string): Promise<{ page: Page; version: string }>;
  /** `expected` is the version that was read; `null` creates the page. Returns the new version. */
  write(projectId: string, page: Page, expected: string | null): Promise<string>;
  purge(projectId: string, id: string): Promise<void>;
  search(projectId: string, query: string): Promise<DocHit[]>;
  history(projectId: string, id: string): Promise<DocSnapshot[]>;
  snapshot(projectId: string, id: string, at: string): Promise<Page>;
  /** Three-way merge of a page changed here and elsewhere, block by block. */
  merge(base: Page | null, local: Page, remote: Page): Promise<{ page: Page; conflicts: number }>;
  changed(callback: (change: DocsChange) => void): Promise<() => void>;
  /** Saves Markdown where the person chooses, with its images; false when cancelled. */
  exportMarkdown?(
    projectId: string,
    name: string,
    markdown: string,
    images: string[],
  ): Promise<boolean>;
  /** Markdown files the person chooses. */
  importMarkdown?(): Promise<{ name: string; content: string }[]>;
  /** Saves a file made from a page (a Word document) where the person chooses; false when cancelled. */
  saveFile?(name: string, extension: 'docx', data: Uint8Array): Promise<boolean>;
}

/** The message the native side gives when a page changed since it was read. */
export const STALE_PAGE = '页面已在别处修改，请重新打开后再保存。';

export const nativeDocs: DocsBackend = {
  available: isTauri,
  list: (projectId) => invoke('docs_list', { projectId }),
  read: (projectId, id) => invoke('docs_read', { projectId, id }),
  write: async (projectId, page, expected) => {
    const version = await invoke<string>('docs_write', {
      projectId,
      page,
      expectedVersion: expected,
    });
    requestProjectSync(projectId);
    return version;
  },
  purge: async (projectId, id) => {
    await invoke('docs_purge', { projectId, id });
    requestProjectSync(projectId);
  },
  search: (projectId, query) => invoke('docs_search', { projectId, query }),
  history: (projectId, id) => invoke('docs_history', { projectId, id }),
  snapshot: (projectId, id, at) => invoke('docs_history', { projectId, id, at }),
  merge: (base, local, remote) => invoke('docs_merge', { base, local, remote }),
  changed: (callback) => listen<DocsChange>('docs-changed', (event) => callback(event.payload)),
  exportMarkdown: (projectId, name, markdown, images) =>
    invoke('docs_export', { projectId, name, markdown, images }),
  importMarkdown: () => invoke('docs_import'),
  saveFile: (name, extension, data) => {
    let binary = '';
    for (let at = 0; at < data.length; at += 0x8000)
      binary += String.fromCharCode(...data.subarray(at, at + 0x8000));
    return invoke('docs_save_file', { name, extension, data: btoa(binary) });
  },
};

/**
 * Pages kept in memory, for the browser preview and tests. Versions are change counters. Pages
 * given at the start belong to every project; written ones to the project that wrote them.
 */
export function memoryDocs(seed: Page[] = []): DocsBackend & { pages: Map<string, Page> } {
  const pages = new Map(seed.map((page) => [page.id, structuredClone(page)]));
  const versions = new Map(seed.map((page) => [page.id, '1']));
  const owners = new Map<string, string>();
  const listeners = new Set<(change: DocsChange) => void>();
  const mine = (projectId: string, id: string) =>
    pages.has(id) && (owners.get(id) ?? projectId) === projectId;
  const notify = (change: DocsChange) => {
    for (const listener of [...listeners]) listener(change);
  };
  return {
    pages,
    available: () => true,
    list: async (projectId) =>
      [...pages.values()]
        .filter((page) => mine(projectId, page.id))
        .map(({ blocks: _b, schema: _s, ...summary }) => summary),
    read: async (projectId, id) => {
      if (!mine(projectId, id)) throw new Error('页面不存在或已被彻底删除。');
      return { page: structuredClone(pages.get(id)!), version: versions.get(id)! };
    },
    write: async (projectId, page, expected) => {
      const current = mine(projectId, page.id) ? (versions.get(page.id) ?? null) : null;
      if (current !== expected)
        throw new Error(
          current && expected
            ? STALE_PAGE
            : current
              ? '页面已存在。'
              : '页面不存在或已被彻底删除。',
        );
      const version = String(Number(current ?? 0) + 1);
      pages.set(page.id, structuredClone(page));
      versions.set(page.id, version);
      if (!owners.has(page.id) && !seed.some((item) => item.id === page.id))
        owners.set(page.id, projectId);
      notify({ projectId, id: page.id, version });
      return version;
    },
    purge: async (projectId, id) => {
      if (!mine(projectId, id)) return;
      pages.delete(id);
      versions.delete(id);
      owners.delete(id);
      notify({ projectId, id });
    },
    search: async (projectId, query) =>
      [...pages.values()]
        .filter(
          (page) =>
            mine(projectId, page.id) && !page.deletedAt && JSON.stringify(page).includes(query),
        )
        .map((page) => ({ id: page.id, title: page.title, icon: page.icon, snippet: '' })),
    history: async () => [],
    snapshot: async () => {
      throw new Error('没有历史版本。');
    },
    merge: async (_base, _local, remote) => ({ page: remote, conflicts: 0 }),
    changed: async (callback) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
  };
}

let browserDocs: DocsBackend | null = null;
/** Documents on disk in the app; in memory in the browser preview and tests. */
export function appDocs(): DocsBackend {
  if (isTauri()) return nativeDocs;
  return (browserDocs ??= memoryDocs());
}
/** For tests: start the in-memory documents from empty. */
export function resetBrowserDocs() {
  browserDocs = null;
}

export type { Block, Page, PageSummary };
