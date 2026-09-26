import { t, locale, translateError } from '../../i18n';
import { Button, Input, Badge } from '../../components/primitives';
import { WindowControls } from '../../components/layout/WindowControls';
import { Modal } from '../../components/Modal';
import { useEffect, useState, type CSSProperties } from 'react';
import { useStore } from 'zustand';
import {
  Plus,
  Search,
  LayoutGrid,
  List,
  FolderClosed,
  ChevronRight,
  Pencil,
  Star,
  MoreHorizontal,
} from 'lucide-react';
import { selectProjects, type Project, type Team } from '../../domain/workspace';
import { Menu, menuAnchor, type MenuAnchor } from '../../components/primitives/Menu';
import type { WorkspaceStore } from '../../stores/workspace';
import { coverColor, coverInk, deleteProject } from './model';
import { ProjectActions } from './ProjectActions';
import './project-library.css';

function updated(project: Project) {
  const date = new Date(project.updatedAt || project.createdAt);
  if (!Number.isFinite(date.getTime())) return '—';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);
  const days = Math.round((today.getTime() - day.getTime()) / 86400000);
  const label =
    days === 0
      ? t('今天')
      : days === 1
        ? t('昨天')
        : days > 1 && days < 8
          ? t('{count} 天前', { count: days })
          : date.toLocaleDateString(locale());
  return t('更新于{date}', { date: label });
}

export function ProjectLibrary({
  store,
  space,
  onOpen,
  onNew,
  onEdit,
  onNewTeam,
  onEditTeam,
}: {
  store: WorkspaceStore;
  space: string;
  onOpen(id: string): void;
  onNew(): void;
  onEdit(project: Project): void;
  onNewTeam(): void;
  onEditTeam(team: Team): void;
}) {
  const data = useStore(store, (s) => s.data)!;
  const busy = useStore(store, (s) => s.busy),
    dirty = useStore(store, (s) => s.dirty);
  const error = useStore(store, (s) => s.error);
  const [query, setQuery] = useState('');
  const [context, setContext] = useState<{ project: Project; anchor: MenuAnchor } | null>(null);
  const [view, setView] = useState<'grid' | 'list'>(() => {
    try {
      return localStorage.getItem('scientify.projects.view') === 'list' ? 'list' : 'grid';
    } catch {
      return 'grid';
    }
  });
  const [removing, setRemoving] = useState<Project | null>(null);
  useEffect(() => {
    setQuery('');
    setContext(null);
  }, [space]);
  const team = data.teams.find((entry) => entry.id === space);
  const projects = selectProjects(data, space, query);
  const selectView = (next: 'grid' | 'list') => {
    setView(next);
    try {
      localStorage.setItem('scientify.projects.view', next);
    } catch {
      /* Optional display preference. */
    }
  };
  async function toggle(project: Project, key: 'favorite' | 'archived') {
    await store.getState().update((data) => {
      const target = data.projects.find((entry) => entry.id === project.id);
      if (target) {
        target[key] = !target[key];
        target.updatedAt = new Date().toISOString();
      }
    });
  }
  function remove(item: Project) {
    store.getState().clearMessage();
    setRemoving(item);
  }
  const actions = (project: Project) => (
    <div className="project-actions">
      <Button
        variant="ghost"
        iconOnly
        disabled={busy}
        aria-label={t('项目操作 {name}', { name: project.name })}
        aria-haspopup="menu"
        aria-expanded={context?.project.id === project.id}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setContext({
            project,
            anchor: { x: rect.right - 180, y: rect.bottom + 4, trigger: event.currentTarget },
          });
        }}
      >
        <MoreHorizontal />
      </Button>
    </div>
  );
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
  return (
    <section className="launcher-library" aria-label={t('项目管理')}>
      <header className="launcher-topbar" data-tauri-drag-region>
        <label className="launcher-search">
          <Search aria-hidden="true" />
          <Input
            type="search"
            aria-label={t('搜索项目')}
            placeholder={t('搜索项目…')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div
          className="launcher-view-switch"
          role="group"
          aria-label={t('项目显示方式')}
          data-view={view}
        >
          <Button
            variant="ghost"
            iconOnly
            aria-label={t('网格视图')}
            aria-pressed={view === 'grid'}
            onClick={() => selectView('grid')}
          >
            <LayoutGrid />
          </Button>
          <Button
            variant="ghost"
            iconOnly
            aria-label={t('列表视图')}
            aria-pressed={view === 'list'}
            onClick={() => selectView('list')}
          >
            <List />
          </Button>
        </div>
        <WindowControls />
      </header>
      <div className="launcher-browser-controls">
        <div className="launcher-breadcrumb">
          {team && (
            <>
              <span>{t('团队协作空间')}</span>
              <ChevronRight />
            </>
          )}
          <span>{space === '__teams__' ? t('团队协作空间') : (team?.name ?? t('个人空间'))}</span>
          {team && (
            <Button
              variant="ghost"
              iconOnly
              aria-label={t('编辑团队')}
              onClick={() => onEditTeam(team)}
              disabled={busy}
            >
              <Pencil />
            </Button>
          )}
        </div>
      </div>
      <div className="launcher-canvas">
        {!projects.length && (
          <div className="launcher-no-results">
            <span>{query ? t('没有符合条件的项目') : t('暂无项目')}</span>
            {query && (
              <Button
                variant="ghost"
                onClick={() => {
                  setQuery('');
                  setContext(null);
                }}
              >
                {t('清除筛选')}
              </Button>
            )}
          </div>
        )}
        {view === 'grid' ? (
          <div className="project-shelf" aria-label={t('项目网格')}>
            {projects.map((project) => {
              const color = coverColor(project);
              return (
                <article
                  {...contextEvents(project)}
                  className="project-book"
                  key={project.id}
                  style={
                    {
                      '--project-cover': color,
                      '--project-cover-ink': coverInk(color),
                    } as CSSProperties
                  }
                >
                  <div className="project-book-binding">
                    <Button
                      variant="ghost"
                      className="project-cover"
                      aria-label={project.name}
                      onClick={() => onOpen(project.id)}
                      disabled={busy}
                    >
                      <span className="project-cover-type">{project.field || t('研究项目')}</span>
                      <strong>{project.name}</strong>
                    </Button>
                    {project.archived && (
                      <Badge className="project-cover-status">{t('已归档')}</Badge>
                    )}
                    {project.favorite && (
                      <Star className="project-cover-star" aria-label={t('已收藏')} />
                    )}
                    {actions(project)}
                  </div>
                  <time
                    className="project-updated"
                    dateTime={project.updatedAt || project.createdAt}
                  >
                    {updated(project)}
                  </time>
                </article>
              );
            })}
            <Button
              variant="ghost"
              className="project-new-book"
              onClick={space === '__teams__' ? onNewTeam : onNew}
              disabled={busy}
            >
              <Plus />
              <span>{t(space === '__teams__' ? '创建团队空间' : '新建项目')}</span>
            </Button>
          </div>
        ) : (
          <div className="launcher-project-list">
            <table className="data-table" aria-label={t('项目列表')}>
              <thead>
                <tr>
                  <th>{t('项目名称')}</th>
                  <th>{t('研究方向')}</th>
                  <th>{t('最近更新')}</th>
                  <th>
                    <span className="sr-only">{t('项目操作')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {projects.map((project) => (
                  <tr key={project.id} {...contextEvents(project)}>
                    <td>
                      <Button
                        variant="ghost"
                        className="launcher-project-open"
                        aria-label={project.name}
                        disabled={busy}
                        onClick={() => onOpen(project.id)}
                      >
                        <FolderClosed />
                        <span>
                          <strong>
                            {project.name} {project.archived && <Badge>{t('已归档')}</Badge>}
                          </strong>
                          {project.question && <small>{project.question}</small>}
                        </span>
                      </Button>
                    </td>
                    <td>{project.field || '—'}</td>
                    <td>{updated(project)}</td>
                    <td>{actions(project)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Button
              variant="ghost"
              className="launcher-new-row"
              disabled={busy}
              onClick={space === '__teams__' ? onNewTeam : onNew}
            >
              <Plus />
              {t(space === '__teams__' ? '创建团队空间' : '新建项目')}
            </Button>
          </div>
        )}
      </div>
      <Menu
        anchor={context?.anchor ?? null}
        label={context?.project.name ?? t('项目操作')}
        onClose={() => setContext(null)}
      >
        {context && (
          <ProjectActions
            project={context.project}
            busy={busy}
            onEdit={() => onEdit(context.project)}
            onToggle={(key) => void toggle(context.project, key)}
            onDelete={() => remove(context.project)}
          />
        )}
      </Menu>
      {removing && (
        <Modal title={t('删除项目')} busy={busy} onClose={() => setRemoving(null)}>
          <div className="form-grid">
            <p>
              {t('删除“{name}”及其项目记录？本地文件和文献附件将保留。', {
                name: removing.name,
              })}
            </p>
            {dirty && <p role="alert">{t('请先保存当前修改，再删除项目或团队。')}</p>}
            {error && (
              <p role="alert" className="error-text">
                {translateError(error)}
              </p>
            )}
            <footer className="dialog-footer">
              <Button disabled={busy} onClick={() => setRemoving(null)}>
                {t('取消')}
              </Button>
              <Button
                variant="primary"
                disabled={busy || dirty}
                onClick={async () => {
                  const target = removing;
                  const saved = await store
                    .getState()
                    .update((data) => deleteProject(data, target.id));
                  if (saved) {
                    setRemoving(null);
                  }
                }}
              >
                {busy ? t('正在保存…') : t('确认删除')}
              </Button>
            </footer>
          </div>
        </Modal>
      )}
    </section>
  );
}
