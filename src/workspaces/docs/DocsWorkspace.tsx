import { linkImport, linkPreview } from '../../platform/weblinks';
import { locateAttachment, pickAttachments, saveAttachment } from '../../platform/attachments';
/**
 * The documents module: a project's knowledge base. The sidebar holds the page tree; the main
 * area shows the documents home or one page with its block editor.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeft,
  Copy,
  Download,
  FileDown,
  FileText,
  FolderInput,
  History,
  Image as ImageIcon,
  Link2,
  MoreHorizontal,
  MoveHorizontal,
  Plus,
  Smile,
  Star,
  Trash2,
  Upload,
} from 'lucide-react';
import { Button } from '../../components/primitives';
import { Menu, type MenuAnchor } from '../../components/primitives/Menu';
import { confirmAction } from '../../components/prompts';
import { t } from '../../i18n';
import { errorMessage } from '../../domain/errors';
import type { WorkContext } from '../../domain/context';
import type { Project } from '../../domain/workspace';
import { canEditProject } from '../../platform/collaboration';
import { appDocs, type DocsBackend } from '../../platform/docs';
import { nativeLibrary, type LibraryBackend } from '../../platform/library';
import { noteImages } from '../../platform/note-images';
import type { ResearchBackend } from '../../platform/research';
import type { WorkspaceStore } from '../../stores/workspace';
import { useCloud } from '../../features/projects/cloud';
import { useActiveView } from '../../components/workspace/ViewTransition';
import { useSidebarSlot } from '../../shell/Sidebar';
import { DocsSide, PageIcon, type PageAction } from './DocsSide';
import {
  HistoryDialog,
  IconPicker,
  MoveDialog,
  PickDialog,
  TemplatesDialog,
  TrashDialog,
} from './dialogs';
import { DocEditor } from './editor/DocEditor';
import type { DocEnv, Pick } from './editor/env';
import { markdownToPage, pageToMarkdown } from './markdown';
import {
  blockLink,
  openDocTarget,
  parseBlockLink,
  revealBlock,
  takePendingBlock,
} from './blockLink';
import { defaultCover, PageCover } from './cover';
import { imageForWord, pageToDocx } from './docx';
import { useNoteMigration } from './migrate';
import {
  blockText,
  pathTo,
  templateBlocks,
  TEMPLATES,
  type Block,
  type Page,
  type PageSummary,
  type TemplateId,
} from './model';
import { docsRuntime, useDocs, type DocsRuntime } from './runtime';
import './docs.css';

type Dialog =
  | { kind: 'templates'; parent: string | null }
  | { kind: 'trash' }
  | { kind: 'move'; page: PageSummary }
  | { kind: 'history'; page: PageSummary }
  | { kind: 'icon'; page: PageSummary }
  | { kind: 'pick'; pick: 'paper' | 'paperNote' | 'file'; resolve(item: Pick | null): void };

const when = (iso: string | undefined) => {
  if (!iso) return '';
  const date = new Date(iso);
  const minutes = Math.round((Date.now() - date.getTime()) / 60000);
  if (minutes < 1) return t('刚刚');
  if (minutes < 60) return t('{count} 分钟前', { count: minutes });
  if (minutes < 24 * 60) return t('{count} 小时前', { count: Math.round(minutes / 60) });
  return date.toLocaleDateString();
};
const emptyPage = (blocks: Block[]) =>
  blocks.length <= 1 &&
  !blocks.some((block) => blockText(block).trim() || block.type !== 'paragraph');

export function DocsWorkspace({
  project,
  store,
  backend,
  docs = appDocs(),
  library = nativeLibrary,
  activePage: modulePage,
  onOpenPage: openModulePage,
  onContext,
  onTool,
  mode = 'module',
}: {
  project: Project;
  store: WorkspaceStore;
  backend: ResearchBackend;
  docs?: DocsBackend;
  library?: LibraryBackend;
  activePage?: string | null;
  onOpenPage?(id: string | null): void;
  onContext(context: WorkContext): void;
  onTool(tool: 'assistant' | 'notes'): void;
  /** `dock` is the right-hand panel: the tree when no page is open, a narrow page when one is. */
  mode?: 'module' | 'dock';
}) {
  const runtime = useMemo(() => docsRuntime(docs, project.id), [docs, project.id]);
  const dockKey = `scientify.docs.dock.${project.id}`;
  const [dockPage, setDockPage] = useState<string | null>(() => {
    try {
      return localStorage.getItem(dockKey);
    } catch {
      return null;
    }
  });
  const activePage = mode === 'dock' ? dockPage : modulePage;
  const onOpenPage = (id: string | null) => {
    if (mode !== 'dock') return openModulePage?.(id);
    setDockPage(id);
    try {
      if (id) localStorage.setItem(dockKey, id);
      else localStorage.removeItem(dockKey);
    } catch {
      /* Preferences are optional. */
    }
  };
  const sidebarSlot = useSidebarSlot();
  const slot = mode === 'dock' ? null : sidebarSlot;
  const viewActive = useActiveView();
  const readOnly = !canEditProject(project, 'doc');
  const pages = useDocs(runtime, (state) => state.pages);
  const loaded = useDocs(runtime, (state) => state.loaded);
  const loadError = useDocs(runtime, (state) => state.error);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 4000);
    return () => clearTimeout(timer);
  }, [notice]);
  useNoteMigration(store, docs, project.id, runtime);
  useEffect(() => {
    void runtime.load().then(() => runtime.purgeExpired());
  }, [runtime]);
  const current =
    activePage && pages.some((page) => page.id === activePage && !page.deletedAt)
      ? activePage
      : null;
  const run = useCallback(
    (work: Promise<unknown>) => void work.catch((reason) => setError(errorMessage(reason))),
    [],
  );

  async function create(parent: string | null, template: TemplateId = 'blank') {
    const page = await runtime.create({ parent, template });
    onOpenPage(page.id);
  }
  async function action(kind: PageAction, page: PageSummary) {
    if (kind === 'subpage') return create(page.id);
    if (kind === 'duplicate') return onOpenPage((await runtime.duplicate(page.id)).id);
    if (kind === 'move') return setDialog({ kind: 'move', page });
    if (kind === 'star') return runtime.star(page.id);
    if (kind === 'export') return exportMarkdown(page.id);
    if (kind === 'exportWord') return exportWord(page.id);
    if (kind === 'delete') {
      const count = await runtime.trash(page.id);
      if (current && !pages.some((item) => item.id === current && !item.deletedAt))
        onOpenPage(null);
      else if (page.id === current) onOpenPage(page.parent);
      setNotice(
        count > 1
          ? t('已移到回收站（含 {count} 个子页面）', { count: count - 1 })
          : t('已移到回收站'),
      );
    }
  }
  async function exportMarkdown(id: string) {
    const page = runtime.store.getState().open[id]?.page ?? (await docs.read(project.id, id)).page;
    const images: string[] = [];
    const collect = (blocks: Block[]) =>
      blocks.forEach((block) => {
        if (block.type === 'image' && typeof block.props?.asset === 'string')
          images.push(block.props.asset);
        collect(block.children ?? []);
      });
    collect(page.blocks);
    await docs.exportMarkdown?.(
      project.id,
      page.title || t('无标题'),
      pageToMarkdown(page.title, page.blocks),
      images,
    );
  }
  async function exportWord(id: string) {
    const page = runtime.store.getState().open[id]?.page ?? (await docs.read(project.id, id)).page;
    const images = noteImages(project.id);
    const bytes = await pageToDocx(page, {
      image: async (asset) => imageForWord(await images.read(asset)).catch(() => null),
    });
    if (await docs.saveFile?.(page.title || t('无标题'), 'docx', bytes))
      setNotice(t('已导出 Word 文档'));
  }
  async function importMarkdown() {
    const files = (await docs.importMarkdown?.()) ?? [];
    let last: Page | null = null;
    for (const file of files) {
      const parsed = markdownToPage(file.content, {
        page: (title) => {
          const found = runtime.store
            .getState()
            .pages.find((page) => page.title === title && !page.deletedAt);
          return found ? { id: found.id, label: found.title } : undefined;
        },
      });
      last = await runtime.create({
        parent: current,
        title: parsed.title || file.name,
        blocks: parsed.blocks.length ? parsed.blocks : undefined,
      });
    }
    if (last) onOpenPage(last.id);
  }

  const side = (
    <DocsSide
      runtime={runtime}
      current={current}
      readOnly={readOnly}
      onOpen={(id) => onOpenPage(id)}
      onAction={(kind, page) => run(action(kind, page))}
      onNew={(parent) => run(create(parent))}
      onTemplates={() => setDialog({ kind: 'templates', parent: null })}
      onImport={() => run(importMarkdown())}
      onTrash={() => setDialog({ kind: 'trash' })}
    />
  );

  return (
    <div className={`doc-workspace${mode === 'dock' ? ' is-dock' : ''}`}>
      {slot && viewActive ? createPortal(side, slot) : null}
      {slot || mode === 'dock' ? null : <aside className="doc-workspace-side">{side}</aside>}
      <div className="doc-main">
        {error || loadError ? (
          <div className="inline-error doc-error" role="alert">
            <span>{error || loadError}</span>
            <Button variant="ghost" onClick={() => setError('')}>
              {t('关闭')}
            </Button>
          </div>
        ) : null}
        {notice ? (
          <div className="doc-notice" role="status">
            {notice}
          </div>
        ) : null}
        {current ? (
          <DocPage
            key={current}
            runtime={runtime}
            id={current}
            onError={setError}
            onNotice={setNotice}
            wordExport={!!docs.saveFile}
            project={project}
            library={library}
            readOnly={readOnly}
            onOpenPage={onOpenPage}
            onContext={onContext}
            onTool={onTool}
            onDialog={setDialog}
            onAction={(kind, page) => run(action(kind, page))}
            onExport={(id) => run(exportMarkdown(id))}
            compact={mode === 'dock'}
          />
        ) : mode === 'dock' ? (
          <div className="doc-dock-tree">{side}</div>
        ) : loaded ? (
          <DocsHome
            runtime={runtime}
            readOnly={readOnly}
            onOpen={onOpenPage}
            onNew={() => run(create(null))}
            onTemplates={() => setDialog({ kind: 'templates', parent: null })}
            onImport={() => run(importMarkdown())}
            onContext={() =>
              onContext({ projectId: project.id, workspace: 'notes', title: t('文档') })
            }
          />
        ) : null}
      </div>
      {dialog?.kind === 'templates' ? (
        <TemplatesDialog
          onClose={() => setDialog(null)}
          onPick={(template) => {
            setDialog(null);
            run(create(dialog.parent, template));
          }}
        />
      ) : null}
      {dialog?.kind === 'trash' ? (
        <TrashDialog runtime={runtime} onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === 'move' ? (
        <MoveDialog runtime={runtime} page={dialog.page} onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === 'history' ? (
        <HistoryDialog
          runtime={runtime}
          page={dialog.page}
          onClose={() => setDialog(null)}
          onRestore={(version) =>
            runtime.edit(
              dialog.page.id,
              { title: version.title, icon: version.icon, blocks: version.blocks },
              true,
            )
          }
        />
      ) : null}
      {dialog?.kind === 'icon' ? (
        <IconPicker
          onClose={() => setDialog(null)}
          onPick={(icon) => {
            setDialog(null);
            run(runtime.setIcon(dialog.page.id, icon));
          }}
        />
      ) : null}
      {dialog?.kind === 'pick' ? (
        <PickDialog
          title={
            dialog.pick === 'file'
              ? t('插入项目文件')
              : dialog.pick === 'paperNote'
                ? t('插入论文笔记')
                : t('插入论文')
          }
          load={
            dialog.pick === 'file'
              ? () => projectFiles(backend, project.id)
              : () => papers(library, project.id)
          }
          onClose={() => {
            dialog.resolve(null);
            setDialog(null);
          }}
          onPick={(item) => {
            dialog.resolve(item);
            setDialog(null);
          }}
        />
      ) : null}
    </div>
  );
}

const papers = async (library: LibraryBackend, projectId: string): Promise<Pick[]> =>
  (await library.command(projectId, { op: 'scan' })).entries
    .filter((entry) => entry.pdf)
    .map((entry) => ({ path: entry.path, title: entry.name.replace(/\.pdf$/i, '') }));
const projectFiles = async (backend: ResearchBackend, projectId: string): Promise<Pick[]> =>
  (await backend.listFiles(projectId))
    .filter((file) => file.kind === 'file')
    .map((file) => ({ path: file.path, title: file.name }));

function DocsHome({
  runtime,
  readOnly,
  onOpen,
  onNew,
  onTemplates,
  onImport,
  onContext,
}: {
  runtime: DocsRuntime;
  readOnly: boolean;
  onOpen(id: string): void;
  onNew(): void;
  onTemplates(): void;
  onImport(): void;
  onContext(): void;
}) {
  const pages = useDocs(runtime, (state) => state.pages);
  const starred = useDocs(runtime, (state) => state.starred);
  const contextRef = useRef(onContext);
  contextRef.current = onContext;
  useEffect(() => contextRef.current(), []);
  const live = pages.filter((page) => !page.deletedAt);
  const recent = [...live].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 8);
  const marked = starred
    .map((id) => live.find((page) => page.id === id))
    .filter((page): page is PageSummary => !!page);
  return (
    <div className="doc-scroll">
      <div className="doc-column doc-home">
        <h1>{t('文档')}</h1>
        {readOnly ? null : (
          <div className="doc-home-actions">
            <Button variant="primary" onClick={onNew}>
              <Plus size={14} />
              {t('新建页面')}
            </Button>
            <Button onClick={onTemplates}>{t('从模板新建')}</Button>
            <Button onClick={onImport}>
              <Upload size={14} />
              {t('导入 Markdown')}
            </Button>
          </div>
        )}
        {recent.length ? (
          <>
            <h2>{t('最近编辑')}</h2>
            <div className="doc-home-grid">
              {recent.map((page) => (
                <button
                  type="button"
                  key={page.id}
                  className="doc-home-card"
                  onClick={() => onOpen(page.id)}
                >
                  <PageIcon page={page} />
                  <b>{page.title || t('无标题')}</b>
                  <small>
                    {pathTo(pages, page.id)
                      .slice(0, -1)
                      .map((item) => item.title || t('无标题'))
                      .join(' / ')}
                  </small>
                  <small>{when(page.updatedAt)}</small>
                </button>
              ))}
            </div>
          </>
        ) : (
          <p className="doc-home-empty">{t('还没有文档。新建一页，或从模板开始。')}</p>
        )}
        {marked.length ? (
          <>
            <h2>{t('收藏')}</h2>
            <div className="doc-home-list">
              {marked.map((page) => (
                <button type="button" key={page.id} onClick={() => onOpen(page.id)}>
                  <PageIcon page={page} />
                  <span>{page.title || t('无标题')}</span>
                  <small>{when(page.updatedAt)}</small>
                </button>
              ))}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

function DocPage({
  runtime,
  id,
  project,
  library,
  readOnly,
  onOpenPage,
  onContext,
  onTool,
  onDialog,
  onAction,
  onExport,
  onError,
  onNotice,
  wordExport,
  compact = false,
}: {
  onError(message: string): void;
  onNotice(message: string): void;
  /** Whether pages can be saved as Word documents here (the app, not the browser preview). */
  wordExport: boolean;
  runtime: DocsRuntime;
  id: string;
  project: Project;
  library: LibraryBackend;
  readOnly: boolean;
  onOpenPage(id: string | null): void;
  onContext(context: WorkContext): void;
  onTool(tool: 'assistant' | 'notes'): void;
  onDialog(dialog: Dialog | null): void;
  onAction(kind: PageAction, page: PageSummary): void;
  onExport(id: string): void;
  /** The narrow page of the right-hand panel. */
  compact?: boolean;
}) {
  const open = useDocs(runtime, (state) => state.open[id]);
  const pages = useDocs(runtime, (state) => state.pages);
  const starred = useDocs(runtime, (state) => state.starred.includes(id));
  const cloud = useCloud();
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const selection = useRef('');
  useEffect(() => {
    void runtime.open(id);
    return () => void runtime.save(id);
  }, [id, runtime]);
  const me = cloud.state?.userId ?? null;
  const members = cloud.members[project.id];
  const userLabel = useCallback(
    (user: string) => {
      if (!user) return '';
      if (user === me) return t('我');
      const member = members?.find((item) => item.id === user);
      return member ? t('尾号 {digits}', { digits: member.phone.slice(-4) }) : '';
    },
    [me, members],
  );
  const images = useMemo(() => noteImages(project.id), [project.id]);
  const imageCache = useRef(new Map<string, Promise<string>>());
  const env: DocEnv = useMemo(
    () => ({
      projectId: project.id,
      pageId: id,
      pages,
      readOnly,
      openPage: (target) => onOpenPage(target),
      openPaper: (path) =>
        void library
          .open(project.id, path)
          .then((paper) =>
            window.dispatchEvent(
              new CustomEvent('scientify-open-source', {
                detail: {
                  projectId: project.id,
                  workspace: 'literature',
                  resourceId: paper.id,
                  title: path,
                  paperPath: path,
                },
              }),
            ),
          )
          .catch(() => {}),
      openFile: (path) =>
        window.dispatchEvent(
          new CustomEvent('scientify-open-source', {
            detail: { projectId: project.id, workspace: 'experiments', path, title: path },
          }),
        ),
      loadImage: (asset) => {
        let cached = imageCache.current.get(asset);
        if (!cached) imageCache.current.set(asset, (cached = images.read(asset)));
        return cached;
      },
      saveImage: (file) => images.save(file),
      attachFiles: (files) => Promise.all(files.map((file) => saveAttachment(project.id, file))),
      pickAttachments: () => pickAttachments(project.id),
      openUrl: (url) => {
        const target = parseBlockLink(url);
        if (target) return openDocTarget(target, { projectId: project.id, pageId: id });
        window.dispatchEvent(
          new CustomEvent('scientify-preview-url', { detail: { projectId: project.id, url } }),
        );
      },
      notify: onNotice,
      previewLink: (url) => linkPreview(url),
      importLink: async (url) => {
        const imported = await linkImport(url);
        const parsed = markdownToPage(imported.markdown);
        const page = await runtime.create({
          parent: id,
          title: imported.title || parsed.title || url,
          blocks: parsed.blocks.length ? parsed.blocks : undefined,
        });
        if (page) onOpenPage(page.id);
      },
      openAttachment: (asset) =>
        void locateAttachment(project.id, asset)
          .then((located) =>
            window.dispatchEvent(
              new CustomEvent('scientify-preview-file', {
                detail: { projectId: project.id, ...located },
              }),
            ),
          )
          .catch((reason) => onError(errorMessage(reason))),
      paperNote: async (path) => {
        const paper = await library.open(project.id, path);
        return (await library.note(project.id, paper.id)).content;
      },
      pick: (kind) => new Promise((resolve) => onDialog({ kind: 'pick', pick: kind, resolve })),
      createSubpage: async () => runtime.create({ parent: id }),
      userLabel,
      members: () =>
        (members ?? [])
          .filter((member) => !member.pending)
          .map((member) => ({
            id: member.id,
            label:
              member.id === me ? t('我') : t('尾号 {digits}', { digits: member.phone.slice(-4) }),
          })),
    }),
    [
      id,
      images,
      library,
      me,
      members,
      onDialog,
      onError,
      onNotice,
      onOpenPage,
      pages,
      project.id,
      readOnly,
      runtime,
      userLabel,
    ],
  );

  const page = open?.page;
  const publish = useRef(onContext);
  publish.current = onContext;
  const describe = useCallback(
    (text = selection.current) => {
      if (!page) return;
      publish.current({
        projectId: project.id,
        workspace: 'notes',
        resourceId: page.id,
        title: page.title || t('无标题'),
        text: pageToMarkdown(page.title, page.blocks).slice(0, 12000),
        ...(text ? { selection: text } : {}),
      });
    },
    [page, project.id],
  );
  useEffect(() => {
    const timer = setTimeout(() => describe(), 400);
    return () => clearTimeout(timer);
  }, [describe]);
  // A link to one of this page's blocks brings it into view once the page is shown.
  const shown = !!page;
  useEffect(() => {
    const block = shown ? takePendingBlock(id) : null;
    if (!block) return;
    const frame = requestAnimationFrame(() => revealBlock(block));
    return () => cancelAnimationFrame(frame);
  }, [id, shown]);

  if (!open || !page) return <div className="doc-scroll" />;
  const summary = pages.find((item) => item.id === id);
  const crumbs = pathTo(pages, id);
  const headings = page.blocks.filter(
    (block) => block.type === 'heading' && blockText(block).trim(),
  );
  const status = open.error
    ? open.error
    : open.saving
      ? t('正在保存…')
      : open.dirty
        ? t('未保存')
        : [userLabel(page.updatedBy ?? ''), when(page.updatedAt)].filter(Boolean).join(' · ');
  return (
    <div
      className={`doc-page${compact ? ' is-compact' : ''}${page.cover ? ' has-cover' : ''}`}
      data-width={page.width ?? 'standard'}
    >
      <header className="doc-top">
        {compact ? (
          <Button
            variant="ghost"
            iconOnly
            aria-label={t('返回页面列表')}
            onClick={() => onOpenPage(null)}
          >
            <ArrowLeft size={15} />
          </Button>
        ) : null}
        <nav className="doc-crumbs" aria-label={t('页面路径')}>
          {(compact ? crumbs.slice(-1) : crumbs).map((item, i) => (
            <span key={item.id}>
              {i ? <span className="doc-crumb-sep">/</span> : null}
              <button
                type="button"
                onClick={() => onOpenPage(item.id)}
                aria-current={item.id === id ? 'page' : undefined}
              >
                {i < crumbs.length - 1 && item.icon ? `${item.icon} ` : ''}
                {item.title || t('无标题')}
              </button>
            </span>
          ))}
        </nav>
        <span className="spacer" />
        <span className={`doc-status${open.error ? ' is-error' : ''}`}>{status}</span>
        <Button
          variant="ghost"
          iconOnly
          aria-label={starred ? t('取消收藏') : t('收藏')}
          aria-pressed={starred}
          onClick={() => runtime.star(id)}
        >
          <Star size={15} />
        </Button>
        <Button
          variant="ghost"
          iconOnly
          aria-label={t('更多')}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            setMenu({ x: rect.right - 220, y: rect.bottom + 4, trigger: event.currentTarget });
          }}
        >
          <MoreHorizontal size={15} />
        </Button>
      </header>
      <div className="doc-scroll">
        {page.cover ? (
          <PageCover
            cover={page.cover}
            readOnly={readOnly}
            loadImage={env.loadImage}
            saveImage={env.saveImage}
            onChange={(cover) => runtime.edit(id, { cover })}
          />
        ) : null}
        <article className="doc-column">
          <div className="doc-head">
            {readOnly || (page.icon && page.cover) ? null : (
              <div className="doc-head-actions">
                {page.icon ? null : (
                  <button
                    type="button"
                    className="doc-add-icon"
                    onClick={() => summary && onDialog({ kind: 'icon', page: summary })}
                  >
                    <Smile size={14} />
                    {t('添加图标')}
                  </button>
                )}
                {page.cover ? null : (
                  <button
                    type="button"
                    className="doc-add-icon"
                    onClick={() => runtime.edit(id, { cover: defaultCover() })}
                  >
                    <ImageIcon size={14} />
                    {t('添加封面')}
                  </button>
                )}
              </div>
            )}
            {page.icon ? (
              <button
                type="button"
                className="doc-icon"
                disabled={readOnly}
                aria-label={t('更换图标')}
                onClick={() => summary && onDialog({ kind: 'icon', page: summary })}
              >
                {page.icon}
              </button>
            ) : null}
            <textarea
              className="doc-title"
              rows={1}
              value={page.title}
              readOnly={readOnly}
              placeholder={t('无标题')}
              aria-label={t('页面标题')}
              onChange={(event) =>
                runtime.edit(id, { title: event.target.value.replace(/\n/g, '') })
              }
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  (
                    document.querySelector('.doc-editor .ProseMirror') as HTMLElement | null
                  )?.focus();
                }
              }}
              ref={(element) => {
                if (element) {
                  element.style.height = 'auto';
                  element.style.height = `${element.scrollHeight}px`;
                }
              }}
            />
          </div>
          {!readOnly && emptyPage(page.blocks) ? (
            <div className="doc-template-row">
              {TEMPLATES.filter((item) => item.id !== 'blank').map((item) => (
                <button
                  type="button"
                  key={item.id}
                  onClick={() =>
                    runtime.edit(
                      id,
                      {
                        blocks: templateBlocks(item.id),
                        ...(page.title ? {} : { title: t(item.label) }),
                        ...(page.icon ? {} : { icon: item.icon }),
                      },
                      true,
                    )
                  }
                >
                  {item.icon} {t(item.label)}
                </button>
              ))}
            </div>
          ) : null}
          <DocEditor
            blocks={page.blocks}
            revision={open.revision}
            readOnly={readOnly}
            env={env}
            onChange={(blocks) => runtime.edit(id, { blocks })}
            onSelection={(text) => {
              selection.current = text;
            }}
            onAsk={(text) => {
              selection.current = text;
              describe(text);
              onTool('assistant');
            }}
          />
        </article>
        {headings.length > 1 && !compact ? (
          <nav className="doc-outline" aria-label={t('目录')}>
            {headings.map((block) => (
              <button
                type="button"
                key={block.id}
                data-level={String(block.props?.level ?? 2)}
                onClick={() =>
                  document
                    .querySelector(`.doc-editor [data-id="${CSS.escape(block.id)}"]`)
                    ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                }
              >
                {blockText(block)}
              </button>
            ))}
          </nav>
        ) : null}
      </div>
      <Menu anchor={menu} label={t('页面菜单')} onClose={() => setMenu(null)}>
        {summary ? (
          <>
            {readOnly ? null : (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenu(null);
                  runtime.edit(id, { width: page.width === 'wide' ? 'standard' : 'wide' });
                }}
              >
                <MoveHorizontal size={14} />
                {page.width === 'wide' ? t('标准宽度') : t('全宽')}
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              onClick={() => (setMenu(null), onDialog({ kind: 'history', page: summary }))}
            >
              <History size={14} />
              {t('历史记录')}
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenu(null);
                void navigator.clipboard
                  .writeText(blockLink({ projectId: project.id, pageId: id }))
                  .then(() => onNotice(t('已复制链接')));
              }}
            >
              <Link2 size={14} />
              {t('复制链接')}
            </button>
            <div role="separator" className="sf-menu-separator" />
            <button type="button" role="menuitem" onClick={() => (setMenu(null), onExport(id))}>
              <Download size={14} />
              {t('导出 Markdown')}
            </button>
            {wordExport ? (
              <button
                type="button"
                role="menuitem"
                onClick={() => summary && (setMenu(null), onAction('exportWord', summary))}
              >
                <FileText size={14} />
                {t('导出 Word')}
              </button>
            ) : null}
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenu(null);
                requestAnimationFrame(() => window.print());
              }}
            >
              <FileDown size={14} />
              {t('导出 PDF')}
            </button>
            {readOnly ? null : (
              <>
                <div role="separator" className="sf-menu-separator" />
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => (setMenu(null), onAction('move', summary))}
                >
                  <FolderInput size={14} />
                  {t('移动到…')}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => (setMenu(null), onAction('duplicate', summary))}
                >
                  <Copy size={14} />
                  {t('创建副本')}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="sf-menu-danger"
                  onClick={async () => {
                    setMenu(null);
                    if (
                      await confirmAction(
                        t('把“{title}”和它的子页面移到回收站？', {
                          title: page.title || t('无标题'),
                        }),
                      )
                    )
                      onAction('delete', summary);
                  }}
                >
                  <Trash2 size={14} />
                  {t('删除')}
                </button>
              </>
            )}
          </>
        ) : null}
      </Menu>
    </div>
  );
}
