import { t } from '../i18n';
import type { EditorState } from '@codemirror/state';
import type { ResearchBackend } from '../platform/research';

export type FileSnapshot = {
  content: string;
  version: string | null;
  dirty: boolean;
  phase: 'idle' | 'loading' | 'ready' | 'saving' | 'error';
  error: string | null;
};
export type EditorCommand =
  | { type: 'find' | 'replace' | 'toggleWrap' | 'undo' | 'redo' }
  | { type: 'reveal'; from: number; to: number };

/** A file owns its buffer; navigation only holds references to this session. */
export class FileSession {
  private snapshot: FileSnapshot = {
    content: '',
    version: null,
    dirty: false,
    phase: 'idle',
    error: null,
  };
  private savedContent = '';
  private listeners = new Set<() => void>();
  private loading: Promise<void> | null = null;
  private editRevision = 0;
  editorState: EditorState | null = null;
  editorWrap = false;
  editorScroll = { top: 0, left: 0 };
  private editorCommand: EditorCommand | null = null;
  get pendingEditorCommand() {
    return this.editorCommand;
  }

  requestEditorCommand(command: EditorCommand) {
    this.editorCommand = command;
    this.update({});
  }
  takeEditorCommand() {
    const command = this.editorCommand;
    this.editorCommand = null;
    return command;
  }

  constructor(
    readonly backend: ResearchBackend,
    readonly projectId: string,
    readonly path: string,
    readonly workspaceRoot?: string,
  ) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private update(value: Partial<FileSnapshot>) {
    this.snapshot = { ...this.snapshot, ...value };
    this.listeners.forEach((listener) => listener());
  }
  async load() {
    if (this.loading) return this.loading;
    if (this.snapshot.phase === 'ready' || this.snapshot.phase === 'saving' || this.snapshot.dirty)
      return;
    this.update({ phase: 'loading', error: null });
    this.loading = this.backend
      .readFile(this.projectId, this.path, ...(this.workspaceRoot ? [this.workspaceRoot] : []))
      .then((file) => {
        this.savedContent = file.content;
        this.update({ content: file.content, version: file.version, dirty: false, phase: 'ready' });
      })
      .catch((error) =>
        this.update({
          phase: 'error',
          error: String(error instanceof Error ? error.message : error),
        }),
      )
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }
  edit(content: string) {
    this.editRevision += 1;
    this.update({ content, dirty: content !== this.savedContent });
  }
  async save(): Promise<boolean> {
    if (this.snapshot.phase === 'saving' || this.snapshot.phase === 'loading') return false;
    if (!this.snapshot.dirty) return true;
    const { content, version } = this.snapshot;
    this.update({ phase: 'saving', error: null });
    try {
      const file = await this.backend.writeFile(
        this.projectId,
        this.path,
        content,
        version,
        ...(this.workspaceRoot ? [this.workspaceRoot] : []),
      );
      this.savedContent = content;
      // Input during an in-flight save remains a newer, unsaved buffer.
      this.update({
        version: file.version,
        dirty: this.snapshot.content !== content,
        phase: 'ready',
      });
      return true;
    } catch (error) {
      this.update({
        phase: 'ready',
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }
  async reloadDiscardingEdits(): Promise<boolean> {
    if (this.snapshot.phase === 'saving' || this.snapshot.phase === 'loading') return false;
    const previousPhase = this.snapshot.phase;
    const revisionAtStart = this.editRevision;
    this.update({ phase: 'loading', error: null });
    try {
      const file = await this.backend.readFile(
        this.projectId,
        this.path,
        ...(this.workspaceRoot ? [this.workspaceRoot] : []),
      );
      if (this.editRevision !== revisionAtStart) {
        this.update({ error: t('读取期间产生了新编辑，已保留当前缓冲，请重新读取。') });
        return false;
      }
      this.savedContent = file.content;
      this.editorState = null;
      this.update({
        content: file.content,
        version: file.version,
        dirty: false,
        phase: 'ready',
        error: null,
      });
      return true;
    } catch (error) {
      this.update({ error: error instanceof Error ? error.message : String(error) });
      return false;
    } finally {
      if (this.getSnapshot().phase === 'loading')
        this.update({ phase: previousPhase === 'idle' ? 'error' : previousPhase });
    }
  }
}

type FileRuntime = {
  sessions: Map<string, FileSession>;
  tabs: Map<string, string[]>;
  active: Map<string, string>;
  listeners: Set<() => void>;
  revision: number;
  pendingOperations: number;
};
const runtimes = new WeakMap<ResearchBackend, FileRuntime>();
export function getFileRuntime(backend: ResearchBackend) {
  let runtime = runtimes.get(backend);
  if (!runtime) {
    runtime = {
      sessions: new Map(),
      tabs: new Map(),
      active: new Map(),
      listeners: new Set(),
      revision: 0,
      pendingOperations: 0,
    };
    runtimes.set(backend, runtime);
  }
  return runtime;
}
export function notifyFileRuntime(backend: ResearchBackend) {
  const runtime = getFileRuntime(backend);
  runtime.revision += 1;
  runtime.listeners.forEach((listener) => listener());
}
export function getFileSession(
  backend: ResearchBackend,
  projectId: string,
  path: string,
  workspaceRoot?: string,
) {
  const runtime = getFileRuntime(backend);
  const key = JSON.stringify([projectId, path, workspaceRoot ?? '']);
  let session = runtime.sessions.get(key);
  if (!session) {
    session = new FileSession(backend, projectId, path, workspaceRoot);
    session.subscribe(() => notifyFileRuntime(backend));
    runtime.sessions.set(key, session);
  }
  return session;
}
export function directorySessions(
  backend: ResearchBackend,
  projectId: string,
  root?: string,
  includeUnscoped = false,
) {
  return [...getFileRuntime(backend).sessions.values()].filter(
    (s) =>
      s.projectId === projectId &&
      ((s.workspaceRoot ?? '') === (root ?? '') || (includeUnscoped && !s.workspaceRoot)),
  );
}
export async function reloadDirectorySessions(
  backend: ResearchBackend,
  projectId: string,
  root?: string,
) {
  await Promise.allSettled(
    directorySessions(backend, projectId, root)
      .filter((s) => !s.getSnapshot().dirty)
      .map((s) => s.reloadDiscardingEdits()),
  );
  window.dispatchEvent(new CustomEvent('scientify-project-files-changed', { detail: projectId }));
}
export function hasUnsavedFileChanges(backend: ResearchBackend) {
  return [...getFileRuntime(backend).sessions.values()].some(
    (session) => session.getSnapshot().dirty,
  );
}
export function hasPendingFileOperations(backend: ResearchBackend) {
  const runtime = getFileRuntime(backend);
  return (
    runtime.pendingOperations > 0 ||
    [...runtime.sessions.values()].some((session) =>
      ['saving', 'loading'].includes(session.getSnapshot().phase),
    )
  );
}
export function beginFileOperation(backend: ResearchBackend) {
  const runtime = getFileRuntime(backend);
  runtime.pendingOperations += 1;
  notifyFileRuntime(backend);
  let completed = false;
  return () => {
    if (completed) return;
    completed = true;
    runtime.pendingOperations -= 1;
    notifyFileRuntime(backend);
  };
}
/** Rebinding a clean project root must never reuse the previous directory's buffers. */
export function invalidateProjectFileSessions(backend: ResearchBackend, projectId: string) {
  const runtime = getFileRuntime(backend);
  const sessions = [...runtime.sessions.entries()].filter(
    ([, session]) => session.projectId === projectId,
  );
  if (
    hasPendingFileOperations(backend) ||
    sessions.some(([, session]) => session.getSnapshot().dirty)
  )
    return false;
  for (const [key] of sessions) runtime.sessions.delete(key);
  for (const key of runtime.tabs.keys())
    if (JSON.parse(key)[0] === projectId) runtime.tabs.delete(key);
  for (const key of runtime.active.keys())
    if (JSON.parse(key)[0] === projectId) runtime.active.delete(key);
  notifyFileRuntime(backend);
  return true;
}
