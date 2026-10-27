import { useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { ChevronDown, Globe, Plus, FolderPlus, MoreHorizontal, Rss } from 'lucide-react';
import { Button, Dropdown, Input } from '../../components/primitives';
import { Menu, type MenuAnchor } from '../../components/primitives/Menu';
import { Modal } from '../../components/Modal';
import { confirmAction, requestText } from '../../components/prompts';
import { t, translateError } from '../../i18n';
import { sourceUrl } from '../../domain/web-sources';
import type { WebSource, WebSources, Workspace } from '../../domain/workspace';
import type { WorkspaceStore } from '../../stores/workspace';
import { errorMessage } from '../../domain/errors';
import './subscriptions.css';

const empty: WebSources = { groups: [], items: [] };
type Editor = { id?: string; title: string; url: string; groupId: string };
export type BookmarkRequest = { url: string; title: string };

export function SubscriptionSidebar({
  store,
  onNewBrowser,
  onOpen,
  onRecommendations,
  bookmark,
  onBookmarkHandled,
}: {
  store: WorkspaceStore;
  onNewBrowser(): void;
  onOpen(url: string): Promise<void>;
  onRecommendations(): void;
  bookmark: BookmarkRequest | null;
  onBookmarkHandled(): void;
}) {
  const sources = useStore(store, (s) => s.data?.webSources ?? empty);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      const value: unknown = JSON.parse(
        localStorage.getItem('scientify.sources.collapsed') ?? '[]',
      );
      return new Set(
        Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [],
      );
    } catch {
      return new Set();
    } // Optional presentation state only.
  });
  const [editor, setEditor] = useState<Editor | null>(null);
  const initialEditor = useRef('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [menu, setMenu] = useState<{ id: string; group: boolean; anchor: MenuAnchor } | null>(null);
  useEffect(() => {
    if (!bookmark) return;
    const existing = sources.items.find((item) => item.url === bookmark.url);
    const next = existing
      ? {
          id: existing.id,
          title: existing.title,
          url: existing.url,
          groupId: existing.groupId ?? '',
        }
      : { ...bookmark, groupId: '' };
    initialEditor.current = JSON.stringify(next);
    setEditor(next);
    setError('');
    onBookmarkHandled();
  }, [bookmark, sources.items, onBookmarkHandled]);

  async function update(edit: (sources: WebSources) => void) {
    if (pending.current) return false;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      const saved = await store.getState().update((draft: Workspace) => {
        draft.webSources ??= { groups: [], items: [] };
        edit(draft.webSources);
      });
      if (!saved) throw new Error(store.getState().error ?? t('保存失败，请重试。'));
      return true;
    } catch (reason) {
      setError(translateError(errorMessage(reason)));
      return false;
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  function editSource(item?: WebSource) {
    setMenu(null);
    setError('');
    const next = item
      ? { id: item.id, title: item.title, url: item.url, groupId: item.groupId ?? '' }
      : { title: '', url: '', groupId: '' };
    initialEditor.current = JSON.stringify(next);
    setEditor(next);
  }
  async function saveSource() {
    if (!editor || busy) return;
    let url: string;
    try {
      url = sourceUrl(editor.url);
    } catch (reason) {
      setError((reason as Error).message);
      return;
    }
    const form = editor;
    const saved = await update((data) => {
      if (data.items.some((item) => item.id !== form.id && sourceUrl(item.url) === url))
        throw new Error(t('此网址已在个人信息源中。'));
      if (form.groupId && !data.groups.some((group) => group.id === form.groupId))
        throw new Error(t('分组已被删除，请重新选择。'));
      const existing = data.items.find((item) => item.id === form.id);
      if (form.id && !existing) throw new Error(t('信息源已被删除，请重新添加。'));
      const now = new Date().toISOString();
      const item: WebSource = {
        id: existing?.id ?? crypto.randomUUID(),
        title: form.title.trim(),
        url,
        ...(form.groupId ? { groupId: form.groupId } : {}),
        order: existing?.order ?? Math.max(-1, ...data.items.map((i) => i.order)) + 1,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      if (existing) data.items[data.items.indexOf(existing)] = item;
      else data.items.push(item);
    });
    if (saved) setEditor(null);
  }
  async function editGroup(id?: string) {
    setMenu(null);
    const name = await requestText(
      t(id ? '重命名分组' : '新建分组'),
      sources.groups.find((g) => g.id === id)?.name ?? '',
    );
    if (!name?.trim()) return;
    await update((data) => {
      if (name.trim().length > 200) throw new Error(t('名称不能超过 200 个字符。'));
      const group = data.groups.find((g) => g.id === id);
      if (id && !group) throw new Error(t('分组已被删除，请重新选择。'));
      if (group) group.name = name.trim();
      else
        data.groups.push({
          id: crypto.randomUUID(),
          name: name.trim(),
          order: Math.max(-1, ...data.groups.map((g) => g.order)) + 1,
        });
    });
  }
  async function remove(id: string, group: boolean) {
    setMenu(null);
    if (
      !(await confirmAction(
        t(
          group
            ? '删除此分组？其中的网站会移至未分组。'
            : '删除此信息源？不会删除下载的文件或笔记。',
        ),
      ))
    )
      return;
    await update((data) => {
      if (group) {
        data.groups = data.groups.filter((g) => g.id !== id);
        for (const item of data.items) if (item.groupId === id) delete item.groupId;
      } else data.items = data.items.filter((item) => item.id !== id);
    });
  }
  async function move(id: string, group: boolean, delta: number) {
    setMenu(null);
    await update((data) => {
      const item = data.items.find((i) => i.id === id);
      const list = (
        group ? [...data.groups] : data.items.filter((i) => i.groupId === item?.groupId)
      ).sort((a, b) => a.order - b.order);
      const index = list.findIndex((i) => i.id === id);
      if (index < 0 || !list[index + delta]) return;
      [list[index], list[index + delta]] = [list[index + delta], list[index]];
      list.forEach((entry, order) => {
        entry.order = order;
      });
    });
  }
  function toggle(id: string) {
    const next = new Set(collapsed);
    if (!next.delete(id)) next.add(id);
    setCollapsed(next);
    try {
      localStorage.setItem('scientify.sources.collapsed', JSON.stringify([...next]));
    } catch {
      /* Optional presentation state. */
    }
  }
  function more(id: string, group: boolean, element: HTMLElement) {
    const rect = element.getBoundingClientRect();
    setMenu({ id, group, anchor: { x: rect.left, y: rect.bottom, trigger: element } });
  }
  const groups = [
    { id: '', name: t('未分组'), order: -1 },
    ...sources.groups.slice().sort((a, b) => a.order - b.order),
  ];
  return (
    <div className="subscription-sidebar" role="region" aria-label={t('文献订阅')}>
      <Button onClick={onNewBrowser}>
        <Globe />
        {t('打开浏览器')}
      </Button>
      <div className="source-heading">
        <h3>{t('个人信息源')}</h3>
        <Button
          variant="ghost"
          iconOnly
          aria-label={t('新建分组')}
          disabled={busy}
          onClick={() => void editGroup()}
        >
          <FolderPlus />
        </Button>
        <Button
          variant="ghost"
          iconOnly
          aria-label={t('添加信息源')}
          disabled={busy}
          onClick={() => editSource()}
        >
          <Plus />
        </Button>
      </div>
      <div className="source-list">
        {!sources.items.length && (
          <p className="source-empty">{t('添加经常访问的网站，或在浏览器中收藏当前网页。')}</p>
        )}
        {groups.map((group) => {
          const items = sources.items
            .filter((i) => (i.groupId ?? '') === group.id)
            .sort((a, b) => a.order - b.order);
          if (!group.id && !items.length) return null;
          return (
            <section key={group.id} className="source-group">
              <div className="source-row source-group-heading">
                <Button
                  variant="ghost"
                  aria-expanded={!collapsed.has(group.id)}
                  onClick={() => toggle(group.id)}
                >
                  <ChevronDown className={collapsed.has(group.id) ? 'collapsed' : ''} />
                  <span>{group.name}</span>
                </Button>
                {group.id && (
                  <Button
                    variant="ghost"
                    iconOnly
                    aria-label={t('管理分组 {name}', { name: group.name })}
                    disabled={busy}
                    onClick={(e) => more(group.id, true, e.currentTarget)}
                  >
                    <MoreHorizontal />
                  </Button>
                )}
              </div>
              {!collapsed.has(group.id) && (
                <ul>
                  {items.map((item) => (
                    <li className="source-row" key={item.id}>
                      <Button
                        variant="ghost"
                        title={item.url}
                        onClick={() => {
                          setError('');
                          void onOpen(item.url).catch((reason) =>
                            setError(translateError(String(reason))),
                          );
                        }}
                      >
                        <Globe />
                        <span>{item.title}</span>
                      </Button>
                      <Button
                        variant="ghost"
                        iconOnly
                        aria-label={t('管理信息源 {name}', { name: item.title })}
                        disabled={busy}
                        onClick={(e) => more(item.id, false, e.currentTarget)}
                      >
                        <MoreHorizontal />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
      <Button className="source-recommendations" variant="ghost" onClick={onRecommendations}>
        <Rss />
        {t('消息推荐')}
        <small>{t('开发中')}</small>
      </Button>
      {error && !editor && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
      <Menu anchor={menu?.anchor ?? null} label={t('信息源操作')} onClose={() => setMenu(null)}>
        {menu && (
          <>
            <Button
              role="menuitem"
              variant="ghost"
              onClick={() =>
                menu.group
                  ? void editGroup(menu.id)
                  : editSource(sources.items.find((i) => i.id === menu.id))
              }
            >
              {t('编辑')}
            </Button>
            <Button
              role="menuitem"
              variant="ghost"
              onClick={() => void move(menu.id, menu.group, -1)}
            >
              {t('上移')}
            </Button>
            <Button
              role="menuitem"
              variant="ghost"
              onClick={() => void move(menu.id, menu.group, 1)}
            >
              {t('下移')}
            </Button>
            <Button
              role="menuitem"
              variant="ghost"
              onClick={() => void remove(menu.id, menu.group)}
            >
              {t('删除')}
            </Button>
          </>
        )}
      </Menu>
      {editor && (
        <Modal
          className="source-dialog"
          title={t(editor.id ? '编辑信息源' : '添加信息源')}
          busy={busy}
          dirty={JSON.stringify(editor) !== initialEditor.current}
          onClose={() => setEditor(null)}
        >
          <form
            className="form-grid source-form"
            onSubmit={(e) => {
              e.preventDefault();
              void saveSource();
            }}
          >
            <label>
              {t('名称')}
              <Input
                autoFocus
                value={editor.title}
                required
                maxLength={200}
                disabled={busy}
                onChange={(e) => setEditor({ ...editor, title: e.target.value })}
              />
            </label>
            <label>
              {t('网址')}
              <Input
                value={editor.url}
                required
                maxLength={2048}
                placeholder="https://"
                disabled={busy}
                onChange={(e) => setEditor({ ...editor, url: e.target.value })}
              />
            </label>
            <label>
              {t('分组')}
              <Dropdown
                value={editor.groupId}
                disabled={busy}
                onChange={(e) => setEditor({ ...editor, groupId: e.target.value })}
              >
                <option value="">{t('未分组')}</option>
                {sources.groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </Dropdown>
            </label>
            {error && (
              <p className="inline-error" role="alert">
                {error}
              </p>
            )}
            <Button
              type="submit"
              variant="primary"
              disabled={busy || !editor.title.trim() || !editor.url.trim()}
            >
              {busy ? t('正在保存…') : t('保存')}
            </Button>
          </form>
        </Modal>
      )}
    </div>
  );
}
