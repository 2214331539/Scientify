import { t, translateError } from '../../i18n';
import { isTrashed } from '../notes/model';
import { Input } from '../../components/primitives';
import { ResourceList, ResourceRow } from '../../components/workspace/ResourceList';
import { useDeferredValue, useEffect, useState, type KeyboardEvent } from 'react';
import { useStore } from 'zustand';
import {
  BookOpen,
  CornerDownLeft,
  FlaskConical,
  FolderKanban,
  NotebookPen,
  PenLine,
  Search,
  type LucideIcon,
} from 'lucide-react';
import type { Workspace } from '../../domain/workspace';
import type { WorkspaceStore } from '../../stores/workspace';
import { Modal } from '../../components/Modal';
import { nativeLibrary, type LibraryBackend, type LibraryEntry } from '../../platform/library';
import { relativeTime } from '../projects/model';
import './search.css';

export interface SearchTarget {
  projectId?: string;
  /** `overview` opens a project where the user left it. */
  workspace: 'overview' | 'literature' | 'notes' | 'experiments' | 'writing' | 'projects';
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

function noteTarget(note: { id: string; project: string }, personal: boolean): SearchTarget {
  return personal
    ? { projectId: undefined, workspace: 'projects', resourceId: note.id, tool: 'notes' }
    : { projectId: note.project, workspace: 'notes', resourceId: note.id };
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
      target: noteTarget(note, personal),
    });
  }
  return results;
}

const modules: { workspace: SearchTarget['workspace']; label: string; Icon: LucideIcon }[] = [
  { workspace: 'literature', label: '文献', Icon: BookOpen },
  { workspace: 'notes', label: '笔记', Icon: NotebookPen },
  { workspace: 'experiments', label: '实验', Icon: FlaskConical },
  { workspace: 'writing', label: '写作', Icon: PenLine },
];

/** Arrow keys walk the rows; Enter opens the focused one, or the first from the field. */
function moveFocus(event: KeyboardEvent<HTMLElement>) {
  if (!['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key) || event.nativeEvent.isComposing)
    return;
  const rows = [
    ...event.currentTarget.querySelectorAll<HTMLButtonElement>('.sf-search-result:not(:disabled)'),
  ];
  const fromField = (event.target as HTMLElement).tagName === 'INPUT';
  if (event.key === 'Enter') {
    if (fromField && rows[0]) {
      event.preventDefault();
      rows[0].click();
    }
    return;
  }
  event.preventDefault();
  const index = rows.indexOf(document.activeElement as HTMLButtonElement);
  const next =
    event.key === 'ArrowDown'
      ? rows[fromField ? 0 : Math.min(rows.length - 1, index + 1)]
      : index <= 0
        ? event.currentTarget.querySelector<HTMLInputElement>('input')
        : rows[index - 1];
  next?.focus();
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
  function go(target: SearchTarget) {
    onNavigate(target);
    onClose();
  }
  const groups = [
    { kind: 'project' as const, title: t('项目'), Icon: FolderKanban },
    { kind: 'paper' as const, title: t('文献'), Icon: BookOpen },
    { kind: 'note' as const, title: t('笔记'), Icon: NotebookPen },
  ];
  // Before typing: where the user can go next.
  const recentNotes = projectId
    ? (data?.records ?? [])
        .filter((note) => note.project === projectId && !isTrashed(note))
        .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
        .slice(0, 5)
    : [];
  const recentProjects = projectId
    ? []
    : (data?.projects ?? [])
        .filter((project) => !project.archived)
        .sort((a, b) =>
          (b.updatedAt ?? b.createdAt ?? '').localeCompare(a.updatedAt ?? a.createdAt ?? ''),
        )
        .slice(0, 6);
  const row = (
    key: string,
    Icon: LucideIcon,
    title: string,
    meta: string,
    onClick: () => void,
    detail?: string,
    disabled?: boolean,
  ) => (
    <ResourceRow
      key={key}
      className="sf-search-result"
      disabled={disabled}
      title={title}
      onClick={onClick}
    >
      <Icon size={16} />
      <span>
        <strong>{title}</strong>
        {detail ? <small>{detail}</small> : null}
      </span>
      {meta ? <em>{meta}</em> : null}
      <CornerDownLeft size={13} className="sf-search-enter" aria-hidden="true" />
    </ResourceRow>
  );
  return (
    <Modal title={t('搜索')} className="sf-palette" onClose={onClose}>
      <div className="sf-search-dialog" onKeyDown={moveFocus}>
        <label className="sf-search-query">
          <Search size={18} />
          <Input
            autoFocus
            aria-label={t('搜索项目、文献和笔记')}
            placeholder={projectId ? t('搜索论文、笔记，或跳转') : t('搜索项目、论文和笔记')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <kbd>Esc</kbd>
        </label>
        {error ? (
          <p className="sf-search-error" role="alert">
            {translateError(error)}
          </p>
        ) : null}
        <div
          className="sf-search-results"
          aria-busy={query !== deferredQuery || (typed && !libraries)}
        >
          {!typed ? (
            projectId ? (
              <>
                <div className="sf-search-group">
                  <h3>{t('前往')}</h3>
                  <ResourceList label={t('前往')}>
                    {modules.map(({ workspace, label, Icon }) =>
                      row(workspace, Icon, t(label), '', () => go({ projectId, workspace })),
                    )}
                  </ResourceList>
                </div>
                {recentNotes.length ? (
                  <div className="sf-search-group">
                    <h3>{t('最近的笔记')}</h3>
                    <ResourceList label={t('最近的笔记')}>
                      {recentNotes.map((note) =>
                        row(
                          note.id,
                          NotebookPen,
                          note.title || t('未命名笔记'),
                          relativeTime(note.updatedAt),
                          () => go(noteTarget(note, false)),
                        ),
                      )}
                    </ResourceList>
                  </div>
                ) : null}
              </>
            ) : recentProjects.length ? (
              <div className="sf-search-group">
                <h3>{t('最近的项目')}</h3>
                <ResourceList label={t('最近的项目')}>
                  {recentProjects.map((project) =>
                    row(
                      project.id,
                      FolderKanban,
                      project.name,
                      relativeTime(project.updatedAt ?? project.createdAt),
                      () => go({ projectId: project.id, workspace: 'overview' }),
                    ),
                  )}
                </ResourceList>
              </div>
            ) : (
              <div className="sf-search-empty">{t('还没有项目')}</div>
            )
          ) : !results.length ? (
            <div className="sf-search-empty" role="status">
              {libraries ? t('没有找到“{query}”相关内容。', { query }) : t('正在搜索…')}
            </div>
          ) : (
            groups.map(({ kind, title, Icon }) => {
              const matching = results.filter((result) => result.kind === kind);
              return matching.length ? (
                <div key={kind} className="sf-search-group">
                  <h3>
                    {title}
                    <span>{matching.length}</span>
                  </h3>
                  <ResourceList label={t('{title}搜索结果', { title })}>
                    {matching
                      .slice(0, 30)
                      .map((result) =>
                        row(
                          result.id,
                          Icon,
                          result.title,
                          result.scope,
                          () => void open(result),
                          result.excerpt,
                          result.unavailable || !!opening,
                        ),
                      )}
                  </ResourceList>
                </div>
              ) : null;
            })
          )}
        </div>
      </div>
    </Modal>
  );
}
