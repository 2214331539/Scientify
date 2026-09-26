import { invoke } from '@tauri-apps/api/core';

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
}
export interface AIRequest {
  endpoint: string;
  model: string;
  apiKey?: string;
  provider: 'ollama' | 'openai';
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
}
export interface ResearchBackend {
  listFiles(projectId: string): Promise<ResearchFile[]>;
  readFile(projectId: string, path: string): Promise<FileContent>;
  writeFile(
    projectId: string,
    path: string,
    content: string,
    expectedVersion: string | null,
  ): Promise<FileContent>;
  importPdf(): Promise<ImportedPdf | null>;
  readPdf(assetId: string): Promise<Uint8Array>;
  gitStatus(projectId: string): Promise<GitChange[]>;
  askAI(request: AIRequest): Promise<string>;
  fetchArxiv(query: string): Promise<string>;
}

export const nativeResearch: ResearchBackend = {
  listFiles: (projectId) => invoke('research_list_files', { projectId }),
  readFile: (projectId, path) => invoke('research_read_file', { projectId, path }),
  writeFile: (projectId, path, content, expectedVersion) =>
    invoke('research_write_file', { projectId, path, content, expectedVersion }),
  importPdf: () => invoke('research_import_pdf'),
  readPdf: async (assetId) =>
    new Uint8Array(await invoke<ArrayBuffer>('research_read_pdf', { assetId })),
  gitStatus: (projectId) => invoke('research_git_status', { projectId }),
  askAI: (request) => invoke('research_ask_ai', { request }),
  fetchArxiv: (query) => invoke('research_fetch_arxiv', { query }),
};
