import { invoke, isTauri } from '@tauri-apps/api/core';
import type { WorkspaceId } from '../domain/context';
import type { AIProtocol } from './research';

/**
 * Operation domains. A domain is a permission boundary defined by a root
 * directory, so it deliberately does not match the six navigation entries:
 * Code, Manuscript and All files all edit the same project root.
 */
export type AgentDomain = 'literature' | 'code';

export interface EngineStatus {
  available: boolean;
  enginePath: string | null;
  version: string | null;
}

export interface EngineHandshake {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
}

export interface DomainBinding {
  domain: AgentDomain;
  root: string | null;
  available: boolean;
  reason: string | null;
}

export interface ThreadHandle {
  threadId: string;
  domain: AgentDomain;
  projectId: string;
  cwd: string;
  model: string;
  modelProvider: string;
  /** Instruction files the engine actually loaded, such as an `AGENTS.md`. */
  instructionSources: string[];
  /** Effective Codex sandbox. `readOnly` means Windows setup is pending. */
  sandbox?: string;
}

export interface SandboxSetupHandle {
  started: boolean;
  status: string;
}

export interface TurnHandle {
  turnId: string;
  status: string;
  /** Messages raised while starting the turn, typically approval requests. */
  events: AgentEvent[];
}

/** Model service settings handed to the engine when a thread starts. */
export interface AgentConnection {
  endpoint: string;
  model: string;
  provider: AIProtocol;
  apiKey?: string;
}

/**
 * Protocols the built-in engine can drive.
 *
 * The engine speaks the OpenAI Responses wire format only, so Anthropic and
 * Gemini need a translating proxy before they can be used here. Exposing the
 * list lets the panel explain that instead of failing at request time.
 */
export const ENGINE_PROTOCOLS: readonly AIProtocol[] = ['openai', 'ollama'];

export const engineSupports = (protocol: AIProtocol) => ENGINE_PROTOCOLS.includes(protocol);

/**
 * Messages the engine raises outside a response.
 *
 * `request` must be answered or the turn blocks; `notification` is one-way.
 */
export type AgentEvent =
  | { kind: 'notification'; method: string; params: unknown }
  | { kind: 'request'; id: string | number; method: string; params: unknown };

/** Requests that must be answered before the engine continues. */
export const APPROVAL_METHODS = [
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
] as const;

export type ApprovalMethod = (typeof APPROVAL_METHODS)[number];
export type ApprovalRequest = Extract<AgentEvent, { kind: 'request' }> & {
  method: ApprovalMethod;
};

export function isApprovalRequest(event: AgentEvent): event is ApprovalRequest {
  return event.kind === 'request' && (APPROVAL_METHODS as readonly string[]).includes(event.method);
}

/**
 * Decision vocabulary for command and file-change approvals. The engine rejects
 * the older "approved" wording, and `cancel` differs from `decline`: it aborts
 * rather than refusing this one action.
 */
export type ApprovalDecision =
  | 'accept'
  | 'acceptForSession'
  | 'decline'
  | 'cancel'
  | 'grantPermissions'
  | 'denyPermissions';

export function approvalResult(
  decision: ApprovalDecision,
  approval?: ApprovalRequest,
): Record<string, unknown> {
  if (decision === 'grantPermissions' || decision === 'denyPermissions') {
    const params = (approval?.params ?? {}) as { permissions?: unknown };
    return {
      permissions: decision === 'grantPermissions' ? (params.permissions ?? {}) : {},
      scope: 'turn',
    };
  }
  return { decision };
}

export interface AgentBackend {
  status(): Promise<EngineStatus>;
  handshake(): Promise<EngineHandshake>;
  domains(projectId: string): Promise<DomainBinding[]>;
  startThread(
    projectId: string,
    domain: AgentDomain,
    connection: AgentConnection,
  ): Promise<ThreadHandle>;
  /** Start Codex's explicit Windows sandbox installer/elevation flow. */
  setupSandbox?(
    projectId: string,
    domain: AgentDomain,
    connection: AgentConnection,
  ): Promise<SandboxSetupHandle>;
  startTurn(request: {
    projectId: string;
    domain: AgentDomain;
    threadId: string;
    text: string;
  }): Promise<TurnHandle>;
  interrupt?(request: { projectId: string; domain: AgentDomain; threadId: string }): Promise<void>;
  events(projectId: string, domain: AgentDomain): Promise<AgentEvent[]>;
  respond(request: {
    projectId: string;
    domain: AgentDomain;
    id: string | number;
    result: Record<string, unknown>;
  }): Promise<void>;
}

/**
 * Which domain a navigation entry defaults to, or null when the entry has no
 * root of its own and must keep the previous binding.
 */
export function domainForWorkspace(workspace: WorkspaceId | 'projects'): AgentDomain | null {
  if (workspace === 'literature') return 'literature';
  if (workspace === 'experiments' || workspace === 'writing' || workspace === 'files')
    return 'code';
  return null;
}

function command<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) {
    return Promise.reject(
      new Error('请通过 pnpm start 启动 Scientify 桌面应用。浏览器预览没有内置 Agent 引擎。'),
    );
  }
  return invoke<T>(name, args);
}

export const nativeAgent: AgentBackend = {
  status: () => command('agent_status'),
  handshake: () => command('agent_handshake'),
  domains: (projectId) => command('agent_domains', { projectId }),
  startThread: (projectId, domain, connection) =>
    command('agent_start_thread', { projectId, domain, connection }),
  setupSandbox: (projectId, domain, connection) =>
    command('agent_windows_sandbox_setup', { projectId, domain, connection }),
  startTurn: ({ projectId, domain, threadId, text }) =>
    command('agent_start_turn', { projectId, domain, threadId, text }),
  interrupt: ({ projectId, domain, threadId }) =>
    command('agent_interrupt', { projectId, domain, threadId }),
  events: (projectId, domain) => command('agent_events', { projectId, domain }),
  respond: ({ projectId, domain, id, result }) =>
    command('agent_respond', { projectId, domain, id, result }),
};
