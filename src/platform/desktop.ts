import { t } from '../i18n';
import { invoke, isTauri } from '@tauri-apps/api/core';
import type { Workspace } from '../domain/workspace';

export interface WorkspaceBackend {
  load(): Promise<{ workspace: Workspace | null; directory: string; legacyAvailable: boolean }>;
  save(workspace: Workspace, expectedRevision: number): Promise<Workspace>;
  restore(): Promise<Workspace>;
  migrateLegacy(): Promise<Workspace>;
  importWorkspace(): Promise<Workspace | null>;
  exportWorkspace(): Promise<boolean>;
  chooseDirectory(): Promise<string | null>;
}

function command<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri())
    return Promise.reject(
      new Error(t('请通过 pnpm start 启动 Scientify 桌面应用。浏览器预览没有本地数据访问能力。')),
    );
  return invoke<T>(name, args);
}

export const desktop: WorkspaceBackend = {
  load: () => command('workspace_load'),
  save: (workspace, expectedRevision) => command('workspace_save', { workspace, expectedRevision }),
  restore: () => command('workspace_restore'),
  migrateLegacy: () => command('workspace_migrate_legacy'),
  importWorkspace: () => command('workspace_import'),
  exportWorkspace: () => command('workspace_export'),
  chooseDirectory: () => command('choose_directory'),
};
