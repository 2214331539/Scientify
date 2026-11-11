import { t, translateError } from '../../i18n';
import { isTrashed } from '../notes/model';
import { Input } from '../../components/primitives';
import { Section } from '../../components/workspace/Section';
import { ResourceList, ResourceRow } from '../../components/workspace/ResourceList';
import { useDeferredValue, useEffect, useState } from 'react';
import { useStore } from 'zustand';
import { BookOpen, FolderKanban, NotebookPen, Search } from 'lucide-react';
import type { Workspace } from '../../domain/workspace';
import type { WorkspaceStore } from '../../stores/workspace';
import { Modal } from '../../components/Modal';
import { nativeLibrary, type LibraryBackend, type LibraryEntry } from '../../platform/library';
import './search.css';

export interface SearchTarget {
  projectId?: string;
  workspace: 'overview' | 'literature' | 'experiments' | 'writing' | 'projects';
  resourceId?: string;
  tool?: 'notes' | 'assistant';
}
type SearchResult = {
  id: string;
  kind: 'project' | 'paper' | 'note';
  title: string;
  excerpt: string;
  scope: string;
  target: SearchTarget;
  unavailable?: boolean;
  /** A PDF in a project's literature folder, opened by its path. */
  path?: string;
};

/** PDFs in each project's literature folder, by project id. */
export type LibraryFiles = Map<string, LibraryEntry[]>;

function excerpt(text: string, term: string) {
  const index = text.toLocaleLowerCase().indexOf(term);
  const start = Math.max(0, index - 28);
  return `${start ? '…' : ''}${text.slice(start, start + 130).replace(/\s+/g, ' ')}`;
}

export function searchWorkspace(
  data: Workspace | null,
  query: string,
  libraries: LibraryFiles = new Map(),
): SearchResult[] {
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
  for (const [projectId, entries] of libraries) {
    const project = projects.get(projectId);
    if (!project) continue;
    for (const entry of entries) {
      if (!matches(entry.path)) continue;
      const folder = entry.path.slice(0, -entry.name.length).replace(/\/$/, '');
      results.push({
        id: `${projectId}:${entry.path}`,
        kind: 'paper',
        title: entry.name.replace(/\.pdf$/i, ''),
        excerpt: folder,
        scope: project.name,
        path: entry.path,
        target: { projectId, workspace: 'literature' },
      });
    }
  }
  for (const note of data.records) {
    if (isTrashed(note) || !matches(`${note.title} ${note.body}`)) continue;
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
  projectId,
  library = nativeLibrary,
}: {
  store: WorkspaceStore;
  onClose: () => void;
  onNavigate: (target: SearchTarget) => void;
  /** Inside a project, its literature folder is searched; otherwise every project's. */
  projectId?: string;
  library?: LibraryBackend;
}) {
  const data = useStore(store, (state) => state.data);
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [libraries, setLibraries] = useState<LibraryFiles | null>(null);
  const [opening, setOpening] = useState('');
  const [error, setError] = useState('');
  const typed = !!query.trim();
  // Read the literature folders once, when the first key is typed.
  useEffect(() => {
    if (!typed || libraries || !data) return;
    let active = true;
    const ids = projectId
      ? [projectId]
      : data.projects.filter((project) => !project.archived).map((project) => project.id);
    void Promise.all(
      ids.map((id) =>
        library
          .command(id, { op: 'scan' })
          .then((scan) => [id, scan.entries.filter((entry) => entry.pdf)] as const)
          .catch(() => [id, []] as const),
      ),
    ).then((found) => {
      if (active) setLibraries(new Map(found.map(([id, entries]) => [id, [...entries]])));
    });
    return () => {
      active = false;
    };
  }, [typed, libraries, data, projectId, library]);
  const results = searchWorkspace(data, deferredQuery, libraries ?? undefined);
  async function open(result: SearchResult) {
    if (!result.path || !result.target.projectId) {
      onNavigate(result.target);
      onClose();
      return;
    }
    // Opening binds the PDF, which gives the reader an id to land on.
    setOpening(result.id);
    setError('');
    try {
      const paper = await library.open(result.target.projectId, result.path);
      onNavigate({ ...result.target, resourceId: paper.id });
      onClose();
    } catch (reason) {
      setError(String(reason instanceof Error ? reason.message : reason));
    } finally {
      setOpening('');
    }
  }
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
            placeholder={t('项目、论文或笔记')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <p className="sf-search-hint">
          {projectId ? t('当前项目的论文文件名、全部项目和笔记') : t('项目、论文文件名和笔记')}
        </p>
        {error ? (
          <p className="sf-search-hint error-text" role="alert">
            {translateError(error)}
          </p>
        ) : null}
        <div
          className="sf-search-results"
          aria-busy={query !== deferredQuery || (typed && !libraries)}
        >
          {!query.trim() ? (
            <div className="sf-search-empty">{t('输入关键词')}</div>
          ) : !results.length ? (
            <div className="sf-search-empty" role="status">
              {libraries ? t('没有找到“{query}”相关内容。', { query }) : t('正在搜索…')}
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
                        disabled={result.unavailable || !!opening}
                        title={result.unavailable ? result.scope : result.title}
                        onClick={() => void open(result)}
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
