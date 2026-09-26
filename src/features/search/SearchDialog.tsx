import { t } from '../../i18n';
import { Input } from '../../components/primitives';
import { Section } from '../../components/workspace/Section';
import { ResourceList, ResourceRow } from '../../components/workspace/ResourceList';
import { useDeferredValue, useState } from 'react';
import { useStore } from 'zustand';
import { BookOpen, FolderKanban, NotebookPen, Search } from 'lucide-react';
import type { Workspace } from '../../domain/workspace';
import type { WorkspaceStore } from '../../stores/workspace';
import { Modal } from '../../components/Modal';
import './search.css';

export interface SearchTarget {
  projectId?: string;
  workspace: 'overview' | 'literature' | 'experiments' | 'writing' | 'projects';
  resourceId?: string;
  tool?: 'notes';
}
type SearchResult = {
  id: string;
  kind: 'project' | 'paper' | 'note';
  title: string;
  excerpt: string;
  scope: string;
  target: SearchTarget;
  unavailable?: boolean;
};

function excerpt(text: string, term: string) {
  const index = text.toLocaleLowerCase().indexOf(term);
  const start = Math.max(0, index - 28);
  return `${start ? '…' : ''}${text.slice(start, start + 130).replace(/\s+/g, ' ')}`;
}

export function searchWorkspace(data: Workspace | null, query: string): SearchResult[] {
  const term = query.trim().toLocaleLowerCase();
  if (!data || !term) return [];
  const projects = new Map(data.projects.map((project) => [project.id, project]));
  const matches = (text: string) => text.toLocaleLowerCase().includes(term);
  const results: SearchResult[] = [];
  for (const project of data.projects) {
    if (!matches(`${project.name} ${project.question}`)) continue;
    results.push({
      id: project.id,
      kind: 'project',
      title: project.name,
      excerpt: excerpt(project.question, term),
      scope: project.archived ? t('已归档项目') : t('项目'),
      target: { projectId: project.id, workspace: 'overview' },
    });
  }
  for (const paper of data.papers) {
    const authors = typeof paper.authors === 'string' ? paper.authors : '';
    if (!matches(`${paper.title} ${authors}`)) continue;
    const scopes = paper.projects.map((id) => projects.get(id)).filter(Boolean);
    results.push({
      id: paper.id,
      kind: 'paper',
      title: paper.title,
      excerpt: authors,
      scope: scopes.map((project) => project!.name).join('、') || t('未关联项目'),
      unavailable: !scopes.length,
      target: { projectId: scopes[0]?.id, workspace: 'literature', resourceId: paper.id },
    });
  }
  for (const note of data.records) {
    if (!matches(`${note.title} ${note.body}`)) continue;
    const personal = note.project === '__inbox__';
    const project = projects.get(note.project);
    results.push({
      id: note.id,
      kind: 'note',
      title: note.title || t('未命名笔记'),
      excerpt: excerpt(note.body, term),
      scope: personal ? t('个人收集箱') : project?.name || t('来源项目不存在'),
      unavailable: !personal && !project,
      target: {
        projectId: personal ? undefined : note.project,
        workspace: personal ? 'projects' : 'overview',
        resourceId: note.id,
        tool: 'notes',
      },
    });
  }
  return results;
}

export function SearchDialog({
  store,
  onClose,
  onNavigate,
}: {
  store: WorkspaceStore;
  onClose: () => void;
  onNavigate: (target: SearchTarget) => void;
}) {
  const data = useStore(store, (state) => state.data);
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const results = searchWorkspace(data, deferredQuery);
  const groups = [
    { kind: 'project' as const, title: t('项目'), Icon: FolderKanban },
    { kind: 'paper' as const, title: t('文献'), Icon: BookOpen },
    { kind: 'note' as const, title: t('研究笔记'), Icon: NotebookPen },
  ];
  return (
    <Modal title={t('搜索工作区')} onClose={onClose}>
      <div className="sf-search-dialog">
        <label className="sf-search-query">
          <Search size={16} />
          <Input
            autoFocus
            aria-label={t('搜索项目、文献和笔记')}
            placeholder={t('项目、文献题名、作者或笔记正文')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <p className="sf-search-hint">{t('项目、文献与笔记 · 不含 PDF 全文和磁盘文件')}</p>
        <div className="sf-search-results" aria-busy={query !== deferredQuery}>
          {!query.trim() ? (
            <div className="sf-search-empty">{t('输入关键词')}</div>
          ) : !results.length ? (
            <div className="sf-search-empty" role="status">
              {t('没有找到“{query}”相关内容。', { query })}
            </div>
          ) : (
            groups.map(({ kind, title, Icon }) => {
              const matching = results.filter((result) => result.kind === kind);
              return matching.length ? (
                <Section
                  key={kind}
                  title={t(title)}
                  actions={<span className="muted">{matching.length}</span>}
                  className="sf-search-group"
                >
                  <ResourceList label={t('{title}搜索结果', { title: t(title) })}>
                    {matching.slice(0, 30).map((result) => (
                      <ResourceRow
                        className="sf-search-result"
                        key={result.id}
                        disabled={result.unavailable}
                        title={result.unavailable ? result.scope : result.title}
                        onClick={() => {
                          onNavigate(result.target);
                          onClose();
                        }}
                      >
                        <Icon size={17} />
                        <span>
                          <strong>{result.title}</strong>
                          {result.excerpt ? <small>{result.excerpt}</small> : null}
                          <em>{result.scope}</em>
                        </span>
                      </ResourceRow>
                    ))}
                  </ResourceList>
                  {matching.length > 30 ? (
                    <p className="sf-search-hint">{t('仅显示前 30 项，请缩小关键词范围。')}</p>
                  ) : null}
                </Section>
              ) : null;
            })
          )}
        </div>
      </div>
    </Modal>
  );
}
