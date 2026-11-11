import { useMemo, useState } from 'react';
import { isTrashed } from '../notes/model';
import { useStore } from 'zustand';
import {
  ArrowUpDown,
  Check,
  ChevronDown,
  FolderClosed,
  FolderPlus,
  LayoutGrid,
  List,
  MoreHorizontal,
  Plus,
  Search,
  Star,
} from 'lucide-react';
import { t, translateError } from '../../i18n';
import { Button, Input } from '../../components/primitives';
import { Menu, menuAnchor, type MenuAnchor } from '../../components/primitives/Menu';
import { ViewTransition } from '../../components/workspace/ViewTransition';
import type { Project } from '../../domain/workspace';
import type { WorkspaceStore } from '../../stores/workspace';
import {
  collaboration,
  isSyncedProject,
  type CollaborationProject,
} from '../../platform/collaboration';
import { nativeLibrary } from '../../platform/library';
import { classifyCloud, refreshCloud, useCloud, type CloudEntry } from './cloud';
import { ProjectActions, type ProjectAction } from './ProjectActions';
import { DeleteProjectDialog, ShareProjectDialog, SyncProjectDialog } from './ProjectDialogs';
import {
  CenterEmpty,
  CenterHeader,
  MiniCover,
  ProjectCoverArt,
  type CoverBadge,
} from './ProjectCover';
import {
  colorForId,
  coverColor,
  filterProjects,
  lastActive,
  personalProjects,
  readOpened,
  relativeTime,
  sortProjects,
  type ProjectFilter,
  type ProjectSort,
} from './model';
import './project-library.css';

const sortLabels: Record<ProjectSort, string> = {
  opened: '最近打开',
  updated: '最近更新',
  name: '名称',
  created: '创建时间',
};

function readSetting<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const value = localStorage.getItem(key) as T | null;
    return value && allowed.includes(value) ? value : fallback;
  } catch {
    return fallback;
  }
}
function writeSetting(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Optional display preference. */
  }
}

type Dialog =
  | { kind: 'delete'; project: Project }
  | { kind: 'sync'; project: Project }
  | { kind: 'share'; project: Project };

/** “我的项目”: personal projects on this device, plus my synced projects that live elsewhere. */
export function ProjectLibrary({
  store,
  onOpen,
  onNew,
  onEdit,
  onOpenRemote,
  onShared,
}: {
  store: WorkspaceStore;
  onOpen(id: string): void;
  onNew(): void;
  onEdit(project: Project): void;
  onOpenRemote(project: CollaborationProject, team: boolean): Promise<void>;
  onShared(id: string): void;
}) {
  const data = useStore(store, (s) => s.data)!;
  const busy = useStore(store, (s) => s.busy);
  const cloud = useCloud();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ProjectFilter>('all');
  const [sort, setSort] = useState<ProjectSort>(() =>
    readSetting('scientify.projects.sort', ['opened', 'updated', 'name', 'created'], 'opened'),
  );
  const [view, setView] = useState<'grid' | 'list'>(() =>
    readSetting('scientify.projects.view', ['grid', 'list'], 'grid'),
  );
  const [context, setContext] = useState<{ project: Project; anchor: MenuAnchor } | null>(null);
  const [sortMenu, setSortMenu] = useState<MenuAnchor | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [error, setError] = useState('');
  const [downloading, setDownloading] = useState<string | null>(null);
  const opened = useMemo(readOpened, [data]);
  const signedIn = !!cloud.state?.authenticated;
  const mine = personalProjects(data);
  const { elsewhere } = classifyCloud(cloud, data.projects);
  const counts = {
    all: mine.filter((p) => !p.archived).length,
    favorite: mine.filter((p) => p.favorite && !p.archived).length,
    synced: mine.filter((p) => isSyncedProject(p) && !p.archived).length + elsewhere.length,
    archived: mine.filter((p) => p.archived).length,
  };
  const projects = sortProjects(filterProjects(mine, filter, query), sort, opened);
  const term = query.trim().toLocaleLowerCase();
  const remote =
    filter === 'all' || filter === 'synced'
      ? elsewhere.filter((entry) => entry.remote.name.toLocaleLowerCase().includes(term))
      : [];
  const total = projects.length + remote.length;
  function choose(next: 'grid' | 'list') {
    setView(next);
    writeSetting('scientify.projects.view', next);
  }
  async function toggle(project: Project, key: 'favorite' | 'archived') {
    await store.getState().update((value) => {
      const target = value.projects.find((entry) => entry.id === project.id);
      if (target) {
        target[key] = !target[key];
        target.updatedAt = new Date().toISOString();
      }
    });
  }
  async function download(entry: CloudEntry) {
    setDownloading(entry.remote.id);
    setError('');
    try {
      await onOpenRemote(entry.remote, false);
    } catch (reason) {
      setError(translateError(String(reason instanceof Error ? reason.message : reason)));
    } finally {
      setDownloading(null);
    }
  }
  function act(project: Project, action: ProjectAction) {
    setContext(null);
    setError('');
    if (action === 'open') onOpen(project.id);
    else if (action === 'edit') onEdit(project);
    else if (action === 'favorite') void toggle(project, 'favorite');
    else if (action === 'archive') void toggle(project, 'archived');
    else if (action === 'delete') {
      store.getState().clearMessage();
      setDialog({ kind: 'delete', project });
    } else if (action === 'sync') setDialog({ kind: 'sync', project });
    else if (action === 'share') setDialog({ kind: 'share', project });
    else if (action === 'syncNow')
      void collaboration
        .syncProject(project.id)
        .then(() => refreshCloud(store.getState().data?.projects ?? []))
        .catch((reason) => setError(translateError(String(reason))));
    else if (action === 'reveal')
      void nativeLibrary
        .external(project.id, '', false)
        .catch((reason) => setError(translateError(String(reason))));
  }
  const contextEvents = (project: Project) => ({
    onContextMenu: (event: React.MouseEvent<HTMLElement>) => {
      event.preventDefault();
      if (!busy)
        setContext({
          project,
          anchor: {
            ...menuAnchor(event),
            trigger: event.currentTarget.querySelector<HTMLButtonElement>('button'),
          },
        });
    },
    onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
        event.preventDefault();
        if (!busy)
          setContext({
            project,
            anchor: { ...menuAnchor(event), trigger: event.target as HTMLElement },
          });
      }
    },
  });
  const menuButton = (project: Project, className = '') => (
    <Button
      variant="ghost"
      iconOnly
      className={`project-menu-button ${className}`}
      disabled={busy}
      aria-label={t('项目操作 {name}', { name: project.name })}
      aria-haspopup="menu"
      aria-expanded={context?.project.id === project.id}
      onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        setContext({
          project,
          anchor: { x: rect.right - 220, y: rect.bottom + 4, trigger: event.currentTarget },
        });
      }}
    >
      <MoreHorizontal />
    </Button>
  );
  const badges = (project: Project): CoverBadge[] =>
    isSyncedProject(project) ? [signedIn && !cloud.reachable ? 'offline' : 'synced'] : [];
  const meta = (project: Project) =>
    project.archived
      ? t('已归档')
      : sort === 'created'
        ? t('创建于 {date}', { date: relativeTime(project.createdAt) })
        : sort === 'updated'
          ? t('{time}更新', { time: relativeTime(project.updatedAt ?? project.createdAt) })
          : t('{time}打开', { time: relativeTime(lastActive(project, opened)) });
  const chip = (value: ProjectFilter, label: string, count: number) => (
    <Button
      variant="ghost"
      size="sm"
      className="center-chip"
      aria-pressed={filter === value}
      onClick={() => setFilter(value)}
    >
      {label}
      <span className="center-chip-count">{count}</span>
    </Button>
  );
  const emptyAll = !mine.length && !elsewhere.length;
  return (
    <section className="center-page" aria-label={t('我的项目')}>
      <CenterHeader title={t('我的项目')} count={counts.all}>
        {!emptyAll ? (
          <label className="center-search-field">
            <Search aria-hidden="true" />
            <Input
              type="search"
              aria-label={t('搜索项目')}
              placeholder={t('搜索项目名称或研究问题')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        ) : null}
        <Button variant="primary" disabled={busy} onClick={onNew}>
          <FolderPlus />
          {t('新建项目')}
        </Button>
      </CenterHeader>
      {emptyAll ? (
        <div className="center-scroll">
          <CenterEmpty
            icon={<FolderClosed />}
            title={t('还没有项目')}
            actions={
              <Button variant="primary" disabled={busy} onClick={onNew}>
                <Plus />
                {t('新建项目')}
              </Button>
            }
          />
        </div>
      ) : (
        <div className="center-scroll">
          <div className="center-toolbar">
            <div className="center-chips" role="group" aria-label={t('筛选项目')}>
              {chip('all', t('全部'), counts.all)}
              {chip('favorite', t('收藏'), counts.favorite)}
              {signedIn || counts.synced ? chip('synced', t('多设备同步'), counts.synced) : null}
              {chip('archived', t('已归档'), counts.archived)}
            </div>
            <span className="spacer" />
            <Button
              variant="ghost"
              size="sm"
              aria-haspopup="menu"
              aria-label={t('排序：{order}', { order: t(sortLabels[sort]) })}
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                setSortMenu({ x: rect.left, y: rect.bottom + 4, trigger: event.currentTarget });
              }}
            >
              <ArrowUpDown />
              {t(sortLabels[sort])}
              <ChevronDown />
            </Button>
            <div className="center-view-switch" role="group" aria-label={t('项目显示方式')}>
              <Button
                variant="ghost"
                iconOnly
                aria-label={t('书架视图')}
                aria-pressed={view === 'grid'}
                onClick={() => choose('grid')}
              >
                <LayoutGrid />
              </Button>
              <Button
                variant="ghost"
                iconOnly
                aria-label={t('列表视图')}
                aria-pressed={view === 'list'}
                onClick={() => choose('list')}
              >
                <List />
              </Button>
            </div>
          </div>
          {error ? (
            <p role="alert" className="error-text center-error">
              {error}
            </p>
          ) : null}
          {!total ? (
            filter === 'archived' && !query ? (
              <CenterEmpty icon={<FolderClosed />} title={t('没有已归档的项目')} />
            ) : (
              <CenterEmpty
                icon={<Search />}
                title={t('没有符合条件的项目')}
                actions={
                  <Button
                    onClick={() => {
                      setQuery('');
                      setFilter('all');
                    }}
                  >
                    {t('清除筛选')}
                  </Button>
                }
              />
            )
          ) : (
            <ViewTransition viewKey={view} className="sf-view-stack--flow">
              {view === 'grid' ? (
                <div className="project-shelf" aria-label={t('项目书架')}>
                  {projects.map((project) => (
                    <article {...contextEvents(project)} className="project-book" key={project.id}>
                      <div className="project-book-binding">
                        <button
                          type="button"
                          className="project-cover"
                          aria-label={project.name}
                          title={project.question || project.name}
                          disabled={busy}
                          onClick={() => onOpen(project.id)}
                        >
                          <ProjectCoverArt
                            name={project.name}
                            field={project.field}
                            color={coverColor(project)}
                            favorite={project.favorite}
                            archived={project.archived}
                            badges={badges(project)}
                          />
                        </button>
                        {menuButton(project, 'on-cover')}
                      </div>
                      <span className="project-book-meta">{meta(project)}</span>
                    </article>
                  ))}
                  {remote.map((entry) => (
                    <article className="project-book remote" key={entry.remote.id}>
                      <div className="project-book-binding">
                        <button
                          type="button"
                          className="project-cover"
                          aria-label={t('下载“{name}”', { name: entry.remote.name })}
                          disabled={busy || !!downloading || !cloud.reachable}
                          onClick={() => void download(entry)}
                        >
                          <ProjectCoverArt
                            name={entry.remote.name}
                            color={colorForId(entry.remote.id)}
                            badges={['synced', 'remote']}
                          />
                        </button>
                      </div>
                      <span className="project-book-meta">
                        {downloading === entry.remote.id
                          ? t('正在下载…')
                          : t('未下载 · 在其他设备上')}
                      </span>
                    </article>
                  ))}
                  {filter === 'all' && !query ? (
                    <button
                      type="button"
                      className="project-new-book"
                      disabled={busy}
                      onClick={onNew}
                    >
                      <Plus />
                      <span>{t('新建项目')}</span>
                    </button>
                  ) : null}
                </div>
              ) : (
                <div className="center-table-wrap">
                  <table className="center-table project-list" aria-label={t('项目列表')}>
                    <thead>
                      <tr>
                        <th>{t('名称')}</th>
                        <th className="wide-only">{t('研究方向')}</th>
                        <th className="wide-only">{t('内容')}</th>
                        <th>{t('同步')}</th>
                        <th>{t(sortLabels[sort])}</th>
                        <th>
                          <span className="sr-only">{t('项目操作')}</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {projects.map((project) => {
                        const notes = data.records.filter(
                          (record) => record.project === project.id && !isTrashed(record),
                        ).length;
                        const runs = data.runs.filter((run) => run.project === project.id).length;
                        return (
                          <tr key={project.id} {...contextEvents(project)}>
                            <td>
                              <button
                                type="button"
                                className="center-row-open"
                                aria-label={project.name}
                                disabled={busy}
                                onClick={() => onOpen(project.id)}
                              >
                                <MiniCover color={coverColor(project)} />
                                <span>
                                  <strong>
                                    <span>{project.name}</span>
                                    {project.favorite ? <Star aria-label={t('已收藏')} /> : null}
                                    {project.archived ? <em>{t('已归档')}</em> : null}
                                  </strong>
                                  {project.question ? <small>{project.question}</small> : null}
                                </span>
                              </button>
                            </td>
                            <td className="wide-only muted">{project.field || '—'}</td>
                            <td className="wide-only muted">
                              {t('笔记 {notes} · 运行 {runs}', { notes, runs })}
                            </td>
                            <td>
                              {isSyncedProject(project) ? (
                                <span className="center-pill ok">
                                  <Check />
                                  {t('多设备同步')}
                                </span>
                              ) : (
                                <span className="muted">{t('仅本机')}</span>
                              )}
                            </td>
                            <td className="muted">
                              {relativeTime(
                                sort === 'created'
                                  ? project.createdAt
                                  : sort === 'updated'
                                    ? (project.updatedAt ?? project.createdAt)
                                    : lastActive(project, opened),
                              )}
                            </td>
                            <td className="center-row-actions">{menuButton(project)}</td>
                          </tr>
                        );
                      })}
                      {remote.map((entry) => (
                        <tr key={entry.remote.id} className="remote">
                          <td>
                            <button
                              type="button"
                              className="center-row-open"
                              aria-label={t('下载“{name}”', { name: entry.remote.name })}
                              disabled={busy || !!downloading || !cloud.reachable}
                              onClick={() => void download(entry)}
                            >
                              <MiniCover color={colorForId(entry.remote.id)} />
                              <span>
                                <strong>
                                  <span>{entry.remote.name}</span>
                                </strong>
                              </span>
                            </button>
                          </td>
                          <td className="wide-only muted">—</td>
                          <td className="wide-only muted">—</td>
                          <td>
                            <span className="muted">{t('未下载')}</span>
                          </td>
                          <td className="muted">{relativeTime(entry.remote.updatedAt)}</td>
                          <td />
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </ViewTransition>
          )}
        </div>
      )}
      <Menu
        anchor={context?.anchor ?? null}
        label={context?.project.name ?? t('项目操作')}
        onClose={() => setContext(null)}
      >
        {context ? (
          <ProjectActions
            project={context.project}
            busy={busy}
            signedIn={signedIn}
            reachable={cloud.reachable}
            onAction={(action) => act(context.project, action)}
          />
        ) : null}
      </Menu>
      <Menu anchor={sortMenu} label={t('排序方式')} onClose={() => setSortMenu(null)}>
        {(Object.keys(sortLabels) as ProjectSort[]).map((value) => (
          <Button
            key={value}
            role="menuitemradio"
            aria-checked={sort === value}
            variant="ghost"
            onClick={() => {
              setSort(value);
              writeSetting('scientify.projects.sort', value);
              setSortMenu(null);
            }}
          >
            <span className="center-menu-check">{sort === value ? <Check /> : null}</span>
            {t(sortLabels[value])}
          </Button>
        ))}
      </Menu>
      {dialog?.kind === 'delete' ? (
        <DeleteProjectDialog
          store={store}
          project={dialog.project}
          onClose={() => setDialog(null)}
          onArchive={() => {
            const project = dialog.project;
            setDialog(null);
            void toggle(project, 'archived');
          }}
        />
      ) : null}
      {dialog?.kind === 'sync' ? (
        <SyncProjectDialog store={store} project={dialog.project} onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === 'share' ? (
        <ShareProjectDialog
          store={store}
          projectId={dialog.project.id}
          onClose={() => setDialog(null)}
          onShared={(id) => {
            setDialog(null);
            onShared(id);
          }}
        />
      ) : null}
    </section>
  );
}
