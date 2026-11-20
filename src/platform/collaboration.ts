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

export type SignInMode = 'code' | 'password' | 'register' | 'reset';

export type CollaborationMember = {
  id: string;
  phone: string;
  /** The name the member chose; empty until they set one. */
  name?: string;
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
  paused?: boolean;
  syncing?: boolean;
  pending?: number | null;
  skipped?: number;
  deferred?: number;
  lastSyncAt: string | null;
  lastError: string | null;
  conflicts: SyncConflict[];
  tracked: number;
  libraryRoot: string | null;
};

export type ConflictVersion = {
  text: string | null;
  bytes: number;
  exists: boolean;
  truncated: boolean;
};
export type ConflictPreview = {
  token: string;
  local: ConflictVersion;
  remote: ConflictVersion;
  canKeepLocal: boolean;
  canKeepBoth: boolean;
};
export type ConflictChoice = 'local' | 'remote' | 'both';

/** The account's plan and points for the official models, from the server. */
export type BillingSummary = {
  plan: {
    id: string;
    name: string;
    monthlyPoints: number;
    storageBytes: number;
    maxMembers: number | null;
    historyDays: number;
  };
  subscription: { startsAt: string; endsAt: string; source: string } | null;
  period: { start: string; end: string };
  balance: number;
  debt: number;
  usedThisPeriod: number;
  usedToday: number;
  limits: { dailyPoints: number; rpm: number; concurrency: number };
  grants: {
    id: string;
    source: string;
    label: string;
    note: string;
    points: number;
    left: number;
    startsAt: string;
    expiresAt: string;
  }[];
  storage: { usedBytes: number; limitBytes: number };
};

export type BillingUsage = {
  days: { day: string; points: number; models: Record<string, number> }[];
  models: { id: string; points: number; requests: number }[];
};

export type RedeemResult =
  | { kind: 'points'; points: number }
  | { kind: 'plan'; plan: string; months: number; endsAt: string };

export type ModelDevice = {
  id: string;
  deviceId: string;
  deviceName: string;
  createdAt: string;
  lastUsedAt: string | null;
  current: boolean;
};

/** Error codes the official model gateway answers with, found in an error message. */
export const officialModelProblems = {
  quota_exhausted: '官方模型额度已用完',
  daily_limit: '今天的用量已到单日上限',
  model_not_in_plan: '当前套餐不包含这个模型',
  rate_limited: '请求太频繁',
  account_disabled: '账号已停用',
  model_token_invalid: '官方模型令牌已失效',
} as const;
export type OfficialModelProblem = keyof typeof officialModelProblems;

export function officialModelProblem(
  message: string | undefined | null,
): OfficialModelProblem | null {
  if (!message) return null;
  for (const code of Object.keys(officialModelProblems) as OfficialModelProblem[])
    if (message.includes(code)) return code;
  return null;
}

export function canEditProject(
  project: { collaborationRole?: unknown } | undefined,
  domain = 'project',
): boolean {
  const role = project?.collaborationRole;
  return (
    !role || role === 'owner' || role === 'editor' || (role === 'reviewer' && domain === 'record')
  );
}

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

/**
 * The server ended this device's session (a new password, a forced sign-out, a disabled
 * account). The app has signed out locally and asks to sign in again.
 */
export const sessionEnded = '登录已失效，请重新登录。';

function desktop<T>(message: string, command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) return Promise.reject(new Error(message));
  return invoke<T>(command, args).catch((reason: unknown) => {
    // Every page that shows the account picks up the sign-out at once.
    if (String(reason).includes(sessionEnded) && typeof window !== 'undefined')
      window.dispatchEvent(new Event(collaborationStateEvent));
    throw reason;
  });
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
  /** Sign in by SMS code or password, register, or reset the password; each ends signed in. */
  signIn(
    endpoint: string,
    mode: SignInMode,
    phone: string,
    secrets: { code?: string; password?: string },
  ): Promise<CollaborationState> {
    return desktop(settingsOnly, 'collaboration_sign_in', {
      endpoint,
      mode,
      phone,
      code: secrets.code ?? null,
      password: secrets.password ?? null,
    });
  },
  account(): Promise<{ id: string; phone: string; name?: string; hasPassword?: boolean }> {
    return desktop(settingsOnly, 'collaboration_account');
  },
  setName(name: string): Promise<{ id: string; phone: string; name: string }> {
    return desktop(settingsOnly, 'collaboration_set_name', { name });
  },
  logout(): Promise<CollaborationState> {
    return desktop(settingsOnly, 'collaboration_logout');
  },
  accessToken(): Promise<string> {
    return desktop('官方模型只能在 Scientify 桌面应用中使用。', 'collaboration_access_token');
  },
  /** This device's token for the official models; `renew` replaces a revoked one. */
  modelToken(renew = false): Promise<string> {
    return desktop('官方模型只能在 Scientify 桌面应用中使用。', 'collaboration_model_token', {
      renew,
    });
  },
  billing(): Promise<BillingSummary> {
    return desktop(settingsOnly, 'collaboration_billing');
  },
  billingUsage(days = 30): Promise<BillingUsage> {
    return desktop(settingsOnly, 'collaboration_billing_usage', { days });
  },
  redeem(code: string): Promise<{ ok: true; result: RedeemResult }> {
    return desktop(settingsOnly, 'collaboration_redeem', { code });
  },
  devices(): Promise<{ devices: ModelDevice[] }> {
    return desktop(settingsOnly, 'collaboration_devices');
  },
  revokeDevice(id: string): Promise<{ ok: true }> {
    return desktop(settingsOnly, 'collaboration_revoke_device', { id });
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
  setProjectSync(projectId: string, enabled: boolean): Promise<void> {
    return desktop(settingsOnly, 'collaboration_set_project_sync', { projectId, enabled });
  },
  conflictPreview(projectId: string, conflict: SyncConflict): Promise<ConflictPreview> {
    return desktop(settingsOnly, 'collaboration_conflict_preview', { projectId, conflict });
  },
  resolveConflict(
    projectId: string,
    conflict: SyncConflict,
    token: string,
    choice: ConflictChoice,
  ): Promise<void> {
    return desktop(settingsOnly, 'collaboration_resolve_conflict', {
      projectId,
      conflict,
      token,
      choice,
    });
  },
};
