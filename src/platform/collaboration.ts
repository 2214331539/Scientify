import { invoke, isTauri } from '@tauri-apps/api/core';

export type CollaborationState = {
  clientId: string;
  enabled: boolean;
  endpoint: string;
  authenticated: boolean;
  userId: string | null;
  phone: string | null;
};

export type CollaborationRole = 'owner' | 'editor' | 'reviewer' | 'viewer';

export type CollaborationProject = {
  id: string;
  name: string;
  ownerId?: string;
  role: CollaborationRole | string;
  createdAt?: string;
  updatedAt?: string;
  /** Latest server change number; above a device's cursor means there is news. */
  changeSeq?: number;
};

export type CollaborationMember = {
  id: string;
  phone: string;
  role: CollaborationRole | string;
  createdAt?: string;
  pending?: boolean;
};

/** The result of one project sync. */
export type SyncOutcome = {
  pulled: number;
  applied: number;
  pushed: number;
  conflicts: number;
  skipped: number;
  deferred: number;
  errors: string[];
  /** Kinds of content that changed on this device: library, code, asset, record, … */
  changed: string[];
  libraryRoot: string | null;
  lastSyncAt: string;
};

export type SyncConflict = {
  domain: string;
  path: string;
  /** Where this device's version was kept; empty when the remote version won. */
  copy: string;
  at: string;
};

export type ProjectSyncState = {
  lastSyncAt: string | null;
  lastError: string | null;
  conflicts: SyncConflict[];
  tracked: number;
  libraryRoot: string | null;
};

export const collaborationStateEvent = 'scientify-collaboration-state-changed';
export const projectSyncRequestEvent = 'scientify-project-sync-request';

/**
 * Ask the open window to sync a project soon. Sync finds changes by scanning
 * the project, so saves only need to say that something changed.
 */
export function requestProjectSync(projectId: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(projectSyncRequestEvent, { detail: { projectId } }));
}

/** Projects that sync carry the member's role; personal projects have none. */
export function isSyncedProject(project: object | undefined): boolean {
  const role = (project as { collaborationRole?: unknown } | undefined)?.collaborationRole;
  return typeof role === 'string' && role.length > 0;
}

function desktop<T>(message: string, command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) return Promise.reject(new Error(message));
  return invoke<T>(command, args);
}

const settingsOnly = '协作设置只能在 Scientify 桌面应用中使用。';

export const collaboration = {
  status(): Promise<CollaborationState> {
    return desktop(settingsOnly, 'collaboration_status');
  },
  configure(endpoint: string, enabled: boolean): Promise<CollaborationState> {
    return desktop(settingsOnly, 'collaboration_configure', { endpoint, enabled });
  },
  health(endpoint: string): Promise<unknown> {
    return desktop(settingsOnly, 'collaboration_health', { endpoint });
  },
  sendCode(endpoint: string, phone: string): Promise<unknown> {
    return desktop(settingsOnly, 'collaboration_send_code', { endpoint, phone });
  },
  login(endpoint: string, phone: string, code: string): Promise<CollaborationState> {
    return desktop(settingsOnly, 'collaboration_login', { endpoint, phone, code });
  },
  logout(): Promise<CollaborationState> {
    return desktop(settingsOnly, 'collaboration_logout');
  },
  accessToken(): Promise<string> {
    return desktop('官方模型只能在 Scientify 桌面应用中使用。', 'collaboration_access_token');
  },
  projects(): Promise<{ projects: CollaborationProject[] }> {
    return desktop(settingsOnly, 'collaboration_projects');
  },
  /** Create a cloud project; pass a local project's id to publish that project. */
  createProject(name: string, projectId?: string): Promise<CollaborationProject> {
    return desktop(
      '协作项目只能在 Scientify 桌面应用中创建。',
      'collaboration_create_project',
      projectId ? { name, projectId } : { name },
    );
  },
  members(projectId: string): Promise<{ members: CollaborationMember[] }> {
    return desktop('项目成员只能在 Scientify 桌面应用中查看。', 'collaboration_project_members', {
      projectId,
    });
  },
  inviteMember(
    projectId: string,
    phone: string,
    role: 'editor' | 'reviewer' | 'viewer',
  ): Promise<{ ok: true }> {
    return desktop('项目成员只能在 Scientify 桌面应用中邀请。', 'collaboration_invite_member', {
      projectId,
      phone,
      role,
    });
  },
  /** Remove a member or pending invitation (`invite:<phone>`); members may remove themselves. */
  removeMember(projectId: string, memberId: string): Promise<{ ok: true }> {
    return desktop('项目成员只能在 Scientify 桌面应用中管理。', 'collaboration_remove_member', {
      projectId,
      memberId,
    });
  },
  /** Bring one synced project up to date with the server in both directions. */
  syncProject(projectId: string): Promise<SyncOutcome> {
    return desktop('项目同步只能在 Scientify 桌面应用中使用。', 'collaboration_sync_project', {
      projectId,
    });
  },
  syncState(projectId: string): Promise<ProjectSyncState> {
    return desktop('项目同步只能在 Scientify 桌面应用中使用。', 'collaboration_sync_state', {
      projectId,
    });
  },
};
