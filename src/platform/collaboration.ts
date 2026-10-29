import { invoke, isTauri } from '@tauri-apps/api/core';

export type CollaborationState = {
  enabled: boolean;
  endpoint: string;
  workspaceId: string | null;
  lastSyncAt: string | null;
  pendingChanges: number;
  conflicts: number;
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
};
