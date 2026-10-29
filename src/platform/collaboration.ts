import { invoke, isTauri } from '@tauri-apps/api/core';

export type CollaborationState = {
  clientId: string;
  enabled: boolean;
  endpoint: string;
  workspaceId: string | null;
  lastSyncAt: string | null;
  pendingChanges: number;
  conflicts: number;
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
  lastError?: string | null;
};

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
  markConflict(operationId: string, message: string): Promise<CollaborationState> {
    if (!isTauri()) return Promise.reject(new Error('协作设置只能在 Scientify 桌面应用中使用。'));
    return invoke<CollaborationState>('collaboration_mark_conflict', { operationId, message });
  },
};
