import {
  lazy,
  Suspense,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { useStore } from 'zustand';
import { FilePlus2, FileText, Import, Pencil, Search, X } from 'lucide-react';
import { Button, Dropdown, Input } from '../../components/primitives';
import { Panel } from '../../components/layout/Panel';
import { Sidebar } from '../../components/layout/Sidebar';
import { Section } from '../../components/workspace/Section';
import { TreeView } from '../../components/workspace/TreeView';
import { DocumentTabs } from '../../components/workspace/DocumentTabs';
import type { Project, Paper } from '../../domain/workspace';
import type { WorkContext } from '../../domain/context';
import type { WorkspaceStore } from '../../stores/workspace';
import type { ResearchBackend } from '../../platform/research';
import { beginFileOperation } from '../../editor/sessions';
import { createPaper } from '../../features/literature/model';
import { t, translateError } from '../../i18n';
import { PaperForm } from './PaperForm';
import { closePaperTab, openPaperTab, restorePaperTabs, type LiteratureSession } from './tabs';
import './literature.css';

const PdfReader = lazy(() => import('../../reader/PdfReader'));
const str = (value: unknown) => (typeof value === 'string' ? value : '');

export function LiteratureWorkspace({
  project,
  store,
  backend,
  view,
  onView,
  selectedPaper,
  session: savedSession,
  onSessionChange,
  width,
  resize,
  onContext,
  onTool,
}: {
  project: Project;
  store: WorkspaceStore;
  backend: ResearchBackend;
  view: string;
  onView: (view: string) => void;
  selectedPaper: string | null;
  session?: LiteratureSession;
  onSessionChange: (session: LiteratureSession) => void;
  width: number;
  resize?: ReactNode;
  onContext: (context: WorkContext) => void;
  onTool: (tool: 'assistant' | 'notes') => void;
}) {
  const data = useStore(store, (state) => state.data)!;
  const busy = useStore(store, (state) => state.busy);
  const [query, setQuery] = useState(''),
    [filter, setFilter] = useState('all');
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const [importing, setImporting] = useState(false),
    [error, setError] = useState('');
  const [pendingImport, setPendingImport] = useState<Paper | null>(null);
  useEffect(() => {
    const key = `literature-import:${project.id}`;
    store.getState().setDirtySource(key, !!pendingImport);
    return () => store.getState().setDirtySource(key, false);
  }, [store, project.id, pendingImport]);
  const [edit, setEdit] = useState<{ paper: Paper; isNew: boolean } | null>(null);
  const mounted = useRef(true),
    importPending = useRef(false);
  const panelId = useId();
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const papers = data.papers.filter((paper) => paper.projects.includes(project.id));
  const session = restorePaperTabs(
    savedSession,
    new Set(papers.map((paper) => paper.id)),
    selectedPaper,
  );
  const paper = papers.find(
    (paper) => paper.id === session.tabs.find((tab) => tab.id === session.activeId)?.paperId,
  );
  const visible = papers.filter(
    (paper) =>
      (filter === 'all' || (str(paper.status) || '未读') === filter) &&
      [paper.title, str(paper.authors), str(paper.note), str(paper.fileName)]
        .join(' ')
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase()),
  );
  const contextCallback = useRef(onContext);
  contextCallback.current = onContext;
  const latestSession = useRef(session);
  latestSession.current = session;
  const commit = useRef(onSessionChange);
  commit.current = onSessionChange;
  useEffect(() => {
    if (JSON.stringify(savedSession) !== JSON.stringify(session)) commit.current(session);
  }, [savedSession, session]);
  useEffect(() => {
    contextCallback.current({
      projectId: project.id,
      workspace: 'literature',
      title: paper?.title ?? t('项目文献'),
      resourceId: paper?.id,
      text: paper && !paper.assetId ? str(paper.abstract) || str(paper.note) : undefined,
    });
  }, [project.id, paper?.id, paper?.title, paper?.abstract, paper?.note, paper?.assetId]);
  function openPaper(id: string) {
    commit.current(openPaperTab(latestSession.current, id));
  }
  async function publishImport(candidate: Paper) {
    const success = await store.getState().update((draft) => {
      if (!draft.projects.some((item) => item.id === project.id))
        throw new Error(t('项目不存在，请重新载入。'));
      if (!draft.papers.some((item) => item.id === candidate.id)) draft.papers.push(candidate);
    });
    if (!mounted.current) return;
    if (success) {
      setPendingImport(null);
      setError('');
      openPaper(candidate.id);
    } else {
      setPendingImport(candidate);
      setError(store.getState().error ?? t('保存失败，请重试。'));
    }
  }
  async function importPdf() {
    if (importPending.current) return;
    importPending.current = true;
    setImporting(true);
    setError('');
    const finish = beginFileOperation(backend);
    try {
      if (pendingImport) await publishImport(pendingImport);
      else {
        const file = await backend.importPdf();
        if (file)
          await publishImport(
            createPaper(project.id, { title: file.fileName.replace(/\.pdf$/i, ''), ...file }),
          );
      }
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      finish();
      importPending.current = false;
      if (mounted.current) setImporting(false);
    }
  }
  const readingOptions = ['未读', '阅读中', '已读'].map((status) => (
    <option key={status} value={status}>
      {t(status)}
    </option>
  ));
  return (
    <Panel
      className="literature-studio"
      aria-label={t('{label} 工作区', { label: t('Literature') })}
    >
      <Sidebar
        className="literature-sidebar"
        aria-label={t('{label} 资源', { label: t('Literature') })}
        style={{ '--literature-sidebar-width': `${width}px` } as CSSProperties}
      >
        <nav className="literature-sidebar-views" aria-label={t('二级导航')}>
          <Button
            variant="ghost"
            aria-current={view !== 'subscriptions' ? 'page' : undefined}
            onClick={() => onView('local')}
          >
            {t('Library')}
          </Button>
          <Button
            variant="ghost"
            aria-current={view === 'subscriptions' ? 'page' : undefined}
            onClick={() => onView('subscriptions')}
          >
            {t('Subscriptions')}
          </Button>
        </nav>
        <div className="literature-library" hidden={view === 'subscriptions'}>
          <div className="literature-sidebar-actions">
            <Button variant="ghost" disabled={importing || busy} onClick={() => void importPdf()}>
              <Import size={14} />
              {importing ? t('正在导入…') : pendingImport ? t('重试保存') : t('导入 PDF')}
            </Button>
            <span className="spacer" />
            <Button
              variant="ghost"
              iconOnly
              aria-label={t('收录文献')}
              disabled={busy || importing}
              onClick={() => setEdit({ paper: createPaper(project.id, {}), isNew: true })}
            >
              <FilePlus2 size={15} />
            </Button>
          </div>
          <label className="library-search">
            <Search size={14} aria-hidden="true" />
            <Input
              type="search"
              aria-label={t('搜索文献')}
              placeholder={t('搜索文献…')}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                if (event.target.value.trim()) setCollapsed(new Set());
              }}
            />
          </label>
          <Dropdown
            className="literature-filter"
            aria-label={t('筛选阅读状态')}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          >
            <option value="all">{t('全部状态')}</option>
            {readingOptions}
          </Dropdown>
          {error && (
            <div role="alert" className="literature-sidebar-error">
              {translateError(error)}
              <Button
                variant="ghost"
                iconOnly
                aria-label={t('关闭错误')}
                onClick={() => setError('')}
              >
                <X size={12} />
              </Button>
            </div>
          )}
          <div className="literature-tree-scroll">
            <TreeView
              label={t('文献资源')}
              items={[
                {
                  id: `folder:${project.id}`,
                  label: project.name,
                  tooltip: project.name,
                  children: visible.map((item) => ({
                    id: item.id,
                    label: item.title,
                    tooltip: str(item.fileName) || item.title,
                    icon: <FileText size={15} />,
                  })),
                },
              ]}
              selectedId={paper?.id}
              collapsed={collapsed}
              onToggle={(id) =>
                setCollapsed((previous) => {
                  const next = new Set(previous);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                })
              }
              onOpen={openPaper}
            />
            {!visible.length && (
              <p className="literature-tree-empty">
                {query || filter !== 'all' ? t('没有匹配的文献') : t('暂无文献')}
              </p>
            )}
          </div>
          <div className="literature-selection">
            <span className="literature-resource-count">
              {t('{count} 篇文献', { count: visible.length })}
            </span>
            {paper && (
              <div className="literature-selection-actions">
                <Dropdown
                  aria-label={t('阅读状态')}
                  value={str(paper.status) || '未读'}
                  disabled={busy}
                  onChange={(event) => {
                    const status = event.target.value;
                    void store.getState().update((draft) => {
                      const item = draft.papers.find((item) => item.id === paper.id);
                      if (item) item.status = status;
                    });
                  }}
                >
                  {readingOptions}
                </Dropdown>
                <Button
                  variant="ghost"
                  iconOnly
                  aria-label={t('文献信息')}
                  onClick={() => setEdit({ paper, isNew: false })}
                >
                  <Pencil size={14} />
                </Button>
              </div>
            )}
          </div>
        </div>
        <div
          className="literature-subscriptions-placeholder"
          role="region"
          aria-label={t('文献订阅')}
          hidden={view !== 'subscriptions'}
        />
      </Sidebar>
      {resize}
      <div className="literature-documents">
        <DocumentTabs
          tabs={session.tabs.map((tab, index) => ({
            id: tab.id,
            title:
              papers.find((item) => item.id === tab.paperId)?.title ??
              t('空白页 {index}', { index: index + 1 }),
          }))}
          activeId={session.activeId}
          panelId={panelId}
          onSelect={(id) => onSessionChange({ ...session, activeId: id })}
          onClose={(id) => onSessionChange(closePaperTab(session, id))}
          onNew={() => {
            const tab = { id: `blank:${crypto.randomUUID()}`, paperId: null };
            onSessionChange({ tabs: [...session.tabs, tab], activeId: tab.id });
          }}
        />
        <div
          className="literature-document"
          role="tabpanel"
          aria-label={t('文献呈现区')}
          id={panelId}
        >
          {paper ? (
            str(paper.assetId) ? (
              <Suspense fallback={<div className="empty-state">{t('正在打开阅读器…')}</div>}>
                <PdfReader
                  key={`${paper.id}:${str(paper.assetId)}`}
                  assetId={str(paper.assetId)}
                  title={paper.title}
                  projectId={project.id}
                  paperId={paper.id}
                  backend={backend}
                  onContext={onContext}
                  onTool={onTool}
                  compact
                />
              </Suspense>
            ) : (
              <div className="panel-scroll paper-details" key={paper.id}>
                <h1>{paper.title}</h1>
                {str(paper.authors) && <p className="muted">{str(paper.authors)}</p>}
                {str(paper.abstract) && (
                  <Section title={t('摘要')}>
                    <p>{str(paper.abstract)}</p>
                  </Section>
                )}
                {str(paper.note) && (
                  <Section title={t('备注')}>
                    <p>{str(paper.note)}</p>
                  </Section>
                )}
                <p className="muted">{t('未附加 PDF')}</p>
                {str(paper.url) && (
                  <p className="muted data-path">
                    {t('来源：{source}', { source: str(paper.url) })}
                  </p>
                )}
              </div>
            )
          ) : (
            <div className="literature-blank">
              <FileText size={28} strokeWidth={1.2} />
              <span>{t('从左侧打开文献')}</span>
            </div>
          )}
        </div>
      </div>
      {edit && (
        <PaperForm
          paper={edit.paper}
          isNew={edit.isNew}
          store={store}
          backend={backend}
          onClose={() => setEdit(null)}
          onSaved={(id) => {
            setEdit(null);
            openPaper(id);
          }}
        />
      )}
    </Panel>
  );
}
