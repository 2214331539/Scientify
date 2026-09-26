import { t, locale, translateError } from '../../i18n';
import { Button, Input, Dropdown } from '../../components/primitives';
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
  UsersRound,
  ChevronRight,
  Pencil,
  Trash2,
  Star,
} from 'lucide-react';
import {
  selectProjects,
  type Project,
  type ProjectFilter,
  type Team,
} from '../../domain/workspace';
import type { WorkspaceStore } from '../../stores/workspace';
import { coverColor, coverInk, deleteProject, deleteTeam } from './model';
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
  onSpace,
  onNewTeam,
  onEditTeam,
}: {
  store: WorkspaceStore;
  space: string;
  onOpen(id: string): void;
  onNew(): void;
  onEdit(project: Project): void;
  onSpace(space: string): void;
  onNewTeam(): void;
  onEditTeam(team: Team): void;
}) {
  const data = useStore(store, (s) => s.data)!;
  const busy = useStore(store, (s) => s.busy),
    dirty = useStore(store, (s) => s.dirty);
  const error = useStore(store, (s) => s.error);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ProjectFilter>('all');
  const [sort, setSort] = useState('updated');
  const [view, setView] = useState<'grid' | 'list'>(() => {
    try {
      return localStorage.getItem('scientify.projects.view') === 'list' ? 'list' : 'grid';
    } catch {
      return 'grid';
    }
  });
  const [removing, setRemoving] = useState<
    { kind: 'project'; item: Project } | { kind: 'team'; item: Team } | null
  >(null);
  useEffect(() => {
    setQuery('');
    setFilter('all');
  }, [space]);
  const teamHub = space === '__teams__';
  const team = data.teams.find((entry) => entry.id === space);
  const projects = selectProjects(data, space, query, filter, sort);
  const teams = data.teams.filter((team) =>
    `${team.name} ${team.description ?? ''}`
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  );
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
  function remove(kind: 'project', item: Project): void;
  function remove(kind: 'team', item: Team): void;
  function remove(kind: 'project' | 'team', item: Project | Team) {
    store.getState().clearMessage();
    setRemoving(
      kind === 'project' ? { kind, item: item as Project } : { kind, item: item as Team },
    );
  }
  const actions = (project: Project) => (
    <ProjectActions
      project={project}
      busy={busy}
      onEdit={() => onEdit(project)}
      onToggle={(key) => void toggle(project, key)}
      onDelete={() => remove('project', project)}
    />
  );
  return (
    <section className="launcher-library" aria-label={t('项目管理')}>
      <header className="launcher-topbar" data-tauri-drag-region>
        <label className="launcher-search">
          <Search aria-hidden="true" />
          <Input
            type="search"
            aria-label={teamHub ? t('搜索团队') : t('搜索项目')}
            placeholder={teamHub ? t('搜索团队…') : t('搜索项目…')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        {!teamHub && (
          <div className="launcher-view-switch" role="group" aria-label={t('项目显示方式')}>
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
        )}
        <WindowControls />
      </header>
      <div className="launcher-browser-controls">
        <div className="launcher-breadcrumb">
          {team && (
            <>
              <Button variant="ghost" onClick={() => onSpace('__teams__')}>
                {t('团队协作空间')}
              </Button>
              <ChevronRight />
            </>
          )}
          <span>{teamHub ? t('团队协作空间') : (team?.name ?? t('个人空间'))}</span>
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
        <span className="spacer" />
        {!teamHub && (
          <>
            <div className="launcher-filters">
              {(
                [
                  ['all', '全部项目'],
                  ['favorite', '已收藏'],
                  ['archived', '已归档'],
                ] as const
              ).map(([id, label]) => (
                <Button
                  variant="ghost"
                  key={id}
                  aria-pressed={filter === id}
                  onClick={() => setFilter(id)}
                >
                  {t(label)}
                </Button>
              ))}
            </div>
            <Dropdown
              aria-label={t('项目排序')}
              value={sort}
              onChange={(event) => setSort(event.target.value)}
            >
              <option value="updated">{t('最近更新')}</option>
              <option value="name">{t('名称')}</option>
            </Dropdown>
          </>
        )}
        {teamHub && (
          <Button variant="ghost" onClick={onNewTeam} disabled={busy}>
            <Plus />
            {t('创建团队空间')}
          </Button>
        )}
      </div>
      <div className="launcher-canvas">
        {teamHub ? (
          <div className="launcher-team-directory">
            {!data.teams.length && (
              <div className="launcher-empty">
                <UsersRound />
                <h1>{t('暂无团队空间')}</h1>
                <p>{t('创建团队空间，集中管理团队项目。')}</p>
                <Button onClick={onNewTeam} disabled={busy}>
                  <Plus />
                  {t('创建团队空间')}
                </Button>
              </div>
            )}
            {teams.map((team) => (
              <div className="launcher-team-row" key={team.id}>
                <Button
                  variant="ghost"
                  className="launcher-team-open"
                  onClick={() => onSpace(team.id)}
                >
                  <UsersRound />
                  <span>
                    <strong>{team.name}</strong>
                    <small>
                      {team.description ||
                        t('{count} 个项目', {
                          count: data.projects.filter((project) => project.space === team.id)
                            .length,
                        })}
                    </small>
                  </span>
                  <ChevronRight />
                </Button>
                <Button
                  variant="ghost"
                  iconOnly
                  aria-label={t('编辑团队 {name}', { name: team.name })}
                  onClick={() => onEditTeam(team)}
                  disabled={busy}
                >
                  <Pencil />
                </Button>
                <Button
                  variant="ghost"
                  iconOnly
                  aria-label={t('删除团队 {name}', { name: team.name })}
                  onClick={() => remove('team', team)}
                  disabled={busy}
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
            {data.teams.length > 0 && !teams.length && (
              <p className="launcher-no-results">{t('没有符合条件的团队')}</p>
            )}
          </div>
        ) : (
          <>
            {!projects.length && (
              <div className="launcher-no-results">
                <span>{query || filter !== 'all' ? t('没有符合条件的项目') : t('暂无项目')}</span>
                {(query || filter !== 'all') && (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setQuery('');
                      setFilter('all');
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
                          <span className="project-cover-type">
                            {project.field || t('研究项目')}
                          </span>
                          <strong>{project.name}</strong>
                        </Button>
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
                  onClick={onNew}
                  disabled={busy}
                >
                  <Plus />
                  <span>{t('新建项目')}</span>
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
                      <tr key={project.id}>
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
                              <strong>{project.name}</strong>
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
                  onClick={onNew}
                >
                  <Plus />
                  {t('新建项目')}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
      {removing && (
        <Modal
          title={removing.kind === 'project' ? t('删除项目') : t('删除团队空间')}
          busy={busy}
          onClose={() => setRemoving(null)}
        >
          <div className="form-grid">
            <p>
              {removing.kind === 'project'
                ? t('删除“{name}”及其项目记录？本地文件和文献附件将保留。', {
                    name: removing.item.name,
                  })
                : t('删除团队“{name}”？其项目将移至个人空间。', { name: removing.item.name })}
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
                    .update((data) =>
                      target.kind === 'project'
                        ? deleteProject(data, target.item.id)
                        : deleteTeam(data, target.item.id),
                    );
                  if (saved) {
                    setRemoving(null);
                    if (target.kind === 'team' && space === target.item.id) onSpace('__teams__');
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
