import { invoke, isTauri } from '@tauri-apps/api/core';

export type CollaborationState = {
  clientId: string;
  enabled: boolean;
  endpoint: string;
  workspaceId: string | null;
  lastSyncAt: string | null;
  pendingChanges: number;
  conflicts: number;
  syncCursor: number;
  authenticated: boolean;
  userId: string | null;
  phone: string | null;
  literatureBootstrapped: boolean;
  /** Last server revision observed for each domain/entity pair. */
  entityRevisions: Record<string, number>;
};

export type CollaborationOperation = {
  operationId: string;
  clientId: string;
  projectId: string;
  domain: string;
  entityId: string;
  baseRevision: number;
  kind: string;
  payload: unknown;
  createdAt: string;
  status?: 'pending' | 'conflict';
  attemptCount?: number;
  conflictRevision?: number | null;
  lastError?: string | null;
};

export type CollaborationInboxChange = {
  operationId?: string;
  clientId?: string;
  domain?: string;
  entityId?: string;
  kind?: string;
  payload?: { path?: string; [key: string]: unknown };
  error?: string;
};

export type CollaborationProject = {
  id: string;
  name: string;
  ownerId?: string;
  role: 'owner' | 'editor' | 'reviewer' | 'viewer' | string;
  createdAt?: string;
  updatedAt?: string;
};

export type CollaborationMember = {
  id: string;
  phone: string;
  role: 'owner' | 'editor' | 'reviewer' | 'viewer' | string;
  createdAt?: string;
};

export const collaborationStateEvent = 'scientify-collaboration-state-changed';

/**
 * Keep entity IDs opaque and path-free while remaining stable across clients.
 * The original path/worktree stays in the operation payload where it can be
 * validated by the local file service.
 */
export function collaborationEntityId(value: string): string {
  return encodeURIComponent(value)
    .replace(/%/g, '_')
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .slice(0, 160);
}

export const collaboration = {
  status(): Promise<CollaborationState> {
    if (!isTauri()) return Promise.reject(new Error('协作设置只能在 Scientify 桌面应用中使用。'));
    return invoke<CollaborationState>('collaboration_status');
  },
  configure(endpoint: string, enabled: boolean): Promise<CollaborationState> {
    if (!isTauri()) return Promise.reject(new Error('协作设置只能在 Scientify 桌面应用中使用。'));
    return invoke<CollaborationState>('collaboration_configure', { endpoint, enabled });
  },
  enqueue(operation: CollaborationOperation): Promise<CollaborationState> {
    if (!isTauri()) return Promise.reject(new Error('协作设置只能在 Scientify 桌面应用中使用。'));
    return invoke<CollaborationState>('collaboration_enqueue', { operation });
  },
  outbox(): Promise<CollaborationOperation[]> {
    if (!isTauri()) return Promise.reject(new Error('协作设置只能在 Scientify 桌面应用中使用。'));
    return invoke<CollaborationOperation[]>('collaboration_outbox');
  },
  acknowledge(operationId: string): Promise<CollaborationState> {
    if (!isTauri()) return Promise.reject(new Error('协作设置只能在 Scientify 桌面应用中使用。'));
    return invoke<CollaborationState>('collaboration_acknowledge', { operationId });
  },
  retryConflict(operationId: string): Promise<CollaborationState> {
    if (!isTauri()) return Promise.reject(new Error('协作设置只能在 Scientify 桌面应用中使用。'));
    return invoke<CollaborationState>('collaboration_retry_conflict', { operationId });
  },
  markConflict(operationId: string, message: string): Promise<CollaborationState> {
    if (!isTauri()) return Promise.reject(new Error('协作设置只能在 Scientify 桌面应用中使用。'));
    return invoke<CollaborationState>('collaboration_mark_conflict', { operationId, message });
  },
  health(endpoint: string): Promise<unknown> {
    if (!isTauri()) return Promise.reject(new Error('协作设置只能在 Scientify 桌面应用中使用。'));
    return invoke('collaboration_health', { endpoint });
  },
  sendCode(endpoint: string, phone: string): Promise<unknown> {
    if (!isTauri()) return Promise.reject(new Error('协作设置只能在 Scientify 桌面应用中使用。'));
    return invoke('collaboration_send_code', { endpoint, phone });
  },
  login(endpoint: string, phone: string, code: string): Promise<CollaborationState> {
    if (!isTauri()) return Promise.reject(new Error('协作设置只能在 Scientify 桌面应用中使用。'));
    return invoke<CollaborationState>('collaboration_login', { endpoint, phone, code });
  },
  logout(): Promise<CollaborationState> {
    if (!isTauri()) return Promise.reject(new Error('协作设置只能在 Scientify 桌面应用中使用。'));
    return invoke<CollaborationState>('collaboration_logout');
  },
  accessToken(): Promise<string> {
    if (!isTauri()) return Promise.reject(new Error('官方模型只能在 Scientify 桌面应用中使用。'));
    return invoke<string>('collaboration_access_token');
  },
  projects(): Promise<{ projects: CollaborationProject[] }> {
    if (!isTauri()) return Promise.reject(new Error('协作设置只能在 Scientify 桌面应用中使用。'));
    return invoke<{ projects: CollaborationProject[] }>('collaboration_projects');
  },
  createProject(name: string): Promise<CollaborationProject> {
    if (!isTauri()) return Promise.reject(new Error('协作项目只能在 Scientify 桌面应用中创建。'));
    return invoke<CollaborationProject>('collaboration_create_project', { name });
  },
  members(projectId: string): Promise<{ members: CollaborationMember[] }> {
    if (!isTauri()) return Promise.reject(new Error('项目成员只能在 Scientify 桌面应用中查看。'));
    return invoke<{ members: CollaborationMember[] }>('collaboration_project_members', {
      projectId,
    });
  },
  inviteMember(
    projectId: string,
    phone: string,
    role: 'editor' | 'reviewer' | 'viewer',
  ): Promise<{ ok: true }> {
    if (!isTauri()) return Promise.reject(new Error('项目成员只能在 Scientify 桌面应用中邀请。'));
    return invoke<{ ok: true }>('collaboration_invite_member', { projectId, phone, role });
  },
  bindProject(projectId: string): Promise<CollaborationState> {
    if (!isTauri()) return Promise.reject(new Error('协作设置只能在 Scientify 桌面应用中使用。'));
    return invoke<CollaborationState>('collaboration_bind_project', { projectId });
  },
  bootstrapLiterature(
    projectId: string,
  ): Promise<{ uploaded: number; queued: number; skipped: number; complete: boolean }> {
    if (!isTauri()) return Promise.reject(new Error('文献同步只能在 Scientify 桌面应用中使用。'));
    return invoke('collaboration_bootstrap_literature', { projectId });
  },
  sync(): Promise<CollaborationState> {
    if (!isTauri()) return Promise.reject(new Error('协作设置只能在 Scientify 桌面应用中使用。'));
    return invoke<CollaborationState>('collaboration_sync');
  },
  inbox(): Promise<CollaborationInboxChange[]> {
    if (!isTauri()) return Promise.reject(new Error('协作变更只能在 Scientify 桌面应用中读取。'));
    return invoke<CollaborationInboxChange[]>('collaboration_inbox');
  },
  discardInbox(operationId: string): Promise<CollaborationState> {
    if (!isTauri()) return Promise.reject(new Error('协作变更只能在 Scientify 桌面应用中处理。'));
    return invoke<CollaborationState>('collaboration_discard_inbox', { operationId });
  },
  applyInbox(
    projectId: string,
    domain?: 'literature' | 'code',
  ): Promise<{ applied: number; deferred: number }> {
    if (!isTauri()) return Promise.reject(new Error('协作变更只能在 Scientify 桌面应用中应用。'));
    return invoke('collaboration_apply_inbox', domain ? { projectId, domain } : { projectId });
  },
  uploadFile(projectId: string, path: string): Promise<unknown> {
    if (!isTauri())
      return Promise.reject(new Error('协作文件上传只能在 Scientify 桌面应用中使用。'));
    return invoke('collaboration_upload_file', { projectId, path });
  },
  async uploadFileIfEnabled(projectId: string, path: string): Promise<unknown | null> {
    if (!isTauri()) return null;
    const current = await invoke<CollaborationState>('collaboration_status');
    if (!current.enabled || !current.authenticated || !current.workspaceId) return null;
    return invoke('collaboration_upload_file', { projectId, path });
  },
  downloadBlob(projectId: string, blobId: string, path: string): Promise<void> {
    if (!isTauri())
      return Promise.reject(new Error('协作文件下载只能在 Scientify 桌面应用中使用。'));
    return invoke('collaboration_download_blob', { projectId, blobId, path });
  },
  deleteBlob(blobId: string): Promise<unknown> {
    if (!isTauri())
      return Promise.reject(new Error('协作文件删除只能在 Scientify 桌面应用中使用。'));
    return invoke('collaboration_delete_blob', { blobId });
  },
  /** Queue a local mutation only when the user has bound a remote project. */
  async enqueueIfEnabled(
    input: Omit<CollaborationOperation, 'projectId' | 'clientId'> & { projectId?: string },
  ): Promise<void> {
    if (!isTauri()) return;
    const current = await invoke<CollaborationState>('collaboration_status');
    if (!current.enabled || !current.authenticated || !current.workspaceId) return;
    const revisionKey = `${input.domain}:${input.entityId}`;
    await invoke<CollaborationState>('collaboration_enqueue', {
      operation: {
        ...input,
        projectId: current.workspaceId,
        clientId: current.clientId,
        baseRevision: current.entityRevisions?.[revisionKey] ?? input.baseRevision,
      },
    });
  },
};
