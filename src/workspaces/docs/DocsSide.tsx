/** The documents' own part of the sidebar: search, recent, starred and the page tree. */
import { useEffect, useRef, useState, type DragEvent } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  FileText,
  FolderInput,
  LayoutTemplate,
  MoreHorizontal,
  PenLine,
  Plus,
  Search,
  Star,
  Trash2,
  Upload,
} from 'lucide-react';
import { Button } from '../../components/primitives';
import { Menu, type MenuAnchor } from '../../components/primitives/Menu';
import { t } from '../../i18n';
import { errorMessage } from '../../domain/errors';
import type { DocHit } from '../../platform/docs';
import { childrenOf, type PageSummary } from './model';
import { useDocs, type DocsRuntime } from './runtime';

export type PageAction =
  'subpage' | 'rename' | 'duplicate' | 'move' | 'star' | 'export' | 'exportWord' | 'delete';
type Drop = { id: string; zone: 'before' | 'after' | 'inside' };

const below = (element: HTMLElement): MenuAnchor => {
  const rect = element.getBoundingClientRect();
  return { x: rect.left, y: rect.bottom + 4, trigger: element };
};
const title = (page: PageSummary) => page.title || t('无标题');
export const PageIcon = ({ page }: { page: Pick<PageSummary, 'icon'> }) =>
  page.icon ? (
    <span className="doc-page-icon">{page.icon}</span>
  ) : (
    <FileText size={14} className="doc-page-icon is-file" />
  );

export function DocsSide({
  runtime,
  current,
  readOnly,
  onOpen,
  onAction,
  onNew,
  onTemplates,
  onImport,
  onTrash,
}: {
  runtime: DocsRuntime;
  current: string | null;
  readOnly: boolean;
  onOpen(id: string): void;
  onAction(action: PageAction, page: PageSummary): void;
  onNew(parent: string | null): void;
  onTemplates(): void;
  onImport(): void;
  onTrash(): void;
}) {
  const pages = useDocs(runtime, (state) => state.pages);
  const recent = useDocs(runtime, (state) => state.recent);
  const starred = useDocs(runtime, (state) => state.starred);
  const expanded = useDocs(runtime, (state) => state.expanded);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<DocHit[] | null>(null);
  const [recentOpen, setRecentOpen] = useState(true);
  const [menu, setMenu] = useState<{ anchor: MenuAnchor; page?: PageSummary } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);
  const dragged = useRef<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setHits(null);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      runtime.backend
        .search(runtime.projectId, q)
        .then((found) => alive && setHits(found))
        .catch((reason) => alive && setError(errorMessage(reason)));
    }, 200);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [query, runtime]);

  const live = new Map(pages.filter((page) => !page.deletedAt).map((page) => [page.id, page]));
  const trashed = pages.filter((page) => page.deletedAt).length;

  function zoneOf(event: DragEvent<HTMLElement>): Drop['zone'] {
    const rect = event.currentTarget.getBoundingClientRect();
    const y = (event.clientY - rect.top) / rect.height;
    return y < 0.28 ? 'before' : y > 0.72 ? 'after' : 'inside';
  }
  async function dropOn(target: PageSummary, zone: Drop['zone']) {
    const id = dragged.current;
    dragged.current = null;
    setDrop(null);
    if (!id || id === target.id) return;
    try {
      if (zone === 'inside') await runtime.move(id, target.id, Number.MAX_SAFE_INTEGER);
      else {
        const siblings = childrenOf(pages, target.parent).filter((page) => page.id !== id);
        const at = siblings.findIndex((page) => page.id === target.id) + (zone === 'after' ? 1 : 0);
        await runtime.move(id, target.parent, at);
      }
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  function row(page: PageSummary, depth: number) {
    const children = childrenOf(pages, page.id);
    const open = expanded.includes(page.id);
    const marker = drop?.id === page.id ? drop.zone : undefined;
    return (
      <div key={page.id} role="treeitem" aria-expanded={children.length ? open : undefined}>
        <div
          className="doc-tree-row"
          data-drop={marker}
          aria-current={current === page.id ? 'page' : undefined}
          style={{ paddingLeft: 4 + depth * 14 }}
          draggable={!readOnly && renaming !== page.id}
          onDragStart={(event) => {
            dragged.current = page.id;
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', title(page));
          }}
          onDragEnd={() => setDrop(null)}
          onDragOver={(event) => {
            if (!dragged.current || dragged.current === page.id) return;
            event.preventDefault();
            const zone = zoneOf(event);
            if (drop?.id !== page.id || drop.zone !== zone) setDrop({ id: page.id, zone });
          }}
          onDragLeave={() => setDrop((value) => (value?.id === page.id ? null : value))}
          onDrop={(event) => {
            event.preventDefault();
            void dropOn(page, zoneOf(event));
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            setMenu({
              anchor: { x: event.clientX, y: event.clientY, trigger: event.currentTarget },
              page,
            });
          }}
        >
          <button
            type="button"
            className="doc-tree-caret"
            tabIndex={-1}
            aria-label={open ? t('收起') : t('展开')}
            style={{ visibility: children.length ? 'visible' : 'hidden' }}
            onClick={() => runtime.expand(page.id)}
          >
            {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </button>
          {renaming === page.id ? (
            <input
              className="doc-tree-rename"
              autoFocus
              defaultValue={page.title}
              aria-label={t('页面名称')}
              onBlur={(event) => {
                setRenaming(null);
                if (event.target.value !== page.title)
                  void runtime.rename(page.id, event.target.value.trim());
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
                if (event.key === 'Escape') setRenaming(null);
              }}
            />
          ) : (
            <button
              type="button"
              className="doc-tree-open"
              onClick={() => onOpen(page.id)}
              title={title(page)}
            >
              <PageIcon page={page} />
              <span>{title(page)}</span>
            </button>
          )}
          {readOnly ? null : (
            <span className="doc-tree-actions">
              <button
                type="button"
                aria-label={t('更多')}
                onClick={(event) => setMenu({ anchor: below(event.currentTarget), page })}
              >
                <MoreHorizontal size={14} />
              </button>
              <button type="button" aria-label={t('新建子页面')} onClick={() => onNew(page.id)}>
                <Plus size={14} />
              </button>
            </span>
          )}
        </div>
        {open && children.length ? (
          <div role="group">{children.map((child) => row(child, depth + 1))}</div>
        ) : null}
      </div>
    );
  }

  const quick = (ids: string[]) =>
    ids
      .map((id) => live.get(id))
      .filter((page): page is PageSummary => !!page)
      .map((page) => (
        <button
          type="button"
          key={page.id}
          className="doc-quick-row"
          aria-current={current === page.id ? 'page' : undefined}
          onClick={() => onOpen(page.id)}
        >
          <PageIcon page={page} />
          <span>{title(page)}</span>
        </button>
      ));

  return (
    <div className="doc-side">
      <div className="doc-side-search">
        <label className="sf-search-field">
          <Search size={13} />
          <input
            value={query}
            placeholder={t('搜索文档')}
            aria-label={t('搜索文档')}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        {readOnly ? null : (
          <Button
            variant="ghost"
            iconOnly
            aria-label={t('新建')}
            onClick={(event) => setMenu({ anchor: below(event.currentTarget) })}
          >
            <Plus size={15} />
          </Button>
        )}
      </div>
      {error ? (
        <p className="doc-side-error" role="alert" onClick={() => setError('')}>
          {error}
        </p>
      ) : null}
      {hits ? (
        <div className="doc-side-hits" role="list" aria-label={t('搜索结果')}>
          {hits.length ? null : <p className="doc-side-empty">{t('没有找到')}</p>}
          {hits.map((hit) => (
            <button type="button" key={hit.id} className="doc-hit" onClick={() => onOpen(hit.id)}>
              <span className="doc-hit-title">
                <PageIcon page={hit} />
                {hit.title || t('无标题')}
              </span>
              {hit.snippet ? <small>{hit.snippet}</small> : null}
            </button>
          ))}
        </div>
      ) : (
        <div className="doc-side-scroll">
          {recent.some((id) => live.has(id)) ? (
            <section className="doc-side-section">
              <button
                type="button"
                className="doc-side-head"
                onClick={() => setRecentOpen((value) => !value)}
              >
                {recentOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                {t('最近')}
              </button>
              {recentOpen ? quick(recent.slice(0, 5)) : null}
            </section>
          ) : null}
          {starred.some((id) => live.has(id)) ? (
            <section className="doc-side-section">
              <div className="doc-side-head">
                <Star size={12} />
                {t('收藏')}
              </div>
              {quick(starred)}
            </section>
          ) : null}
          <section className="doc-side-section" role="tree" aria-label={t('页面')}>
            <div className="doc-side-head">
              {t('页面')}
              {readOnly ? null : (
                <button
                  type="button"
                  className="doc-side-add"
                  aria-label={t('新建页面')}
                  onClick={() => onNew(null)}
                >
                  <Plus size={13} />
                </button>
              )}
            </div>
            {childrenOf(pages, null).map((page) => row(page, 0))}
            {!live.size ? <p className="doc-side-empty">{t('还没有页面')}</p> : null}
          </section>
        </div>
      )}
      <div className="doc-side-foot">
        {readOnly ? null : (
          <button type="button" onClick={onTemplates}>
            <LayoutTemplate size={14} />
            {t('模板')}
          </button>
        )}
        <button type="button" onClick={onTrash}>
          <Trash2 size={14} />
          {t('回收站')}
          {trashed ? <span className="sf-nav-count">{trashed}</span> : null}
        </button>
      </div>
      <Menu anchor={menu?.anchor ?? null} label={t('页面菜单')} onClose={() => setMenu(null)}>
        {menu && !menu.page ? (
          <>
            <button type="button" role="menuitem" onClick={() => (setMenu(null), onNew(null))}>
              <FileText size={14} />
              {t('新建页面')}
            </button>
            <button type="button" role="menuitem" onClick={() => (setMenu(null), onTemplates())}>
              <LayoutTemplate size={14} />
              {t('从模板新建…')}
            </button>
            <button type="button" role="menuitem" onClick={() => (setMenu(null), onImport())}>
              <Upload size={14} />
              {t('导入 Markdown…')}
            </button>
          </>
        ) : null}
        {menu?.page ? (
          <>
            {(
              [
                ['subpage', Plus, '新建子页面'],
                ['rename', PenLine, '重命名'],
                ['duplicate', Copy, '创建副本'],
                ['move', FolderInput, '移动到…'],
                ['star', Star, starred.includes(menu.page.id) ? '取消收藏' : '收藏'],
                ['export', Download, '导出 Markdown'],
                ['exportWord', FileText, '导出 Word'],
              ] as const
            ).map(([action, Icon, label]) => (
              <button
                type="button"
                role="menuitem"
                key={action}
                onClick={() => {
                  const page = menu.page!;
                  setMenu(null);
                  if (action === 'rename') setRenaming(page.id);
                  else onAction(action, page);
                }}
              >
                <Icon size={14} />
                {t(label)}
              </button>
            ))}
            <div role="separator" className="sf-menu-separator" />
            <button
              type="button"
              role="menuitem"
              className="sf-menu-danger"
              onClick={() => {
                const page = menu.page!;
                setMenu(null);
                onAction('delete', page);
              }}
            >
              <Trash2 size={14} />
              {t('删除')}
            </button>
          </>
        ) : null}
      </Menu>
    </div>
  );
}
