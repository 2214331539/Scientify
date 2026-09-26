import { t, locale } from '../../i18n';
import { Button, Input, Dropdown } from '../../components/primitives';
import { Panel } from '../../components/layout/Panel';
import { useState } from 'react';
import { useStore } from 'zustand';
import { FolderClosed, Plus, Search, Star } from 'lucide-react';
import { selectProjects, type Project, type ProjectFilter } from '../../domain/workspace';
import type { WorkspaceStore } from '../../stores/workspace';
import './project-library.css';

export function ProjectLibrary({
  store,
  space,
  onOpen,
  onNew,
  onEdit,
}: {
  store: WorkspaceStore;
  space: string;
  onOpen: (id: string) => void;
  onNew: () => void;
  onEdit: (project: Project) => void;
}) {
  const data = useStore(store, (s) => s.data)!;
  const busy = useStore(store, (s) => s.busy);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ProjectFilter>('all');
  const [sort, setSort] = useState('updated');
  const projects = selectProjects(data, space, query, filter, sort);
  async function toggle(p: Project, key: 'favorite' | 'archived') {
    await store.getState().update((d) => {
      const target = d.projects.find((x) => x.id === p.id);
      if (target) {
        target[key] = !target[key];
        target.updatedAt = new Date().toISOString();
      }
    });
  }
  return (
    <Panel
      className="project-library"
      header={
        <>
          <h1>
            {space === 'personal'
              ? t('个人空间')
              : data.teams.find((t) => t.id === space)?.name || t('团队项目')}
          </h1>
          <span className="spacer" />
          <Button variant="primary" disabled={busy} onClick={onNew}>
            <Plus />
            {t('新建项目')}
          </Button>
        </>
      }
      footer={<span>{t('{count} 个项目', { count: projects.length })}</span>}
    >
      <div className="project-toolbar">
        <div className="filter-tabs">
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
              className={filter === id ? 'selected' : ''}
              aria-pressed={filter === id}
              onClick={() => setFilter(id)}
            >
              {t(label)}
            </Button>
          ))}
        </div>
        <span className="spacer" />
        <label className="projects-query">
          <Search aria-hidden="true" />
          <Input
            className="search"
            type="search"
            placeholder={t('搜索项目…')}
            aria-label={t('搜索项目')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <Dropdown aria-label={t('项目排序')} value={sort} onChange={(e) => setSort(e.target.value)}>
          <option value="updated">{t('最近更新')}</option>
          <option value="name">{t('名称')}</option>
        </Dropdown>
      </div>
      {projects.length ? (
        <div className="panel-scroll projects-content">
          <table className="data-table projects-table">
            <thead>
              <tr>
                <th style={{ width: '47%' }}>{t('项目名称')}</th>
                <th className="optional-column" style={{ width: '15%' }}>
                  {t('研究方向')}
                </th>
                <th className="meta-column" style={{ width: '16%' }}>
                  {t('最近更新')}
                </th>
                <th style={{ width: 160 }} />
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => (
                <tr key={p.id}>
                  <td>
                    <div className="project-title-cell">
                      <FolderClosed className="projects-row-icon" aria-hidden="true" />
                      <Button variant="ghost" className="project-open" onClick={() => onOpen(p.id)}>
                        <span className="object-title">{p.name}</span>
                        {p.question ? <span className="object-detail">{p.question}</span> : null}
                      </Button>
                    </div>
                  </td>
                  <td className="optional-column muted">{p.field || '—'}</td>
                  <td className="meta-column muted">
                    {new Date(p.updatedAt || p.createdAt).toLocaleDateString(locale())}
                  </td>
                  <td>
                    <div className="table-actions">
                      <Button
                        variant="ghost"
                        iconOnly
                        aria-label={`${p.favorite ? t('取消收藏') : t('收藏')} ${p.name}`}
                        aria-pressed={Boolean(p.favorite)}
                        disabled={busy}
                        onClick={() => void toggle(p, 'favorite')}
                      >
                        <Star fill={p.favorite ? 'currentColor' : 'none'} />
                      </Button>
                      <Button variant="ghost" disabled={busy} onClick={() => onEdit(p)}>
                        {t('编辑')}
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={busy}
                        onClick={() => void toggle(p, 'archived')}
                      >
                        {p.archived ? t('恢复') : t('归档')}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty-state projects-empty">
          <h2>{query || filter !== 'all' ? t('没有符合条件的项目') : t('暂无项目')}</h2>
          {query || filter !== 'all' ? (
            <Button
              onClick={() => {
                setQuery('');
                setFilter('all');
              }}
            >
              {t('清除筛选')}
            </Button>
          ) : (
            <Button variant="primary" disabled={busy} onClick={onNew}>
              <Plus />
              {t('新建项目')}
            </Button>
          )}
        </div>
      )}
    </Panel>
  );
}
