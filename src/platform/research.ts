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
