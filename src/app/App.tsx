import { ProjectSyncControl } from '../features/projects/ProjectSyncControl';
import { t, translateError } from '../i18n';
import { Button } from '../components/primitives';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { applyAppearance, migrateTheme, usePreferences } from '../i18n/preferences';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { X } from 'lucide-react';
import { BrandMark } from '../components/layout/BrandMark';
import { secondaryViews as secondary } from '../components/navigation/workspaces';
import { WritingWorkspace } from '../workspaces/writing/WritingWorkspace';
import { ProjectForm } from '../features/projects/ProjectForm';
import { confirmAction } from '../components/prompts';
import { ProjectLibrary } from '../features/projects/ProjectLibrary';
import { TeamProjects } from '../features/projects/TeamProjects';
import { NewProjectWizard, type NewProjectMode } from '../features/projects/NewProjectWizard';
import {
  CENTER_PAGES,
  COLLABORATION_TEAM_ID,
  ensureCollaborationTeam,
  markOpened,
  personalProjects,
  type CenterPage,
} from '../features/projects/model';
import {
  classifyCloud,
  isNewCloudProject,
  refreshCloud,
  useCloud,
} from '../features/projects/cloud';
import { purgeExpiredNotes } from '../features/notes/model';
import { SettingsDialog } from '../features/settings/Settings';
import { SearchDialog, type SearchTarget } from '../features/search/SearchDialog';
import { LocalLiterature } from '../workspaces/literature/LocalLiterature';
import { nativeLibrary, noteFiles } from '../platform/library';
import { flushPaperNotes, notesDirty, notesPending } from '../workspaces/literature/local-session';
import { browserLayout } from '../platform/browser-pane';
import { installPaperService } from '../platform/paper-service';
import { ExperimentWorkspace } from '../workspaces/experiments/ExperimentWorkspace';
import { useExecutions } from '../workspaces/experiments/runtime';
import { useDevelopmentRuntime } from '../workspaces/experiments/development';
import { clearCodeRoot, selectExperiment } from '../workspaces/experiments/code-context';
import { sameCodeRoot } from '../workspaces/experiments/catalog';
import { GlobalDock } from '../shell/GlobalDock';
import { ResizeHandle } from '../shell/ResizeHandle';
import {
  getFileRuntime,
  hasPendingFileOperations,
  hasUnsavedFileChanges,
  invalidateProjectFileSessions,
  notifyFileRuntime,
} from '../editor/sessions';
import type { Project } from '../domain/workspace';
import type { WorkContext, WorkspaceId } from '../domain/context';
import { workspaceStore, type WorkspaceStore } from '../stores/workspace';
import { nativeResearch, type ResearchBackend } from '../platform/research';
import { ViewTransition } from '../components/workspace/ViewTransition';
import { bindingFor, eventToShortcut, isEditableTarget } from '../platform/shortcuts';
import {
  canEditProject,
  collaborationStateEvent,
  isSyncedProject,
  signInRequestEvent,
  type CollaborationProject,
} from '../platform/collaboration';
import { SignInPage } from '../features/account/SignInPage';
import { AppFrame } from '../shell/AppFrame';
import { TitleBar, type Crumb } from '../shell/TitleBar';
import { Notifications } from '../shell/Notifications';
import {
  CenterNavigation,
  ProjectNavigation,
  SidebarFooter,
  SidebarSlotProvider,
  projectModules,
  type SettingsSection,
} from '../shell/Sidebar';
import { ShareProjectDialog } from '../features/projects/ProjectDialogs';
import { UsersRound } from 'lucide-react';

type Dialog =
  | { kind: 'project'; project?: Project; mode?: NewProjectMode }
  | { kind: 'data' | 'profile' | 'search' | 'about' | 'collaboration' | 'shortcuts' | 'models' }
  | null;
const settingsSection = {
  profile: 'general',
  data: 'data',
  about: 'about',
  collaboration: 'collaboration',
  shortcuts: 'shortcuts',
  models: 'models',
} as const;
type Location = {
  workspace: WorkspaceId;
  view: string;
  paperId: string | null;
  browserId?: string;
  runId?: string | null;
  paths: Partial<Record<WorkspaceId, string | null>>;
  views?: Partial<Record<WorkspaceId, string>>;
};
type UISession = {
  version: 2;
  projectId: string | null;
  space: string;
  page: CenterPage;
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
  page: 'mine',
  locations: {},
  dock: 'assistant',
  dockOpen: false,
  leftWidth: 240,
  rightWidth: 340,
};
const locationDefault: Location = { workspace: 'literature', view: '', paperId: null, paths: {} };
const SIDEBAR_WIDTH = 232;
const MIN_DOCK_WIDTH = 280;
const MIN_CENTRAL_WIDTH = 320;
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
        page: CENTER_PAGES.includes(value.page) ? value.page : 'mine',
        dock: value.dock === 'notes' ? 'notes' : 'assistant',
        dockOpen: value.dock === 'notes' && value.dockOpen === true,
        leftWidth: Math.max(180, Math.min(300, Number(value.leftWidth) || 240)),
        rightWidth: Math.max(
          MIN_DOCK_WIDTH,
          Number.isFinite(Number(value.rightWidth)) ? Number(value.rightWidth) || 340 : 340,
        ),
      };
  } catch {
    /* UI preferences are optional. */
  }
  return structuredClone(defaults);
}

function useCloseProtection(store: WorkspaceStore, backend: ResearchBackend) {
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
        if (old && (old.path || old.repo || '') !== (project.path || project.repo || '')) {
          invalidateProjectFileSessions(backend, project.id);
          clearCodeRoot(project.id);
        }
      }
      for (const project of previous.data?.projects ?? [])
        if (!next.data?.projects.some((p) => p.id === project.id)) clearCodeRoot(project.id);
    });
    return () => {
      runtime.listeners.delete(update);
      unsubscribe();
    };
  }, [store, backend]);
  useEffect(() => {
    function beforeUnload(event: BeforeUnloadEvent) {
      if (
        store.getState().dirty ||
        store.getState().busy ||
        hasPendingFileOperations(backend) ||
        Object.keys(store.getState().agentTasks).length
      ) {
        event.preventDefault();
        event.returnValue = '';
      }
    }
    window.addEventListener('beforeunload', beforeUnload);
    let disposed = false;
    let closing = false;
    const cleanups: (() => void)[] = [];
    if (isTauri()) {
      const requestClose = async () => {
        if (closing) return;
        const { busy } = store.getState();
        if (busy || hasPendingFileOperations(backend)) return;
        if (Object.keys(store.getState().agentTasks).length) {
          store.setState({
            error: t(
              '后台任务仍在运行或有结果未保存。请在实验任务入口或 AI 助手中停止任务、保存结果后再关闭窗口。',
            ),
          });
          return;
        }
        closing = true;
        try {
          if (!(await flushPaperNotes())) {
            store.setState({ error: t('论文笔记尚未保存，请重试或处理冲突后退出。') });
            return;
          }
          if (
            !store.getState().dirty ||
            (await confirmAction(t('仍有未保存的内容。确认放弃这些修改并退出？')))
          ) {
            await getCurrentWindow().destroy();
          }
        } catch (error) {
          store.setState({ error: translateError(String(error)) });
        } finally {
          closing = false;
        }
      };
      const register = (ready: Promise<() => void>) =>
        void ready
          .then((unlisten) => {
            if (disposed) unlisten();
            else cleanups.push(unlisten);
          })
          .catch((error) => store.setState({ error: translateError(String(error)) }));
      register(
        getCurrentWindow().onCloseRequested(async (event) => {
          event.preventDefault();
          await requestClose();
        }),
      );
      // Only exits addressed to this window: a plain listen also hears ones sent to the other window.
      register(
        listen('scientify-exit-requested', () => void requestClose(), {
          target: getCurrentWindow().label,
        }),
      );
    }
    return () => {
      disposed = true;
      cleanups.forEach((unlisten) => unlisten());
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, [store, backend]);
}

export function App({
  store = workspaceStore,
  backend = nativeResearch,
  windowMode = 'browser',
}: {
  store?: WorkspaceStore;
  backend?: ResearchBackend;
  preview?: boolean;
  /** `main` is the desktop window; `browser` is the preview and the tests. */
  windowMode?: 'main' | 'browser';
}) {
  const experiments = useExecutions(store, true);
  useDevelopmentRuntime(store, true);
  useEffect(() => {
    // Inbox chats in the project center read attached PDFs too.
    if (windowMode === 'browser') return;
    return installPaperService((reason) => store.setState({ error: String(reason) }));
  }, [windowMode, store]);
  const preferences = usePreferences();
  const epoch = useStore(store, (s) => s.epoch);
  const data = useStore(store, (s) => s.data),
    phase = useStore(store, (s) => s.phase),
    error = useStore(store, (s) => s.error);
  const sessionKey = windowMode === 'browser' ? 'scientify.ui.v2' : `scientify.ui.v2.${windowMode}`;
  const [ui, setUI] = useState(() => {
      const saved = readSession(sessionKey);
      // The desktop starts in the project center.
      if (windowMode === 'main') return { ...saved, projectId: null, dockOpen: false };
      return saved;
    }),
    [dialog, setDialog] = useState<Dialog>(null),
    [sidebarExpanded, setSidebarExpanded] = useState(true),
    [sidebarOpen, setSidebarOpen] = useState(true),
    [sharing, setSharing] = useState<string | null>(null),
    [resourceSlot, setResourceSlot] = useState<HTMLElement | null>(null),
    [windowWidth, setWindowWidth] = useState(window.innerWidth);
  const [context, setContext] = useState<WorkContext>({
    workspace: 'projects',
    title: t('项目管理'),
  });
  const [pendingNote, setPendingNote] = useState<{ scope: string; id: string } | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const notesLayerRef = useRef<HTMLElement>(null);
  const [notesPlacement, setNotesPlacement] = useState(false);
  useCloseProtection(store, backend);
  // Every sign-in entry asks for the same page; it opens over any dialog.
  useEffect(() => {
    const open = () => setSigningIn(true);
    window.addEventListener(signInRequestEvent, open);
    return () => window.removeEventListener(signInRequestEvent, open);
  }, []);
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
    if (!isTauri()) return;
    // The agent writes notes straight to disk; show them without waiting for the turn to end.
    const subscription = listen('notes-changed', () => void store.getState().refreshSaved());
    return () => {
      void subscription.then((stop) => stop());
    };
  }, [store]);
  // Notes kept in the recycle bin longer than 30 days are removed once data has loaded.
  useEffect(() => {
    if (phase === 'ready') void purgeExpiredNotes(store);
  }, [phase, store]);
  // The project center keeps the cloud list fresh: on open, after sign-in changes,
  // when the window comes back into focus, and every two minutes.
  const cloud = useCloud();
  const cloudWatched = phase === 'ready';
  useEffect(() => {
    if (!cloudWatched) return;
    let last = 0;
    const refresh = (force = false) => {
      if (!force && Date.now() - last < 20_000) return;
      last = Date.now();
      void refreshCloud(store.getState().data?.projects ?? []);
    };
    const forced = () => refresh(true);
    const focused = () => refresh();
    refresh(true);
    window.addEventListener(collaborationStateEvent, forced);
    window.addEventListener('focus', focused);
    const timer = window.setInterval(forced, 120_000);
    return () => {
      window.removeEventListener(collaborationStateEvent, forced);
      window.removeEventListener('focus', focused);
      window.clearInterval(timer);
    };
  }, [cloudWatched, store]);
  useEffect(() => {
    const onResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  useLayoutEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      applyAppearance(preferences, media.matches);
      if (isTauri()) {
        void invoke('translation_service', {
          action: {
            type: 'appearance',
            dark: preferences.theme === 'dark' || (preferences.theme === 'system' && media.matches),
          },
        }).catch((reason) => store.setState({ error: translateError(String(reason)) }));
      }
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [preferences, store]);
  useEffect(() => {
    if (!isTauri() || windowMode === 'browser') return;
    void getCurrentWindow()
      .setTitle('Scientify')
      .catch(() => {});
  }, [windowMode]);
  useEffect(() => {
    if (data) migrateTheme(data.settings.theme);
  }, [data]);
  useEffect(() => {
    if (!data) return;
    setUI((s) => {
      const invalidProject = s.projectId && !data.projects.some((p) => p.id === s.projectId);
      const invalidSpace =
        !['personal', '__teams__'].includes(s.space) && !data.teams.some((t) => t.id === s.space);
      return invalidProject || invalidSpace || (s.space === '__teams__' && data.teams.length > 0)
        ? {
            ...s,
            projectId: invalidProject ? null : s.projectId,
            space: invalidSpace
              ? 'personal'
              : s.space === '__teams__' && data.teams.length
                ? data.teams[0].id
                : s.space,
          }
        : s;
    });
  }, [data]);
  const project = data?.projects.find((p) => p.id === ui.projectId);
  const location = project ? (ui.locations[project.id] ?? locationDefault) : locationDefault;
  const workspace = projectModules.some((w) => w.id === location.workspace)
    ? location.workspace
    : 'literature';
  const view = secondary[workspace].some((v) => v.id === location.view)
    ? location.view
    : (secondary[workspace][0]?.id ?? '');
  // Back and forward walk the places the user visited: center pages and project modules.
  const place = project ? `p:${project.id}:${workspace}` : `c:${ui.page}`;
  const [trail, setTrail] = useState<{ places: string[]; index: number }>({
    places: [],
    index: -1,
  });
  const stepping = useRef(false);
  useEffect(() => {
    if (phase !== 'ready') return;
    setTrail((current) => {
      if (stepping.current) {
        stepping.current = false;
        return current;
      }
      if (current.places[current.index] === place) return current;
      const places = [...current.places.slice(0, current.index + 1), place].slice(-50);
      return { places, index: places.length - 1 };
    });
  }, [place, phase]);
  function visit(index: number) {
    const target = trail.places[index];
    if (!target || target === place) return;
    const [kind, id, module] = target.split(':');
    if (kind === 'p' && !store.getState().data?.projects.some((p) => p.id === id)) return;
    stepping.current = true;
    setTrail((current) => ({ ...current, index }));
    if (kind === 'c') setUI((s) => ({ ...s, projectId: null, page: id as CenterPage }));
    else
      setUI((s) => {
        const previous = s.locations[id] ?? locationDefault;
        const next = module as WorkspaceId;
        return {
          ...s,
          projectId: id,
          locations: {
            ...s.locations,
            [id]: { ...previous, workspace: next, view: previous.views?.[next] ?? '' },
          },
        };
      });
  }
  const effectiveContext: WorkContext =
    context.projectId === project?.id && context.workspace === (project ? workspace : 'projects')
      ? context
      : {
          projectId: project?.id,
          workspace: project ? workspace : 'projects',
          title: project?.name ?? t('项目管理'),
          text: project?.question,
        };
  const activeLocation = useRef({ projectId: project?.id, workspace });
  activeLocation.current = { projectId: project?.id, workspace };
  const receiveContext = useCallback((next: WorkContext) => {
    if (
      next.projectId === activeLocation.current.projectId &&
      next.workspace === activeLocation.current.workspace
    )
      setContext(next);
  }, []);
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
                    [patch.workspace ?? s.locations[s.projectId]?.workspace ?? 'literature']:
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
  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if ((event.ctrlKey || event.metaKey) && event.key === '\\' && !event.shiftKey) {
        event.preventDefault();
        setSidebarOpen((open) => !open);
        return;
      }
      const shortcut = eventToShortcut(event);
      if (!shortcut) return;
      const settings = data?.settings.shortcuts;
      const command = [
        'app.openAssistant',
        'app.openNotes',
        'app.openLiterature',
        'app.openExperiments',
        'app.openCode',
        'app.focusSearch',
        'app.newConversation',
      ].find((value) => {
        const binding = bindingFor(settings, value as Parameters<typeof bindingFor>[1]);
        return binding?.enabled !== false && binding?.keys === shortcut;
      });
      if (!command || (isEditableTarget(event.target) && command !== 'app.focusSearch')) return;
      if (document.querySelector('dialog[open]') && command !== 'app.focusSearch') return;
      event.preventDefault();
      if (command === 'app.focusSearch') {
        if (!document.querySelector('dialog[open]')) setDialog({ kind: 'search' });
      } else if (command === 'app.openAssistant') {
        // The assistant lives inside projects only.
        if (activeLocation.current.projectId) toggleTool('assistant');
      } else if (command === 'app.openNotes') navigate('notes');
      else if (command === 'app.openLiterature') navigate('literature');
      else if (command === 'app.openExperiments') navigate('experiments');
      else if (command === 'app.openCode') {
        patchLocation({ workspace: 'experiments', view: 'files' });
      } else if (command === 'app.newConversation') {
        openTool('assistant');
        window.dispatchEvent(new CustomEvent('scientify-new-conversation'));
      }
    };
    window.addEventListener('keydown', onShortcut);
    return () => window.removeEventListener('keydown', onShortcut);
  }, [data?.settings.shortcuts, navigate, openTool, patchLocation, workspace]);
  function openProject(id: string) {
    markOpened(id);
    // A project created a moment ago may not be in this render's data yet.
    const p = store.getState().data?.projects.find((p) => p.id === id);
    if (p) {
      setUI((s) => ({ ...s, projectId: id, space: p.space }));
      setSidebarExpanded(true);
    }
  }

  /** Bind a cloud project to this device; team projects go to the team space, my own stay personal. */
  async function openRemoteProject(remote: CollaborationProject, team = true) {
    const timestamp = new Date().toISOString();
    const space = team ? COLLABORATION_TEAM_ID : 'personal';
    const saved = await store.getState().update((workspaceData) => {
      if (team) ensureCollaborationTeam(workspaceData);
      const local = workspaceData.projects.find((project) => project.id === remote.id);
      if (local) {
        Object.assign(local, {
          // Read-only members get the new name from sync; writing it here would be refused.
          ...(canEditProject(local) ? { name: remote.name } : {}),
          updatedAt: remote.updatedAt ?? timestamp,
          collaborationRole: remote.role,
        });
      } else {
        workspaceData.projects.push({
          id: remote.id,
          name: remote.name,
          question: '',
          createdAt: remote.createdAt ?? timestamp,
          updatedAt: remote.updatedAt ?? timestamp,
          space,
          color: '#56746a',
          collaborationRole: remote.role,
        });
      }
    });
    if (!saved) throw new Error(store.getState().error ?? t('协作项目无法载入，请重试。'));
    markOpened(remote.id);
    setUI((current) => ({
      ...current,
      projectId: remote.id,
      space: store.getState().data?.projects.find((p) => p.id === remote.id)?.space ?? space,
      locations: {
        ...current.locations,
        [remote.id]: current.locations[remote.id] ?? locationDefault,
      },
    }));
    setSidebarExpanded(true);
  }
  function openTarget(id: string, target: SearchTarget | { source: WorkContext }) {
    markOpened(id);
    if ('source' in target)
      window.dispatchEvent(new CustomEvent('scientify-open-source', { detail: target.source }));
    else goToTarget(target);
  }
  // A chat moved out of the inbox offers to open its project at the assistant.
  const latestOpenTarget = useRef(openTarget);
  latestOpenTarget.current = openTarget;
  useEffect(() => {
    const open = (event: Event) => {
      const projectId = (event as CustomEvent<{ projectId?: string }>).detail?.projectId;
      if (projectId)
        latestOpenTarget.current(projectId, {
          projectId,
          workspace: 'literature',
          tool: 'assistant',
        });
    };
    window.addEventListener('scientify-open-project', open);
    return () => window.removeEventListener('scientify-open-project', open);
  }, []);
  function returnToProjects(page?: CenterPage) {
    setUI((s) => ({ ...s, projectId: null, page: page ?? s.page }));
  }
  function navigate(id: WorkspaceId) {
    if (id === workspace) return;
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
    setDialog(null);
    setUI((s) => ({
      ...s,
      projectId: target.projectId ?? null,
      space: data?.projects.find((p) => p.id === target.projectId)?.space ?? s.space,
      // A project result opens the project where the user left it.
      ...(target.projectId && target.workspace !== 'overview'
        ? {
            locations: {
              ...s.locations,
              [target.projectId]: {
                ...(s.locations[target.projectId] ?? locationDefault),
                workspace: target.workspace === 'projects' ? 'literature' : target.workspace,
                view: target.workspace === 'literature' ? 'local' : '',
                views: {
                  ...s.locations[target.projectId]?.views,
                  [target.workspace === 'projects' ? 'literature' : target.workspace]:
                    target.workspace === 'literature' ? 'local' : '',
                },
                paperId: target.workspace === 'literature' ? (target.resourceId ?? null) : null,
              },
            },
          }
        : {}),
      ...(target.tool ? { dock: target.tool, dockOpen: true } : {}),
    }));
    if ((target.tool === 'notes' || target.workspace === 'notes') && target.resourceId)
      setPendingNote({ scope: target.projectId ?? '__inbox__', id: target.resourceId });
  }
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
      const w = source.workspace === 'projects' ? 'literature' : source.workspace;
      if (w === 'experiments' && (source.experimentId || source.workspaceRoot)) {
        const target = data.experiments?.find(
          (experiment) =>
            experiment.project === source.projectId &&
            (experiment.id === source.experimentId ||
              sameCodeRoot(experiment.root, source.workspaceRoot)),
        );
        if (target && !target.archived) selectExperiment(source.projectId!, target);
        else if (source.path) {
          store.setState({ error: t('此材料的实验已移除或归档，请先恢复实验登记。') });
          return;
        }
      }
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
    const openRun = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId: string; runId: string }>).detail;
      const target = data?.projects.find((p) => p.id === detail?.projectId);
      if (!target || typeof detail?.runId !== 'string') return;
      setUI((s) => ({
        ...s,
        projectId: target.id,
        space: target.space,
        locations: {
          ...s.locations,
          [target.id]: {
            ...(s.locations[target.id] ?? locationDefault),
            workspace: 'experiments',
            view: 'runs',
            runId: detail.runId,
          },
        },
      }));
    };
    window.addEventListener('scientify-open-source', open);
    const openBrowser = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId: string; tabId: string }>).detail;
      const target = data?.projects.find((p) => p.id === detail?.projectId);
      if (!target || typeof detail?.tabId !== 'string') return;
      setUI((s) => ({
        ...s,
        projectId: target.id,
        space: target.space,
        locations: {
          ...s.locations,
          [target.id]: {
            ...(s.locations[target.id] ?? locationDefault),
            workspace: 'literature',
            view: 'subscriptions',
            browserId: detail.tabId,
          },
        },
      }));
    };
    window.addEventListener('scientify-open-browser', openBrowser);
    window.addEventListener('scientify-open-run', openRun);
    return () => {
      window.removeEventListener('scientify-open-source', open);
      window.removeEventListener('scientify-open-browser', openBrowser);
      window.removeEventListener('scientify-open-run', openRun);
    };
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
  function showPage(page: CenterPage) {
    setUI((s) => ({ ...s, page }));
  }
  const signedIn = !!cloud.state?.authenticated;
  const centerTeam = data && signedIn ? classifyCloud(cloud, data.projects).team : [];
  const centerCounts = {
    mine: data ? personalProjects(data).filter((p) => !p.archived).length : 0,
    team: centerTeam.length,
  };
  const teamAlert = centerTeam.some(
    (entry) =>
      (!entry.local && entry.remote.role !== 'owner' && isNewCloudProject(entry.remote.id)) ||
      !!entry.sync?.conflicts.length,
  );
  const notesWorkspace = !!ready && !!project && workspace === 'notes';
  if (notesWorkspace && !notesPlacement) setNotesPlacement(true);
  const inlineDockOpen =
    ui.dockOpen && windowWidth > 900 && (!notesWorkspace || ui.dock !== 'notes');
  const rightWidth = Math.min(
    ui.rightWidth,
    Math.max(MIN_DOCK_WIDTH, windowWidth - (sidebarOpen ? SIDEBAR_WIDTH : 0) - MIN_CENTRAL_WIDTH),
  );
  const maxResourceWidth = Math.max(
    180,
    Math.min(
      300,
      windowWidth -
        (sidebarOpen ? SIDEBAR_WIDTH : 0) -
        (inlineDockOpen ? rightWidth : 0) -
        MIN_CENTRAL_WIDTH,
    ),
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
    ui.page === 'mine' ? (
      <ProjectLibrary
        store={store}
        onOpen={openProject}
        onNew={() => openDialog({ kind: 'project' })}
        onEdit={(p) => openDialog({ kind: 'project', project: p })}
        onOpenRemote={openRemoteProject}
        onShared={() => showPage('team')}
      />
    ) : (
      <TeamProjects
        store={store}
        onOpenRemote={openRemoteProject}
        onNewTeamProject={() => openDialog({ kind: 'project', mode: 'team' })}
        onCollaborationSettings={() => openDialog({ kind: 'collaboration' })}
      />
    )
  ) : workspace === 'literature' ? (
    <LocalLiterature
      key={project.id}
      project={project}
      store={store}
      backend={backend}
      requestedPaper={location.paperId}
      requestedBrowser={location.browserId}
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
    />
  ) : workspace === 'notes' ? null : workspace === 'experiments' ? (
    <ExperimentWorkspace
      key={project.id}
      project={project}
      store={store}
      backend={backend}
      executions={experiments.runs}
      runtimeError={experiments.error}
      view={view}
      onView={(view) => patchLocation({ view })}
      activePath={location.paths?.experiments}
      onOpen={openFile}
      selectedRunId={location.runId}
      onSelect={(runId) => patchLocation({ runId })}
      onContext={receiveContext}
      sidebarOpen={sidebarExpanded}
      onProjectRun={(projectId, runId) =>
        setUI((s) => ({
          ...s,
          projectId,
          space: data.projects.find((p) => p.id === projectId)?.space ?? s.space,
          locations: {
            ...s.locations,
            [projectId]: {
              ...(s.locations[projectId] ?? locationDefault),
              workspace: 'experiments',
              view: 'runs',
              runId,
            },
          },
        }))
      }
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
    />
  ) : (
    <WritingWorkspace
      key={project.id}
      project={project}
      store={store}
      backend={backend}
      view={view}
      onView={(next) => patchLocation({ view: next })}
      activePath={location.paths?.writing}
      onOpen={openFile}
      onContext={receiveContext}
    />
  );
  const central = (
    <main className="central-area" aria-hidden={notesWorkspace || undefined} inert={notesWorkspace}>
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
      <div className="workspace-content" data-workspace={workspace} data-view={view}>
        <ViewTransition
          key={`${epoch}:${project?.id ?? 'launcher'}:${phase}`}
          viewKey={project ? workspace : ui.page}
          external={project ? { key: 'notes', ref: notesLayerRef } : undefined}
          onSettled={() => {
            if (!notesWorkspace) setNotesPlacement(false);
          }}
        >
          {content}
        </ViewTransition>
      </div>
    </main>
  );
  const footer = (
    <SidebarFooter
      onSettings={(section: SettingsSection) =>
        openDialog({ kind: section === 'general' ? 'profile' : section })
      }
    />
  );
  const moduleName = projectModules.find((item) => item.id === workspace)?.label ?? '';
  const crumbs: Crumb[] = project
    ? [{ label: project.name }, { label: t(moduleName) }]
    : [{ label: ui.page === 'team' ? t('团队项目') : t('我的项目') }];
  const share =
    project && isSyncedProject(project) ? (
      <ProjectSyncControl
        key={project.id}
        project={project}
        store={store}
        automatic={windowMode === 'main'}
        trigger="share"
      />
    ) : project ? (
      <Button
        variant="ghost"
        className="sf-titlebar-tool"
        disabled={!ready || !canEditProject(project)}
        onClick={() => setSharing(project.id)}
      >
        <UsersRound />
        <span>{t('共享')}</span>
      </Button>
    ) : undefined;
  return (
    <AppFrame
      rightWidth={rightWidth}
      sidebarOpen={sidebarOpen}
      titlebar={
        <TitleBar
          crumbs={crumbs}
          ready={!!ready}
          canBack={trail.index > 0}
          canForward={trail.index < trail.places.length - 1}
          sidebarOpen={sidebarOpen}
          searchPlaceholder={
            project ? t('在 {name} 中搜索', { name: project.name }) : t('搜索项目、论文和笔记')
          }
          share={share}
          notifications={
            ready ? (
              <Notifications
                store={store}
                onOpenRemote={openRemoteProject}
                onOpenSource={(source) =>
                  window.dispatchEvent(new CustomEvent('scientify-open-source', { detail: source }))
                }
                onSyncSettings={() => openDialog({ kind: 'collaboration' })}
              />
            ) : null
          }
          dock={
            project
              ? {
                  tool: ui.dock,
                  open: ui.dockOpen,
                  notesAvailable: !notesWorkspace,
                  onTool: toggleTool,
                }
              : undefined
          }
          onHome={() => returnToProjects()}
          onBack={() => visit(trail.index - 1)}
          onForward={() => visit(trail.index + 1)}
          onToggleSidebar={() => setSidebarOpen((open) => !open)}
          onSearch={() => openDialog({ kind: 'search' })}
        />
      }
      sidebar={
        project ? (
          <ProjectNavigation
            project={project}
            projects={data?.projects ?? []}
            module={workspace}
            ready={!!ready}
            onModule={navigate}
            onBack={(page) => returnToProjects(page)}
            onSwitch={openProject}
            onProjectSettings={() => openDialog({ kind: 'project', project })}
            onNewProject={() => openDialog({ kind: 'project' })}
            onSlot={setResourceSlot}
            footer={footer}
          />
        ) : (
          <CenterNavigation
            page={ui.page}
            ready={!!ready}
            counts={centerCounts}
            teamAlert={teamAlert}
            onPage={showPage}
            footer={footer}
          />
        )
      }
      dialogs={
        <>
          {dialog?.kind === 'project' && dialog.project ? (
            <ProjectForm store={store} project={dialog.project} onClose={() => setDialog(null)} />
          ) : null}
          {dialog?.kind === 'project' && !dialog.project ? (
            <NewProjectWizard
              store={store}
              mode={dialog.mode ?? 'personal'}
              onClose={() => setDialog(null)}
              onCreated={(id) => {
                setDialog(null);
                openProject(id);
              }}
            />
          ) : null}
          {dialog && dialog.kind in settingsSection ? (
            <SettingsDialog
              store={store}
              backend={backend}
              initialSection={settingsSection[dialog.kind as keyof typeof settingsSection]}
              onClose={() => setDialog(null)}
            />
          ) : null}
          {dialog?.kind === 'search' && data ? (
            <SearchDialog
              store={store}
              onClose={() => setDialog(null)}
              onNavigate={goToTarget}
              {...(project ? { projectId: project.id } : {})}
            />
          ) : null}
          {signingIn ? <SignInPage onClose={() => setSigningIn(false)} /> : null}
          {sharing && data ? (
            <ShareProjectDialog
              store={store}
              projectId={sharing}
              onClose={() => setSharing(null)}
              onShared={() => setSharing(null)}
            />
          ) : null}
        </>
      }
    >
      <SidebarSlotProvider slot={project ? resourceSlot : null}>
        {(!ready || !project) && central}
        {ready && (
          <GlobalDock
            key={epoch}
            store={store}
            backend={backend}
            tool={ui.dock}
            open={ui.dockOpen && !!project}
            notesWorkspace={notesPlacement && !!project}
            workspaceContent={project ? central : undefined}
            notesLayerRef={notesLayerRef}
            notesWorkspaceActive={notesWorkspace}
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
                min={MIN_DOCK_WIDTH}
                max={Math.max(
                  MIN_DOCK_WIDTH,
                  windowWidth - (sidebarOpen ? SIDEBAR_WIDTH : 0) - MIN_CENTRAL_WIDTH,
                )}
                side="right"
                label={t('调整辅助栏宽度')}
                onChange={(rightWidth) => setUI((s) => ({ ...s, rightWidth }))}
              />
            }
          />
        )}
      </SidebarSlotProvider>
    </AppFrame>
  );
}
