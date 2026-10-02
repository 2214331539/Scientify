import { t } from '../i18n';
import { createStore } from 'zustand/vanilla';
import { emptyWorkspace, type Workspace } from '../domain/workspace';
import { desktop, type WorkspaceBackend } from '../platform/desktop';

interface WorkspaceState {
  data: Workspace | null;
  phase: 'idle' | 'loading' | 'ready' | 'error';
  busy: boolean;
  dirty: boolean;
  agentTasks: Record<string, string>;
  dirtySources: Record<string, true>;
  epoch: number;
  error: string | null;
  notice: string | null;
  directory: string;
  legacyAvailable: boolean;
  load(): Promise<void>;
  refreshSaved(): Promise<boolean>;
  update(edit: (draft: Workspace) => void): Promise<boolean>;
  replace(kind: 'restore' | 'migrateLegacy' | 'importWorkspace'): Promise<boolean>;
  exportWorkspace(): Promise<void>;
  chooseDirectory(): Promise<string | null>;
  setAgentTask(id: string, project: string | null): void;
  setDirty(dirty: boolean): void;
  setDirtySource(source: string, dirty: boolean): void;
  clearMessage(): void;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createWorkspaceStore(backend: WorkspaceBackend) {
  let pending = 0;
  let exclusive = false;
  let tail = Promise.resolve();
  return createStore<WorkspaceState>((set, get) => ({
    data: null,
    phase: 'idle',
    busy: false,
    dirty: false,
    agentTasks: {},
    dirtySources: {},
    epoch: 0,
    error: null,
    notice: null,
    directory: '',
    legacyAvailable: false,
    async load() {
      if (
        get().busy ||
        get().phase === 'loading' ||
        get().dirty ||
        Object.keys(get().agentTasks).length
      )
        return;
      set({ phase: 'loading', error: null });
      try {
        const result = await backend.load();
        set({
          data: result.workspace ?? emptyWorkspace(),
          directory: result.directory,
          legacyAvailable: result.legacyAvailable,
          phase: 'ready',
          epoch: get().epoch + 1,
        });
      } catch (error) {
        set({ phase: 'error', error: message(error) });
      }
    },
    async refreshSaved() {
      // Refresh committed metadata only. Keep panel drafts, task memory and epoch.
      if (get().busy || exclusive || get().phase !== 'ready') return false;
      exclusive = true;
      set({ busy: true });
      try {
        const result = await backend.load();
        if (!result.workspace) throw new Error(t('工作区尚未载入。'));
        set({ data: result.workspace, error: null });
        return true;
      } catch (error) {
        set({ error: message(error) });
        return false;
      } finally {
        exclusive = false;
        set({ busy: false });
      }
    },
    async update(edit) {
      if (!get().data || exclusive || get().phase !== 'ready') return false;
      pending += 1;
      set({ busy: true });
      const run = async () => {
        set({ error: null, notice: null });
        try {
          // Read the authoritative snapshot when this operation reaches the queue.
          const data = get().data!;
          const draft = structuredClone(data);
          edit(draft);
          for (const projectId of Object.values(get().agentTasks)) {
            const before = data.projects.find((project) => project.id === projectId);
            const after = draft.projects.find((project) => project.id === projectId);
            if (!after || before?.path !== after.path)
              throw new Error(t('请先结束此项目的 Agent 任务并保存结果，再删除项目或更换目录。'));
          }
          for (const taskKey of Object.keys(get().agentTasks)) {
            const [project, id] = taskKey.split(':');
            if (
              data.sessions.some((chat) => chat.project === project && chat.id === id) &&
              !draft.sessions.some((chat) => chat.project === project && chat.id === id)
            )
              throw new Error(t('请先中止并等待此会话任务结束。'));
          }
          draft.revision = data.revision + 1;
          draft.updatedAt = new Date().toISOString();
          const saved = await backend.save(draft, data.revision);
          set({ data: saved, notice: t('已保存到本机') });
          return true;
        } catch (error) {
          set({ error: message(error) });
          return false;
        } finally {
          pending -= 1;
          set({ busy: pending > 0 });
        }
      };
      const result = pending === 1 ? run() : tail.then(run);
      tail = result.then(() => undefined);
      return result;
    },
    async replace(kind) {
      if (Object.keys(get().agentTasks).length) {
        set({ error: t('请先结束 Agent 任务并保存结果，再替换工作区数据。') });
        return false;
      }
      if (get().busy || get().dirty || get().phase === 'loading') return false;
      exclusive = true;
      set({ busy: true, error: null, notice: null });
      try {
        const data = await backend[kind]();
        if (!data) return false;
        set({
          data,
          phase: 'ready',
          epoch: get().epoch + 1,
          notice:
            kind === 'migrateLegacy' ? t('已复制旧工作区，原始数据保持不变') : t('工作区已载入'),
        });
        // Refresh metadata only after replacement, without risking data rollback.
        try {
          const meta = await backend.load();
          set({ directory: meta.directory, legacyAvailable: meta.legacyAvailable });
        } catch {
          /* The mutation succeeded; keep the returned authoritative snapshot. */
        }
        return true;
      } catch (error) {
        set({ error: message(error) });
        return false;
      } finally {
        exclusive = false;
        set({ busy: false });
      }
    },
    async exportWorkspace() {
      if (get().busy || get().dirty) return;
      exclusive = true;
      set({ busy: true, error: null, notice: null });
      try {
        if (await backend.exportWorkspace())
          set({ notice: t('已导出 JSON。附件二进制请另行备份整个数据目录。') });
      } catch (error) {
        set({ error: message(error) });
      } finally {
        exclusive = false;
        set({ busy: false });
      }
    },
    async chooseDirectory() {
      try {
        return await backend.chooseDirectory();
      } catch (error) {
        set({ error: message(error) });
        return null;
      }
    },
    setAgentTask(id, project) {
      if (get().agentTasks[id] === (project ?? undefined)) return;
      const agentTasks = { ...get().agentTasks };
      if (project) agentTasks[id] = project;
      else delete agentTasks[id];
      set({ agentTasks });
    },
    setDirty: (dirty) => get().setDirtySource('form', dirty),
    setDirtySource(source, dirty) {
      const dirtySources = { ...get().dirtySources };
      if (dirty) dirtySources[source] = true;
      else delete dirtySources[source];
      set({ dirtySources, dirty: Object.keys(dirtySources).length > 0 });
    },
    clearMessage: () => set({ error: null, notice: null }),
  }));
}

export const workspaceStore = createWorkspaceStore(desktop);
export type WorkspaceStore = ReturnType<typeof createWorkspaceStore>;
