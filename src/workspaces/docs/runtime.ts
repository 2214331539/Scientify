/**
 * One project's documents in memory: the page tree, the pages that are open and their unsaved
 * edits. Edits are saved shortly after typing stops; when a page changed elsewhere in the
 * meantime (sync, the AI, another view) the two versions are merged block by block.
 */
import { createStore, type StoreApi } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { t } from '../../i18n';
import { errorMessage } from '../../domain/errors';
import { STALE_PAGE, type DocsBackend, type DocsChange } from '../../platform/docs';
import {
  childrenOf,
  descendants,
  freshIds,
  newPage,
  orderBetween,
  summaryOf,
  templateBlocks,
  templateTitle,
  TEMPLATES,
  TRASH_DAYS,
  type Block,
  type Page,
  type PageSummary,
  type TemplateId,
} from './model';

export type OpenPage = {
  page: Page;
  /** What was last read or saved; the base when merging. */
  base: Page;
  version: string;
  dirty: boolean;
  saving: boolean;
  error: string;
  /** Changes when the page was replaced from outside the editor, which then reloads it. */
  revision: number;
};
export type DocsState = {
  loaded: boolean;
  error: string;
  pages: PageSummary[];
  open: Record<string, OpenPage>;
  recent: string[];
  starred: string[];
  expanded: string[];
};
type Prefs = Pick<DocsState, 'recent' | 'starred' | 'expanded'>;

const SAVE_DELAY = 700;
const prefsKey = (projectId: string) => `scientify.docs.${projectId}`;
function loadPrefs(projectId: string): Prefs {
  try {
    const value = JSON.parse(localStorage.getItem(prefsKey(projectId)) ?? '{}') as Partial<Prefs>;
    const list = (items: unknown) =>
      Array.isArray(items) ? items.filter((item): item is string => typeof item === 'string') : [];
    return {
      recent: list(value.recent),
      starred: list(value.starred),
      expanded: list(value.expanded),
    };
  } catch {
    return { recent: [], starred: [], expanded: [] };
  }
}

export class DocsRuntime {
  readonly store: StoreApi<DocsState>;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private edits = new Map<string, number>();
  private stop: (() => void) | null = null;
  private listening = false;
  private loading: Promise<void> | null = null;

  constructor(
    readonly backend: DocsBackend,
    readonly projectId: string,
    private user: () => string | undefined = () => undefined,
  ) {
    this.store = createStore<DocsState>(() => ({
      loaded: false,
      error: '',
      pages: [],
      open: {},
      ...loadPrefs(projectId),
    }));
    this.store.subscribe((state, previous) => {
      if (
        state.recent === previous.recent &&
        state.starred === previous.starred &&
        state.expanded === previous.expanded
      )
        return;
      try {
        localStorage.setItem(
          prefsKey(projectId),
          JSON.stringify({
            recent: state.recent,
            starred: state.starred,
            expanded: state.expanded,
          }),
        );
      } catch {
        /* Preferences are optional. */
      }
    });
  }

  private get state() {
    return this.store.getState();
  }
  private setOpen(id: string, patch: Partial<OpenPage>) {
    const current = this.state.open[id];
    if (current)
      this.store.setState({ open: { ...this.state.open, [id]: { ...current, ...patch } } });
  }
  private upsertSummary(page: Page) {
    const summary = summaryOf(page);
    const pages = this.state.pages.filter((item) => item.id !== page.id);
    this.store.setState({ pages: [...pages, summary] });
  }

  /** Reads the page list; called again when pages change elsewhere. */
  load(force = false) {
    if (this.loading && !force) return this.loading;
    this.loading = (async () => {
      try {
        const pages = await this.backend.list(this.projectId);
        this.store.setState({ pages: Array.isArray(pages) ? pages : [], loaded: true, error: '' });
      } catch (reason) {
        this.store.setState({ loaded: true, error: errorMessage(reason) });
      }
    })();
    // Marked before the call: a change can arrive while it is still registering.
    if (!this.listening) {
      this.listening = true;
      void this.backend
        .changed((change) => this.changed(change))
        .then((stop) => {
          this.stop = stop;
        });
    }
    return this.loading;
  }
  dispose() {
    this.stop?.();
    this.stop = null;
    this.listening = false;
  }

  private changed(change: DocsChange) {
    if (change.projectId !== this.projectId) return;
    void this.load(true);
    const open = change.id ? this.state.open[change.id] : undefined;
    if (open && !open.dirty && !open.saving && change.version !== open.version)
      void this.reload(change.id!);
  }

  /** Opens a page, reading it unless an unsaved version is already in memory. */
  async open(id: string) {
    const current = this.state.open[id];
    if (current?.dirty) return current.page;
    try {
      const { page, version } = await this.backend.read(this.projectId, id);
      const now = this.state.open[id];
      if (now?.dirty) return now.page;
      this.store.setState({
        open: {
          ...this.state.open,
          [id]: {
            page,
            base: page,
            version,
            dirty: false,
            saving: false,
            error: '',
            revision: (now?.revision ?? 0) + 1,
          },
        },
      });
      this.visit(id);
      return page;
    } catch (reason) {
      this.store.setState({ error: errorMessage(reason) });
      return null;
    }
  }
  private async reload(id: string) {
    const { page, version } = await this.backend.read(this.projectId, id);
    const open = this.state.open[id];
    if (!open || open.dirty || open.saving) return;
    this.setOpen(id, { page, base: page, version, revision: open.revision + 1 });
    this.upsertSummary(page);
  }

  /** An edit from the editor or the page header; saved shortly after the last one. */
  edit(
    id: string,
    change: Partial<Pick<Page, 'title' | 'icon' | 'blocks' | 'width'>>,
    external = false,
  ) {
    const open = this.state.open[id];
    if (!open) return;
    const page = { ...open.page, ...change };
    this.edits.set(id, (this.edits.get(id) ?? 0) + 1);
    this.setOpen(id, {
      page,
      dirty: true,
      error: '',
      ...(external ? { revision: open.revision + 1 } : {}),
    });
    if (change.title !== undefined || change.icon !== undefined || change.width !== undefined)
      this.upsertSummary(page);
    clearTimeout(this.timers.get(id));
    this.timers.set(
      id,
      setTimeout(() => void this.save(id), SAVE_DELAY),
    );
  }

  async save(id: string): Promise<boolean> {
    clearTimeout(this.timers.get(id));
    const open = this.state.open[id];
    if (!open) return true;
    if (!open.dirty) return true;
    if (open.saving) {
      this.timers.set(
        id,
        setTimeout(() => void this.save(id), SAVE_DELAY),
      );
      return false;
    }
    const edits = this.edits.get(id) ?? 0;
    const page: Page = {
      ...open.page,
      updatedAt: new Date().toISOString(),
      ...(this.user() ? { updatedBy: this.user() } : {}),
    };
    this.setOpen(id, { saving: true });
    try {
      const version = await this.backend.write(this.projectId, page, open.version);
      const later = (this.edits.get(id) ?? 0) !== edits;
      this.setOpen(id, {
        version,
        base: page,
        saving: false,
        dirty: later,
        ...(later ? {} : { page }),
      });
      this.upsertSummary(page);
      if (later)
        this.timers.set(
          id,
          setTimeout(() => void this.save(id), SAVE_DELAY),
        );
      return !later;
    } catch (reason) {
      const message = errorMessage(reason);
      if (message.includes(STALE_PAGE)) return this.mergeAndSave(id, page);
      this.setOpen(id, { saving: false, error: message });
      return false;
    }
  }
  private async mergeAndSave(id: string, local: Page) {
    try {
      const open = this.state.open[id]!;
      const { page: remote, version } = await this.backend.read(this.projectId, id);
      const { page: merged } = await this.backend.merge(open.base, local, remote);
      const saved = await this.backend.write(this.projectId, merged, version);
      const now = this.state.open[id]!;
      this.setOpen(id, {
        page: merged,
        base: merged,
        version: saved,
        saving: false,
        dirty: false,
        revision: now.revision + 1,
      });
      this.upsertSummary(merged);
      return true;
    } catch (reason) {
      this.setOpen(id, { saving: false, error: errorMessage(reason) });
      return false;
    }
  }
  /** Saves every page with unsaved edits. */
  async flush() {
    const ids = Object.keys(this.state.open).filter((id) => this.state.open[id].dirty);
    const results = await Promise.all(ids.map((id) => this.save(id)));
    return results.every(Boolean);
  }
  dirty() {
    return Object.values(this.state.open).some((page) => page.dirty || page.saving);
  }

  /** Changes a page whether or not it is open. */
  private async change(id: string, update: (page: Page) => void) {
    if (this.state.open[id]) {
      const page = structuredClone(this.state.open[id].page);
      update(page);
      this.edit(id, page);
      return this.save(id);
    }
    const { page, version } = await this.backend.read(this.projectId, id);
    update(page);
    page.updatedAt = new Date().toISOString();
    if (this.user()) page.updatedBy = this.user();
    await this.backend.write(this.projectId, page, version);
    this.upsertSummary(page);
    return true;
  }

  // ---------- The tree ----------
  private orderAt(parent: string | null, index: number, skip?: string) {
    const siblings = childrenOf(this.state.pages, parent).filter((page) => page.id !== skip);
    const at = Math.max(0, Math.min(index, siblings.length));
    return orderBetween(siblings[at - 1]?.order ?? null, siblings[at]?.order ?? null);
  }
  async create(input: {
    parent: string | null;
    template?: TemplateId;
    title?: string;
    icon?: string | null;
    blocks?: Block[];
    index?: number;
  }) {
    const template = input.template ?? 'blank';
    const page = newPage({
      parent: input.parent,
      order: this.orderAt(input.parent, input.index ?? Number.MAX_SAFE_INTEGER),
      title: input.title ?? templateTitle(template),
      icon:
        input.icon ??
        (template === 'blank' ? null : TEMPLATES.find((item) => item.id === template)!.icon),
      blocks: input.blocks ?? templateBlocks(template),
      user: this.user(),
    });
    const version = await this.backend.write(this.projectId, page, null);
    this.upsertSummary(page);
    this.store.setState({
      open: {
        ...this.state.open,
        [page.id]: {
          page,
          base: page,
          version,
          dirty: false,
          saving: false,
          error: '',
          revision: 1,
        },
      },
      expanded:
        input.parent && !this.state.expanded.includes(input.parent)
          ? [...this.state.expanded, input.parent]
          : this.state.expanded,
    });
    this.visit(page.id);
    return page;
  }
  /** Moves a page under `parent` at position `index` among its new siblings. */
  async move(id: string, parent: string | null, index: number) {
    if (parent && descendants(this.state.pages, id).includes(parent))
      throw new Error(t('不能把页面移到它自己的子页面里。'));
    const order = this.orderAt(parent, index, id);
    await this.change(id, (page) => {
      page.parent = parent;
      page.order = order;
    });
    if (parent && !this.state.expanded.includes(parent))
      this.store.setState({ expanded: [...this.state.expanded, parent] });
  }
  rename(id: string, title: string) {
    return this.change(id, (page) => {
      page.title = title;
    });
  }
  setIcon(id: string, icon: string | null) {
    return this.change(id, (page) => {
      page.icon = icon;
    });
  }
  async duplicate(id: string) {
    const { page } = await this.backend.read(this.projectId, id);
    const siblings = childrenOf(this.state.pages, page.parent);
    return this.create({
      parent: page.parent,
      title: t('{title} 副本', { title: page.title || t('无标题') }),
      icon: page.icon ?? null,
      blocks: freshIds(this.state.open[id]?.page.blocks ?? page.blocks),
      index: siblings.findIndex((item) => item.id === id) + 1,
    });
  }
  /** Moves a page and its subpages to the recycle bin. */
  async trash(id: string) {
    const at = new Date().toISOString();
    const ids = descendants(this.state.pages, id).filter(
      (item) => !this.state.pages.find((page) => page.id === item)?.deletedAt,
    );
    for (const item of ids)
      await this.change(item, (page) => {
        page.deletedAt = at;
      });
    this.store.setState({
      starred: this.state.starred.filter((item) => !ids.includes(item)),
      recent: this.state.recent.filter((item) => !ids.includes(item)),
    });
    return ids.length;
  }
  /** Brings back a page and the subpages deleted with it; a missing parent puts it at the top. */
  async restore(id: string) {
    const target = this.state.pages.find((page) => page.id === id);
    if (!target?.deletedAt) return;
    const ids = descendants(this.state.pages, id).filter(
      (item) => this.state.pages.find((page) => page.id === item)?.deletedAt === target.deletedAt,
    );
    const parent = this.state.pages.find((page) => page.id === target.parent);
    for (const item of ids)
      await this.change(item, (page) => {
        page.deletedAt = null;
        if (item === id && (!parent || parent.deletedAt)) page.parent = null;
      });
  }
  async purge(id: string) {
    for (const item of descendants(this.state.pages, id).reverse()) {
      const page = this.state.pages.find((entry) => entry.id === item);
      if (!page?.deletedAt) continue;
      await this.backend.purge(this.projectId, item);
      const { [item]: _closed, ...open } = this.state.open;
      this.store.setState({ pages: this.state.pages.filter((entry) => entry.id !== item), open });
    }
  }
  /** Pages in the recycle bin longer than {@link TRASH_DAYS} days. */
  async purgeExpired(now = Date.now()) {
    const limit = now - TRASH_DAYS * 24 * 3600 * 1000;
    for (const page of this.state.pages)
      if (page.deletedAt && Date.parse(page.deletedAt) < limit)
        await this.purge(page.id).catch(() => {});
  }

  // ---------- This computer's lists ----------
  visit(id: string) {
    this.store.setState({
      recent: [id, ...this.state.recent.filter((item) => item !== id)].slice(0, 8),
    });
  }
  star(id: string, on = !this.state.starred.includes(id)) {
    this.store.setState({
      starred: on
        ? [...this.state.starred.filter((item) => item !== id), id]
        : this.state.starred.filter((item) => item !== id),
    });
  }
  expand(id: string, on = !this.state.expanded.includes(id)) {
    this.store.setState({
      expanded: on
        ? [...this.state.expanded, id]
        : this.state.expanded.filter((item) => item !== id),
    });
  }
}

const runtimes = new Map<DocsBackend, Map<string, DocsRuntime>>();
let currentUser: () => string | undefined = () => undefined;
/** Who is signed in, for "last edited by". */
export function setDocsUser(user: () => string | undefined) {
  currentUser = user;
}
export function docsRuntime(backend: DocsBackend, projectId: string) {
  let map = runtimes.get(backend);
  if (!map) runtimes.set(backend, (map = new Map()));
  let runtime = map.get(projectId);
  if (!runtime)
    map.set(projectId, (runtime = new DocsRuntime(backend, projectId, () => currentUser())));
  return runtime;
}
export function useDocs<T>(runtime: DocsRuntime, selector: (state: DocsState) => T) {
  return useStore(runtime.store, selector);
}
/** Saves every open document; false when something could not be saved. */
export async function flushDocs() {
  const results = await Promise.all(
    [...runtimes.values()].flatMap((map) => [...map.values()].map((runtime) => runtime.flush())),
  );
  return results.every(Boolean);
}
export const docsDirty = () =>
  [...runtimes.values()].some((map) => [...map.values()].some((runtime) => runtime.dirty()));
/** For tests: forget every runtime. */
export function resetDocsRuntimes() {
  for (const map of runtimes.values()) for (const runtime of map.values()) runtime.dispose();
  runtimes.clear();
}
