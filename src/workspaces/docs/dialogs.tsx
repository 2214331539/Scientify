import { useEffect, useMemo, useState } from 'react';
import { BookOpen, FileText, RotateCcw, Search, Trash2 } from 'lucide-react';
import { Modal } from '../../components/Modal';
import { Button } from '../../components/primitives';
import { confirmAction } from '../../components/prompts';
import { t } from '../../i18n';
import { errorMessage } from '../../domain/errors';
import type { DocSnapshot } from '../../platform/docs';
import {
  childrenOf,
  descendants,
  TEMPLATES,
  TRASH_DAYS,
  type Page,
  type PageSummary,
  type TemplateId,
} from './model';
import { useDocs, type DocsRuntime } from './runtime';
import { PageIcon } from './DocsSide';
import type { Pick } from './editor/env';

export function TemplatesDialog({
  onPick,
  onClose,
}: {
  onPick(id: TemplateId): void;
  onClose(): void;
}) {
  return (
    <Modal title={t('模板')} onClose={onClose} className="doc-dialog">
      <div className="doc-templates">
        {TEMPLATES.map((item) => (
          <button
            type="button"
            key={item.id}
            className="doc-template"
            onClick={() => onPick(item.id)}
          >
            <span className="doc-template-icon">{item.icon}</span>
            <b>{t(item.label)}</b>
            <small>{t(item.description)}</small>
          </button>
        ))}
      </div>
    </Modal>
  );
}

export function TrashDialog({ runtime, onClose }: { runtime: DocsRuntime; onClose(): void }) {
  const pages = useDocs(runtime, (state) => state.pages);
  const [error, setError] = useState('');
  // Only the page deleted itself is listed; its subpages come back with it.
  const trashed = pages
    .filter(
      (page) =>
        page.deletedAt &&
        !pages.some((parent) => parent.id === page.parent && parent.deletedAt === page.deletedAt),
    )
    .sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt)));
  const run = (work: Promise<unknown>) =>
    void work.catch((reason) => setError(errorMessage(reason)));
  return (
    <Modal title={t('回收站')} onClose={onClose} className="doc-dialog">
      <p className="doc-dialog-note">
        {t('删除的页面连同子页面保留 {days} 天。', { days: TRASH_DAYS })}
      </p>
      {error ? <p role="alert">{error}</p> : null}
      {trashed.length ? null : <p className="doc-dialog-empty">{t('回收站是空的')}</p>}
      <ul className="doc-dialog-list">
        {trashed.map((page) => {
          const count = descendants(pages, page.id).length - 1;
          return (
            <li key={page.id}>
              <PageIcon page={page} />
              <span className="doc-dialog-name">
                {page.title || t('无标题')}
                <small>
                  {new Date(String(page.deletedAt)).toLocaleString()}
                  {count ? ' · ' + t('含 {count} 个子页面', { count }) : ''}
                </small>
              </span>
              <Button variant="ghost" onClick={() => run(runtime.restore(page.id))}>
                <RotateCcw size={14} />
                {t('恢复')}
              </Button>
              <Button
                variant="ghost"
                onClick={async () => {
                  if (
                    await confirmAction(
                      t('彻底删除“{title}”？之后不能恢复。', { title: page.title || t('无标题') }),
                    )
                  )
                    run(runtime.purge(page.id));
                }}
              >
                <Trash2 size={14} />
                {t('彻底删除')}
              </Button>
            </li>
          );
        })}
      </ul>
    </Modal>
  );
}

export function MoveDialog({
  runtime,
  page,
  onClose,
}: {
  runtime: DocsRuntime;
  page: PageSummary;
  onClose(): void;
}) {
  const pages = useDocs(runtime, (state) => state.pages);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const blocked = new Set(descendants(pages, page.id));
  const rows: { page: PageSummary; depth: number }[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const child of childrenOf(pages, parent)) {
      if (blocked.has(child.id)) continue;
      rows.push({ page: child, depth });
      walk(child.id, depth + 1);
    }
  };
  walk(null, 0);
  const q = query.trim().toLowerCase();
  const shown = q
    ? rows.filter((row) => (row.page.title || t('无标题')).toLowerCase().includes(q))
    : rows;
  const move = (parent: string | null) =>
    void runtime
      .move(page.id, parent, Number.MAX_SAFE_INTEGER)
      .then(onClose)
      .catch((reason) => setError(errorMessage(reason)));
  return (
    <Modal
      title={t('把“{title}”移动到', { title: page.title || t('无标题') })}
      onClose={onClose}
      className="doc-dialog"
    >
      <label className="sf-search-field">
        <Search size={13} />
        <input
          autoFocus
          value={query}
          placeholder={t('搜索页面')}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      {error ? <p role="alert">{error}</p> : null}
      <div className="doc-move-list">
        {q ? null : (
          <button type="button" className="doc-move-row" onClick={() => move(null)}>
            <FileText size={14} />
            {t('顶层')}
          </button>
        )}
        {shown.map(({ page: target, depth }) => (
          <button
            type="button"
            key={target.id}
            className="doc-move-row"
            style={{ paddingLeft: 8 + (q ? 0 : depth * 14) }}
            disabled={target.id === page.parent}
            onClick={() => move(target.id)}
          >
            <PageIcon page={target} />
            {target.title || t('无标题')}
          </button>
        ))}
      </div>
    </Modal>
  );
}

export function HistoryDialog({
  runtime,
  page,
  onRestore,
  onClose,
}: {
  runtime: DocsRuntime;
  page: PageSummary;
  onRestore(version: Page): void;
  onClose(): void;
}) {
  const [list, setList] = useState<DocSnapshot[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    runtime.backend
      .history(runtime.projectId, page.id)
      .then(setList)
      .catch((reason) => setError(errorMessage(reason)));
  }, [page.id, runtime]);
  return (
    <Modal title={t('历史记录')} onClose={onClose} className="doc-dialog">
      <p className="doc-dialog-note">{t('这台电脑每 10 分钟有修改时留一个版本，保留 30 天。')}</p>
      {error ? <p role="alert">{error}</p> : null}
      {list?.length === 0 ? <p className="doc-dialog-empty">{t('还没有历史版本')}</p> : null}
      <ul className="doc-dialog-list">
        {list?.map((item) => (
          <li key={item.at}>
            <span className="doc-dialog-name">{new Date(Number(item.at)).toLocaleString()}</span>
            <Button
              variant="ghost"
              onClick={async () => {
                if (!(await confirmAction(t('恢复到这个版本？当前内容会先留一个版本。')))) return;
                try {
                  onRestore(await runtime.backend.snapshot(runtime.projectId, page.id, item.at));
                  onClose();
                } catch (reason) {
                  setError(errorMessage(reason));
                }
              }}
            >
              <RotateCcw size={14} />
              {t('恢复')}
            </Button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

export function PickDialog({
  title,
  load,
  onPick,
  onClose,
}: {
  title: string;
  load(): Promise<Pick[]>;
  onPick(item: Pick): void;
  onClose(): void;
}) {
  const [items, setItems] = useState<Pick[] | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => {
    load()
      .then(setItems)
      .catch((reason) => setError(errorMessage(reason)));
  }, [load]);
  const q = query.trim().toLowerCase();
  const shown = useMemo(
    () =>
      (items ?? [])
        .filter(
          (item) =>
            !q || item.title.toLowerCase().includes(q) || item.path.toLowerCase().includes(q),
        )
        .slice(0, 200),
    [items, q],
  );
  return (
    <Modal title={title} onClose={onClose} className="doc-dialog">
      <label className="sf-search-field">
        <Search size={13} />
        <input
          autoFocus
          value={query}
          placeholder={t('搜索')}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      {error ? <p role="alert">{error}</p> : null}
      {items === null && !error ? <p className="doc-dialog-empty">{t('正在读取…')}</p> : null}
      {items?.length === 0 ? <p className="doc-dialog-empty">{t('没有可以插入的内容')}</p> : null}
      <div className="doc-move-list">
        {shown.map((item) => (
          <button
            type="button"
            key={item.path}
            className="doc-pick-row"
            onClick={() => onPick(item)}
          >
            {/\.pdf$/i.test(item.path) ? <BookOpen size={14} /> : <FileText size={14} />}
            <span>
              {item.title}
              <small>{item.path}</small>
            </span>
          </button>
        ))}
      </div>
    </Modal>
  );
}

const ICONS =
  '📄📝📒📚📖🗓️🧪📈📊🧭🎯💡🔬🧠⚙️🗂️✅❓🔥⭐🚀📌🏠👥💬🧩🖼️🔖🗒️📎'.match(
    /\p{Extended_Pictographic}️?/gu,
  ) ?? [];
export function IconPicker({
  onPick,
  onClose,
}: {
  onPick(icon: string | null): void;
  onClose(): void;
}) {
  return (
    <Modal title={t('选择图标')} onClose={onClose} className="doc-dialog">
      <div className="doc-icons">
        {ICONS.map((icon) => (
          <button type="button" key={icon} aria-label={icon} onClick={() => onPick(icon)}>
            {icon}
          </button>
        ))}
      </div>
      <Button variant="ghost" onClick={() => onPick(null)}>
        {t('移除图标')}
      </Button>
    </Modal>
  );
}
