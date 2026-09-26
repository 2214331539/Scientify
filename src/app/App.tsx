import { t, translateError } from '../i18n';
import { Button } from '../components/primitives';
import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { useStore } from 'zustand';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { openProjectWindow } from '../platform/windows';
import { applyAppearance, migrateTheme, usePreferences } from '../i18n/preferences';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { X } from 'lucide-react';
import { AppShell, WORKSPACE_RAIL_WIDTH } from '../components/layout/AppShell';
import { StatusBarTools } from '../components/layout/StatusBarTools';
import { TopBar } from '../components/layout/TopBar';
import { BrandMark } from '../components/layout/BrandMark';
import { WorkspaceRail } from '../components/navigation/WorkspaceRail';
import { workspaceItems, secondaryViews as secondary } from '../components/navigation/workspaces';
import { WorkspaceFrame } from '../components/workspace/WorkspaceFrame';
import type { ResumeTarget } from '../workspaces/overview/home-model';
import { ProjectForm, TeamForm } from '../features/projects/ProjectForm';
import { ProjectLibrary } from '../features/projects/ProjectLibrary';
import { ProjectSidebar } from '../features/projects/ProjectSidebar';
import { WindowControls } from '../components/layout/WindowControls';
import { SettingsDialog } from '../features/settings/Settings';
import { SearchDialog, type SearchTarget } from '../features/search/SearchDialog';
import { Overview } from '../workspaces/overview/Overview';
import { LiteratureWorkspace } from '../workspaces/literature/LiteratureWorkspace';
import type { LiteratureSession } from '../workspaces/literature/tabs';
import { LocalLiterature } from '../workspaces/literature/LocalLiterature';
import { nativeLibrary, noteFiles } from '../platform/library';
import { flushPaperNotes, notesDirty, notesPending } from '../workspaces/literature/local-session';
import { browserLayout } from '../platform/browser-pane';
import { FileResources, FileWorkspace } from '../workspaces/files/FileWorkspace';
import { RunWorkspace } from '../workspaces/experiments/RunWorkspace';
import { GlobalDock } from '../shell/GlobalDock';
import { ResizeHandle } from '../shell/ResizeHandle';
import {
  getFileRuntime,
  hasPendingFileOperations,
  hasUnsavedFileChanges,
  invalidateProjectFileSessions,
  notifyFileRuntime,
} from '../editor/sessions';
import { Modal } from '../components/Modal';
import type { Project, Team } from '../domain/workspace';
import type { WorkContext, WorkspaceId } from '../domain/context';
import { workspaceStore, type WorkspaceStore } from '../stores/workspace';
import { nativeResearch, type ResearchBackend } from '../platform/research';

type Dialog =
  | { kind: 'project'; project?: Project }
  | { kind: 'team'; team?: Team }
  | { kind: 'data' | 'profile' | 'search' | 'about' }
  | null;
type Location = {
  legacyLiterature?: boolean;
  literatureSession?: LiteratureSession;
  workspace: WorkspaceId;
  view: string;
  paperId: string | null;
  runId?: string | null;
  paths: Partial<Record<WorkspaceId, string | null>>;
  views?: Partial<Record<WorkspaceId, string>>;
};
type UISession = {
  version: 2;
  projectId: string | null;
  space: string;
  locations: Record<string, Location>;
  dock: 'assistant' | 'notes';
  dockOpen: boolean;
  leftWidth: number;
  rightWidth: number;
};
const defaults: UISession = {
  version: 2,
  projectId: null,
  space: 'personal',
  locations: {},
  dock: 'assistant',
  dockOpen: false,
  leftWidth: 240,
  rightWidth: 340,
};
const locationDefault: Location = { workspace: 'overview', view: '', paperId: null, paths: {} };
function readSession(storageKey = 'scientify.ui.v2'): UISession {
  try {
    const value = JSON.parse(
      localStorage.getItem(storageKey) ??
        localStorage.getItem('scientify.ui.v2') ??
        localStorage.getItem('scientify.ui.v1') ??
        'null',
    );
    if ([1, 2].includes(value?.version) && value.locations && typeof value.locations === 'object')
      return {
        ...defaults,
        ...value,
        version: 2,
        locations: Object.fromEntries(
          Object.entries(value.locations)
            .filter(([, entry]) => entry && typeof entry === 'object')
            .map(([id, entry]) => {
              const location = entry as Location;
              return [
                id,
                {
                  ...location,
                  paths: location.paths ?? {},
                  views: { ...location.views, [location.workspace]: location.view },
                },
              ];
            }),
        ),
        dockOpen: value.dock === 'notes' && value.dockOpen === true,
        leftWidth: Math.max(180, Math.min(300, Number(value.leftWidth) || 240)),
        rightWidth: Math.max(300, Math.min(480, Number(value.rightWidth) || 340)),
      };
  } catch {
    /* UI preferences are optional. */
  }
  return structuredClone(defaults);
}

function useCloseProtection(store: WorkspaceStore, backend: ResearchBackend, returning = false) {
  useEffect(() => {
    const runtime = getFileRuntime(noteFiles(nativeLibrary));
    const sync = () =>
      store.getState().setDirtySource('paper-notes', notesDirty() || notesPending());
    runtime.listeners.add(sync);
    sync();
    return () => {
      runtime.listeners.delete(sync);
    };
  }, [store]);
  useEffect(() => {
    const runtime = getFileRuntime(backend);
    const update = () =>
      store
        .getState()
        .setDirtySource(
          'files',
          hasUnsavedFileChanges(backend) || hasPendingFileOperations(backend),
        );
    runtime.listeners.add(update);
    update();
    const unsubscribe = store.subscribe((next, previous) => {
      if (next.data === previous.data) return;
      for (const project of next.data?.projects ?? []) {
        const old = previous.data?.projects.find((value) => value.id === project.id);
        if (old && (old.path ?? '') !== (project.path ?? ''))
          invalidateProjectFileSessions(backend, project.id);
      }
    });
    return () => {
      runtime.listeners.delete(update);
      unsubscribe();
    };
  }, [store, backend]);
  useEffect(() => {
    function beforeUnload(event: BeforeUnloadEvent) {
      if (store.getState().dirty || store.getState().busy || hasPendingFileOperations(backend)) {
        event.preventDefault();
        event.returnValue = '';
      }
    }
    window.addEventListener('beforeunload', beforeUnload);
    let disposed = false;
    let cleanup: (() => void) | undefined;
    if (isTauri())
      void getCurrentWindow()
        .onCloseRequested(async (event) => {
          event.preventDefault();
          const { busy } = store.getState();
          if (busy || hasPendingFileOperations(backend)) return;
          if (!(await flushPaperNotes())) {
            store.setState({ error: t('论文笔记尚未保存，请重试或处理冲突后退出。') });
            return;
          }
          if (
            !store.getState().dirty ||
            window.confirm(
              returning
                ? t('仍有未保存的内容。确认放弃这些修改并返回项目管理？')
                : t('仍有未保存的内容。确认放弃这些修改并退出？'),
            )
          )
            await getCurrentWindow().destroy();
        })
        .then((unlisten) => {
          if (disposed) unlisten();
          else cleanup = unlisten;
        });
    return () => {
      disposed = true;
      cleanup?.();
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, [store, backend, returning]);
}

export function App({
  store = workspaceStore,
  backend = nativeResearch,
  preview = false,
  windowMode = 'browser',
}: {
  store?: WorkspaceStore;
  backend?: ResearchBackend;
  preview?: boolean;
  windowMode?: 'projects' | 'workspace' | 'browser';
}) {
  const preferences = usePreferences();
  const epoch = useStore(store, (s) => s.epoch);
  const data = useStore(store, (s) => s.data),
    phase = useStore(store, (s) => s.phase),
    busy = useStore(store, (s) => s.busy),
    dirty = useStore(store, (s) => s.dirty),
    error = useStore(store, (s) => s.error);
  const sessionKey = windowMode === 'browser' ? 'scientify.ui.v2' : `scientify.ui.v2.${windowMode}`;
  const [ui, setUI] = useState(() => {
      const saved = readSession(sessionKey);
      if (windowMode === 'projects') return { ...saved, projectId: null, dockOpen: false };
      if (windowMode === 'workspace')
        return {
          ...saved,
          projectId: new URLSearchParams(window.location.search).get('project'),
          dockOpen: false,
        };
      return saved;
    }),
    [dialog, setDialog] = useState<Dialog>(null),
    [sidebarExpanded, setSidebarExpanded] = useState(true),
    [windowWidth, setWindowWidth] = useState(window.innerWidth);
  const [context, setContext] = useState<WorkContext>({
    workspace: 'projects',
    title: t('项目管理'),
  });
  const [pendingNote, setPendingNote] = useState<{ scope: string; id: string } | null>(null);
  const [launching, setLaunching] = useState(false);
  useCloseProtection(store, backend, windowMode === 'workspace');
  useEffect(() => {
    if (!epoch || store.getState().dirty) return;
    const runtime = getFileRuntime(backend);
    runtime.sessions.clear();
    runtime.tabs.clear();
    runtime.active.clear();
    notifyFileRuntime(backend);
  }, [epoch, backend, store]);
  useEffect(() => {
    void store.getState().load();
  }, [store]);
  useEffect(() => {
    try {
      localStorage.setItem(sessionKey, JSON.stringify(ui));
    } catch {
      /* Layout persistence must not block work. */
    }
  }, [ui, sessionKey]);
  useEffect(() => {
    if (windowMode !== 'projects') return;
    const subscription = listen('projects-refresh', () => {
      setLaunching(false);
      store.setState({ busy: false });
      void store.getState().load();
    });
    return () => {
      void subscription.then((stop) => stop());
    };
  }, [windowMode, store]);
  useEffect(() => {
    if (windowMode !== 'workspace' || !['ready', 'error'].includes(phase)) return;
    void invoke('workspace_window_ready').catch((error: unknown) =>
      store.setState({ error: String(error) }),
    );
  }, [windowMode, phase, store]);
  useEffect(() => {
    const onResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  useLayoutEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const apply = () => applyAppearance(preferences, media.matches);
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [preferences]);
  useEffect(() => {
    if (!isTauri() || windowMode === 'browser') return;
    void getCurrentWindow()
      .setTitle(`Scientify · ${t(windowMode === 'projects' ? 'Projects' : 'Workspace')}`)
      .catch(() => {});
  }, [preferences.language, windowMode]);
  useEffect(() => {
    if (data) migrateTheme(data.settings.theme);
  }, [data]);
  useEffect(() => {
    if (!data) return;
    setUI((s) => {
      const invalidProject = s.projectId && !data.projects.some((p) => p.id === s.projectId);
      const invalidSpace =
        !['personal', '__teams__'].includes(s.space) && !data.teams.some((t) => t.id === s.space);
      return invalidProject || invalidSpace
        ? {
            ...s,
            projectId: invalidProject ? null : s.projectId,
            space: invalidSpace ? 'personal' : s.space,
          }
        : s;
    });
  }, [data]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (!document.querySelector('dialog[open]')) setDialog({ kind: 'search' });
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  const project = data?.projects.find((p) => p.id === ui.projectId);
  const location = project ? (ui.locations[project.id] ?? locationDefault) : locationDefault;
  const workspace = workspaceItems.some((w) => w.id === location.workspace)
    ? location.workspace
    : 'overview';
  const view = secondary[workspace].some((v) => v.id === location.view)
    ? location.view
    : (secondary[workspace][0]?.id ?? '');
  const effectiveContext: WorkContext =
    context.projectId === project?.id && context.workspace === (project ? workspace : 'projects')
      ? context
      : {
          projectId: project?.id,
          workspace: project ? workspace : 'projects',
          title: project?.name ?? t('项目管理'),
          text: project?.question,
        };
  const receiveContext = useCallback((next: WorkContext) => setContext(next), []);
  const patchLocation = useCallback((patch: Partial<Location>) => {
    setUI((s) => {
      if (!s.projectId) return s;
      return {
        ...s,
        locations: {
          ...s.locations,
          [s.projectId]: {
            ...(s.locations[s.projectId] ?? locationDefault),
            ...patch,
            ...(patch.view !== undefined
              ? {
                  views: {
                    ...s.locations[s.projectId]?.views,
                    [patch.workspace ?? s.locations[s.projectId]?.workspace ?? 'overview']:
                      patch.view,
                  },
                }
              : {}),
          },
        },
      };
    });
  }, []);
  const openTool = useCallback(
    (tool: 'assistant' | 'notes') => setUI((s) => ({ ...s, dock: tool, dockOpen: true })),
    [],
  );
  function toggleTool(tool: 'assistant' | 'notes') {
    if (tool === 'notes' && workspace === 'notes') return;
    setUI((s) => ({ ...s, dock: tool, dockOpen: s.dock !== tool || !s.dockOpen }));
  }
  function openProject(id: string) {
    if (windowMode === 'projects') {
      void launchWorkspace(id);
      return;
    }
    const p = data?.projects.find((p) => p.id === id);
    if (p) {
      setUI((s) => ({ ...s, projectId: id, space: p.space }));
      setSidebarExpanded(true);
    }
  }
  async function launchWorkspace(id: string, target?: SearchTarget | { source: WorkContext }) {
    if (launching) return;
    if (store.getState().dirty || store.getState().busy) {
      store.setState({ error: t('请先保存当前修改，并等待操作完成后再打开项目。') });
      return;
    }
    setLaunching(true);
    store.setState({ busy: true });
    try {
      await openProjectWindow(id, target);
    } catch (error) {
      setLaunching(false);
      store.setState({ busy: false });
      store.setState({ error: error instanceof Error ? error.message : String(error) });
    }
  }
  function returnToProjects() {
    if (windowMode === 'workspace') void getCurrentWindow().close();
    else setUI((s) => ({ ...s, projectId: null }));
  }
  function navigate(id: WorkspaceId) {
    patchLocation({ workspace: id, view: location.views?.[id] ?? secondary[id][0]?.id ?? '' });
    setSidebarExpanded(true);
  }
  const openFile = useCallback((path: string | null) => {
    setUI((s) => {
      if (!s.projectId) return s;
      const previous = s.locations[s.projectId] ?? locationDefault;
      return {
        ...s,
        locations: {
          ...s.locations,
          [s.projectId]: {
            ...previous,
            view: 'files',
            views: { ...previous.views, [previous.workspace]: 'files' },
            paths: { ...previous.paths, [previous.workspace]: path },
          },
        },
      };
    });
  }, []);
  function goToTarget(target: SearchTarget) {
    if (windowMode === 'workspace' && !target.projectId) {
      returnToProjects();
      return;
    }
    if (windowMode === 'projects' && target.projectId) {
      setDialog(null);
      void launchWorkspace(target.projectId, target);
      return;
    }
    setDialog(null);
    setUI((s) => ({
      ...s,
      projectId: target.projectId ?? null,
      space: data?.projects.find((p) => p.id === target.projectId)?.space ?? s.space,
      ...(target.projectId
        ? {
            locations: {
              ...s.locations,
              [target.projectId]: {
                ...(s.locations[target.projectId] ?? locationDefault),
                workspace: target.workspace === 'projects' ? 'overview' : target.workspace,
                view: target.workspace === 'literature' ? 'local' : '',
                views: {
                  ...s.locations[target.projectId]?.views,
                  [target.workspace === 'projects' ? 'overview' : target.workspace]:
                    target.workspace === 'literature' ? 'local' : '',
                },
                paperId: target.workspace === 'literature' ? (target.resourceId ?? null) : null,
                legacyLiterature: target.workspace === 'literature' && !!target.resourceId,
              },
            },
          }
        : {}),
      ...(target.tool ? { dock: target.tool, dockOpen: true } : {}),
    }));
    if (target.tool === 'notes' && target.resourceId)
      setPendingNote({ scope: target.projectId ?? '__inbox__', id: target.resourceId });
  }
  useEffect(() => {
    if (windowMode !== 'workspace' || phase !== 'ready') return;
    const params = new URLSearchParams(window.location.search);
    const raw = params.get('target');
    if (!raw) return;
    params.delete('target');
    window.history.replaceState(null, '', `${window.location.pathname}?${params}`);
    try {
      const parsed = JSON.parse(raw) as SearchTarget & { source?: WorkContext };
      if (parsed.source) {
        requestAnimationFrame(() =>
          window.dispatchEvent(new CustomEvent('scientify-open-source', { detail: parsed.source })),
        );
        return;
      }
      const target = parsed;
      if (
        target.projectId &&
        store.getState().data?.projects.some((p) => p.id === target.projectId)
      )
        goToTarget(target);
    } catch {
      /* Optional deep link; the project overview remains available. */
    }
  }, [windowMode, phase]);
  useEffect(() => {
    if (!pendingNote) return;
    const frame = requestAnimationFrame(() => {
      window.dispatchEvent(new CustomEvent('scientify-open-note', { detail: pendingNote }));
      setPendingNote(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [pendingNote, ui.projectId]);
  useEffect(() => {
    const open = (event: Event) => {
      const source = (event as CustomEvent<WorkContext>).detail;
      if (!source?.projectId || !data?.projects.some((p) => p.id === source.projectId)) return;
      if (windowMode === 'projects') {
        void launchWorkspace(source.projectId, {
          source: {
            projectId: source.projectId,
            workspace: source.workspace,
            resourceId: source.resourceId,
            path: source.path,
            page: source.page,
            title: source.title.slice(0, 160),
          },
        });
        return;
      }
      const w = source.workspace === 'projects' ? 'overview' : source.workspace;
      const run =
        w === 'experiments' && !source.path
          ? data.runs.find(
              (item) => item.project === source.projectId && item.id === source.resourceId,
            )
          : undefined;
      setUI((s) => ({
        ...s,
        projectId: source.projectId!,
        space: data.projects.find((p) => p.id === source.projectId)?.space ?? s.space,
        locations: {
          ...s.locations,
          [source.projectId!]: {
            ...(s.locations[source.projectId!] ?? locationDefault),
            workspace: w,
            view: run ? 'runs' : w === 'literature' ? 'local' : w === 'notes' ? '' : 'files',
            views: {
              ...s.locations[source.projectId!]?.views,
              [w]: run ? 'runs' : w === 'literature' ? 'local' : w === 'notes' ? '' : 'files',
            },
            ...(run ? { runId: run.id } : {}),
            paperId: w === 'literature' ? (source.resourceId ?? null) : null,
            legacyLiterature:
              w === 'literature' && data.papers.some((p) => p.id === source.resourceId),
            paths: run
              ? (s.locations[source.projectId!]?.paths ?? {})
              : { ...(s.locations[source.projectId!]?.paths ?? {}), [w]: source.path ?? null },
          },
        },
      }));
      if (w === 'notes' && source.resourceId)
        setPendingNote({ scope: source.projectId, id: source.resourceId });
      if (source.page && source.resourceId) {
        const paper = data.papers.find((p) => p.id === source.resourceId);
        if (typeof paper?.assetId === 'string' || w === 'literature')
          try {
            localStorage.setItem(
              `scientify.reader.${paper?.assetId ?? source.resourceId}`,
              String(source.page),
            );
            requestAnimationFrame(() =>
              window.dispatchEvent(
                new CustomEvent('scientify-pdf-page', {
                  detail: { paperId: source.resourceId, page: source.page },
                }),
              ),
            );
          } catch {
            /* Optional reading position. */
          }
      }
    };
    window.addEventListener('scientify-open-source', open);
    return () => window.removeEventListener('scientify-open-source', open);
  }, [data, windowMode]);
  function openDialog(next: Dialog) {
    store.getState().clearMessage();
    if (isTauri() && windowMode !== 'browser')
      void browserLayout({ op: 'hideAll' })
        .catch(() => {})
        .then(() => setDialog(next));
    else setDialog(next);
  }
  const ready = phase === 'ready' && data;
  const workspaceLabel = project
    ? (workspaceItems.find((item) => item.id === workspace)?.label ?? t('Workspace'))
    : t('项目管理');
  function resume(target: ResumeTarget) {
    if (target.noteId) {
      patchLocation({ workspace: 'notes', view: '' });
      setPendingNote({ scope: project!.id, id: target.noteId });
      return;
    }
    patchLocation({
      workspace: target.workspace,
      view: target.runId ? 'runs' : target.workspace === 'literature' ? 'local' : 'files',
      ...(target.paperId ? { paperId: target.paperId, legacyLiterature: true } : {}),
      ...(target.runId ? { runId: target.runId } : {}),
      ...(target.path ? { paths: { ...location.paths, [target.workspace]: target.path } } : {}),
    });
  }
  const notesWorkspace = !!ready && !!project && workspace === 'notes';
  const sidebar =
    project &&
    (workspace === 'files' ||
      workspace === 'writing' ||
      (workspace === 'experiments' && view !== 'runs')) ? (
      <FileResources
        project={project}
        backend={backend}
        mode={workspace === 'writing' ? 'writing' : workspace === 'files' ? 'files' : 'experiments'}
        view={view}
        activePath={location.paths?.[workspace]}
        onOpen={openFile}
      />
    ) : undefined;
  const inlineDockOpen =
    ui.dockOpen && windowWidth > 900 && (!notesWorkspace || ui.dock === 'assistant');
  const rightWidth = Math.min(
    ui.rightWidth,
    Math.max(
      300,
      windowWidth -
        WORKSPACE_RAIL_WIDTH -
        (workspace === 'literature' || (sidebar && sidebarExpanded) ? 180 : 0) -
        382,
    ),
  );
  const maxResourceWidth = Math.max(
    180,
    Math.min(300, windowWidth - WORKSPACE_RAIL_WIDTH - (inlineDockOpen ? rightWidth : 0) - 382),
  );
  const resourceWidth = Math.min(ui.leftWidth, maxResourceWidth);
  const content = !ready ? (
    <div className="empty-state full">
      <BrandMark />
      {phase === 'error' ? (
        <>
          <h2>{t('工作区未能载入')}</h2>
          <p role="alert">{translateError(error)}</p>
          <Button onClick={() => void store.getState().load()}>{t('重新载入')}</Button>
          <Button onClick={() => openDialog({ kind: 'data' })}>{t('数据与备份')}</Button>
        </>
      ) : (
        <p>{t('正在打开工作区…')}</p>
      )}
    </div>
  ) : !project ? (
    <ProjectLibrary
      store={store}
      space={ui.space}
      onOpen={openProject}
      onNew={() => openDialog({ kind: 'project' })}
      onEdit={(p) => openDialog({ kind: 'project', project: p })}
      onSpace={(space) => setUI((s) => ({ ...s, space }))}
      onNewTeam={() => openDialog({ kind: 'team' })}
      onEditTeam={(team) => openDialog({ kind: 'team', team })}
    />
  ) : workspace === 'overview' ? (
    <Overview
      key={project.id}
      project={project}
      store={store}
      onNavigate={navigate}
      onResume={resume}
      lastPaths={location.paths}
      lastPaperId={location.paperId}
      onEdit={() => openDialog({ kind: 'project', project })}
      onNotes={(id) => {
        navigate('notes');
        if (id) setPendingNote({ scope: project.id, id });
      }}
    />
  ) : workspace === 'literature' && windowMode !== 'browser' && !location.legacyLiterature ? (
    <LocalLiterature
      key={project.id}
      project={project}
      store={store}
      backend={backend}
      requestedPaper={location.paperId}
      view={view}
      onView={(view) => patchLocation({ view })}
      width={resourceWidth}
      resize={
        <ResizeHandle
          value={resourceWidth}
          min={180}
          max={maxResourceWidth}
          side="left"
          label={t('调整资源宽度')}
          onChange={(leftWidth) => setUI((s) => ({ ...s, leftWidth }))}
        />
      }
      onContext={receiveContext}
      onLegacy={() => patchLocation({ legacyLiterature: true })}
    />
  ) : workspace === 'literature' ? (
    <div className="legacy-literature-view">
      {windowMode !== 'browser' && (
        <Button variant="ghost" onClick={() => patchLocation({ legacyLiterature: false })}>
          {t('返回本地目录')}
        </Button>
      )}
      <LiteratureWorkspace
        key={project.id}
        project={project}
        store={store}
        backend={backend}
        view={view}
        onView={(view) => patchLocation({ view })}
        selectedPaper={location.paperId}
        session={location.literatureSession}
        onSessionChange={(literatureSession) =>
          patchLocation({
            literatureSession,
            paperId:
              literatureSession.tabs.find((tab) => tab.id === literatureSession.activeId)
                ?.paperId ?? null,
          })
        }
        width={resourceWidth}
        resize={
          <ResizeHandle
            value={resourceWidth}
            min={180}
            max={maxResourceWidth}
            side="left"
            label={t('调整资源宽度')}
            onChange={(leftWidth) => setUI((s) => ({ ...s, leftWidth }))}
          />
        }
        onContext={receiveContext}
        onTool={openTool}
      />
    </div>
  ) : workspace === 'notes' ? null : (
    <WorkspaceFrame
      label={t(workspaceLabel)}
      views={secondary[workspace]}
      view={view}
      onView={(view) => patchLocation({ view })}
      sidebar={sidebar}
      sidebarOpen={sidebarExpanded}
      onSidebarToggle={() => setSidebarExpanded((v) => !v)}
      width={resourceWidth}
      resize={
        <ResizeHandle
          value={resourceWidth}
          min={180}
          max={maxResourceWidth}
          side="left"
          label={t('调整资源宽度')}
          onChange={(leftWidth) => setUI((s) => ({ ...s, leftWidth }))}
        />
      }
    >
      {workspace === 'experiments' && view === 'runs' ? (
        <RunWorkspace
          key={project.id}
          project={project}
          store={store}
          onContext={receiveContext}
          selectedRunId={location.runId}
          onSelect={(runId) => patchLocation({ runId })}
        />
      ) : (
        <FileWorkspace
          key={`${project.id}:${workspace}`}
          project={project}
          store={store}
          backend={backend}
          mode={
            workspace === 'writing' ? 'writing' : workspace === 'files' ? 'files' : 'experiments'
          }
          view={view}
          activePath={location.paths?.[workspace]}
          onActivePathChange={openFile}
          onContext={receiveContext}
        />
      )}
    </WorkspaceFrame>
  );
  return (
    <AppShell
      variant={project ? 'workspace' : 'launcher'}
      rightWidth={rightWidth}
      topbar={
        project ? (
          <TopBar
            project={project}
            projects={data?.projects ?? []}
            ready={!!ready}
            onProject={openProject}
            onProjects={returnToProjects}
            onNewProject={() => openDialog({ kind: 'project' })}
            onProjectSettings={() => openDialog({ kind: 'project', project })}
          />
        ) : null
      }
      rail={
        project && (
          <WorkspaceRail
            active={workspace}
            inProject={!!project}
            onNavigate={navigate}
            onProjects={returnToProjects}
            onSettings={() => openDialog({ kind: 'profile' })}
            onData={() => openDialog({ kind: 'data' })}
            onAbout={() => openDialog({ kind: 'about' })}
          />
        )
      }
      statusbar={
        project ? (
          <footer className="statusbar">
            <span>
              <i className={`save-dot ${dirty ? 'dirty' : ''}`} />
              {busy
                ? t('正在保存…')
                : error
                  ? t('操作未完成')
                  : dirty
                    ? t('有未保存内容')
                    : t('已保存')}
            </span>
            <span>{preview ? t('浏览器预览 · 独立数据') : t('本地工作区')}</span>
            <span className="spacer" />
            <StatusBarTools
              ready={!!ready}
              tool={ui.dock}
              open={ui.dockOpen}
              notesWorkspace={notesWorkspace}
              onTool={toggleTool}
            />
          </footer>
        ) : null
      }
      dialogs={
        <>
          {launching && (
            <Modal title={t('正在打开项目')} busy onClose={() => {}}>
              <p className="form-grid">{t('正在准备工作区…')}</p>
            </Modal>
          )}
          {dialog?.kind === 'project' ? (
            <ProjectForm
              store={store}
              space={ui.space === '__teams__' ? 'personal' : ui.space}
              project={dialog.project}
              onClose={() => setDialog(null)}
            />
          ) : null}
          {dialog?.kind === 'team' ? (
            <TeamForm store={store} team={dialog.team} onClose={() => setDialog(null)} />
          ) : null}
          {dialog && ['profile', 'data', 'about'].includes(dialog.kind) ? (
            <SettingsDialog
              store={store}
              initialSection={
                dialog.kind === 'profile' ? 'general' : dialog.kind === 'about' ? 'about' : 'data'
              }
              onClose={() => setDialog(null)}
            />
          ) : null}
          {dialog?.kind === 'search' && data ? (
            <SearchDialog store={store} onClose={() => setDialog(null)} onNavigate={goToTarget} />
          ) : null}
        </>
      }
    >
      {!project && (
        <ProjectSidebar
          space={ui.space}
          teams={data?.teams ?? []}
          ready={!!ready}
          onSpace={(space) => setUI((s) => ({ ...s, space }))}
          onNewTeam={() => openDialog({ kind: 'team' })}
          onSettings={() => openDialog({ kind: 'profile' })}
          onData={() => openDialog({ kind: 'data' })}
          onAbout={() => openDialog({ kind: 'about' })}
        />
      )}
      <main className="central-area" hidden={notesWorkspace}>
        {!project && !ready && (
          <header className="launcher-topbar" data-tauri-drag-region>
            <span className="spacer" />
            <WindowControls />
          </header>
        )}
        {error && ready && !dialog && (
          <div className="inline-error" role="alert">
            <span>{translateError(error)}</span>
            <Button
              variant="ghost"
              iconOnly
              className="icon-button"
              aria-label={t('关闭提示')}
              onClick={() => store.getState().clearMessage()}
            >
              <X />
            </Button>
          </div>
        )}
        <div className="workspace-content" key={epoch}>
          {content}
        </div>
      </main>
      {ready && (
        <GlobalDock
          key={epoch}
          store={store}
          backend={backend}
          tool={ui.dock}
          open={!!project && ui.dockOpen}
          notesWorkspace={notesWorkspace}
          context={effectiveContext}
          onNoteContext={receiveContext}
          onToolChange={openTool}
          onClose={() => {
            setUI((s) => ({ ...s, dockOpen: false }));
            document
              .getElementById(ui.dock === 'assistant' ? 'assistant-toggle' : 'notes-toggle')
              ?.focus();
          }}
          resizeHandle={
            <ResizeHandle
              value={rightWidth}
              min={300}
              max={Math.max(
                300,
                Math.min(
                  480,
                  windowWidth -
                    WORKSPACE_RAIL_WIDTH -
                    (workspace === 'literature' || (sidebar && sidebarExpanded)
                      ? resourceWidth
                      : 0) -
                    382,
                ),
              )}
              side="right"
              label={t('调整辅助栏宽度')}
              onChange={(rightWidth) => setUI((s) => ({ ...s, rightWidth }))}
            />
          }
        />
      )}
    </AppShell>
  );
}
