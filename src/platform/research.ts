import { Channel, invoke } from '@tauri-apps/api/core';
import type { AIProtocol } from '../domain/workspace';

export interface ResearchFile {
  path: string;
  name: string;
  kind: 'file' | 'directory';
  size: number;
}
export interface FileContent {
  path: string;
  content: string;
  version: string;
}
export interface ImportedPdf {
  assetId: string;
  fileName: string;
  size: number;
}
export interface GitChange {
  path: string;
  status: string;
  oldPath?: string;
}
export interface AIConnection {
  endpoint: string;
  apiKey?: string;
  provider: AIProtocol;
}
export type AIContentPart =
  { type: 'text'; text: string } | { type: 'image'; mimeType: string; data: string };
export type AIContent = string | AIContentPart[];
export interface AIModel {
  id: string;
  name: string;
}
export interface AIRequest extends AIConnection {
  model: string;
  messages: { role: 'system' | 'user' | 'assistant'; content: AIContent }[];
}
export interface ModelVerification {
  chat: boolean;
  agent: boolean;
  chatError?: string | null;
  agentError?: string | null;
}
export interface ChatResult {
  text: string;
  interrupted: boolean;
}
export interface ChatStream {
  result: Promise<ChatResult>;
  cancel(): Promise<void>;
}
export interface ResearchBackend {
  listFiles(projectId: string, workspaceRoot?: string): Promise<ResearchFile[]>;
  readFile(projectId: string, path: string, workspaceRoot?: string): Promise<FileContent>;
  writeFile(
    projectId: string,
    path: string,
    content: string,
    expectedVersion: string | null,
    workspaceRoot?: string,
  ): Promise<FileContent>;
  /** The bytes of a project file (images, PDFs); desktop only. */
  readBinary?(projectId: string, path: string, workspaceRoot?: string): Promise<Uint8Array>;
  /** Shows a project file in the system file manager; desktop only. */
  reveal?(projectId: string, path: string, workspaceRoot?: string): Promise<void>;
  /** Creates a folder in the project; returns its project-relative path. */
  createDirectory?(projectId: string, path: string, workspaceRoot?: string): Promise<string>;
  importPdf(): Promise<ImportedPdf | null>;
  readPdf(assetId: string): Promise<Uint8Array>;
  gitStatus(projectId: string): Promise<GitChange[]>;
  askAI(request: AIRequest): Promise<string>;
  listModels(request: AIConnection): Promise<AIModel[]>;
  testModel(request: AIConnection & { model: string }): Promise<void>;
  verifyModel?(request: AIConnection & { model: string }): Promise<ModelVerification>;
  streamAI?(request: AIRequest, onDelta: (text: string) => void): ChatStream;
}

export type FileBackend = Pick<ResearchBackend, 'readFile' | 'writeFile'>;
export type PdfBackend = Pick<ResearchBackend, 'readPdf'>;

export const nativeResearch: ResearchBackend = {
  listFiles: (projectId, workspaceRoot) =>
    invoke('research_list_files', { projectId, workspaceRoot }),
  readFile: (projectId, path, workspaceRoot) =>
    invoke('research_read_file', { projectId, path, workspaceRoot }),
  writeFile: (projectId, path, content, expectedVersion, workspaceRoot) =>
    invoke('research_write_file', { projectId, path, content, expectedVersion, workspaceRoot }),
  readBinary: async (projectId, path, workspaceRoot) =>
    new Uint8Array(
      await invoke<ArrayBuffer>('research_read_binary', { projectId, path, workspaceRoot }),
    ),
  reveal: (projectId, path, workspaceRoot) =>
    invoke('research_reveal', { projectId, path, workspaceRoot }),
  createDirectory: (projectId, path, workspaceRoot) =>
    invoke('research_create_directory', { projectId, path, workspaceRoot }),
  importPdf: () => invoke('research_import_pdf'),
  readPdf: async (assetId) =>
    new Uint8Array(await invoke<ArrayBuffer>('research_read_pdf', { assetId })),
  gitStatus: (projectId) => invoke('research_git_status', { projectId }),
  askAI: (request) => invoke('research_ask_ai', { request }),
  listModels: (request) => invoke('research_list_models', { request }),
  testModel: (request) => invoke('research_test_model', { request }),
  verifyModel: (request) => invoke('research_verify_model', { request }),
  streamAI: (request, onDelta) => {
    const requestId = crypto.randomUUID();
    let registered!: () => void;
    const ready = new Promise<void>((resolve) => {
      registered = resolve;
    });
    const channel = new Channel<{ type: 'ready' } | { type: 'delta'; text: string }>();
    channel.onmessage = (event) => {
      if (event.type === 'delta') onDelta(event.text);
      else registered();
    };
    const result = invoke<ChatResult>('research_chat_stream', { requestId, request, channel });
    return {
      result,
      cancel: async () => {
        // Cancellation must reach a registered request. A startup failure also
        // settles this wait and propagates instead of leaving Stop stuck.
        await Promise.race([ready, result]);
        await invoke<void>('research_chat_cancel', { requestId });
      },
    };
  },
};

/**
 * A project's places, kept apart: the literature folder (papers), the code
 * folder, the writing folder (manuscripts) and the AI workspace, where the
 * assistant leaves what it makes unless told otherwise.
 */
export type ProjectFolders = {
  literature: string | null;
  code: string;
  writing: string;
  workspace: string;
};

export const projectFolders = (projectId: string) =>
  invoke<ProjectFolders>('project_folders', { projectId });

/** The same backend, working in `root` unless a call names another folder. */
export function withWorkspaceRoot(backend: ResearchBackend, root: string): ResearchBackend {
  const { readBinary, reveal, createDirectory } = backend;
  return {
    ...backend,
    listFiles: (projectId, workspaceRoot) => backend.listFiles(projectId, workspaceRoot ?? root),
    readFile: (projectId, path, workspaceRoot) =>
      backend.readFile(projectId, path, workspaceRoot ?? root),
    writeFile: (projectId, path, content, expectedVersion, workspaceRoot) =>
      backend.writeFile(projectId, path, content, expectedVersion, workspaceRoot ?? root),
    readBinary:
      readBinary &&
      ((projectId, path, workspaceRoot) => readBinary(projectId, path, workspaceRoot ?? root)),
    reveal:
      reveal &&
      ((projectId, path, workspaceRoot) => reveal(projectId, path, workspaceRoot ?? root)),
    createDirectory:
      createDirectory &&
      ((projectId, path, workspaceRoot) => createDirectory(projectId, path, workspaceRoot ?? root)),
  };
}

/** Where a file lives among the project's folders, to preview it; null outside them. */
export const locateFile = (projectId: string, path: string) =>
  invoke<{ root: string; path: string } | null>('research_locate', { projectId, path });

/** Opens a project file with the system's program for it. */
export const openWithSystem = (projectId: string, path: string) =>
  invoke<void>('research_open_system', { projectId, path });
