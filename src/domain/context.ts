export type WorkspaceId = 'overview' | 'literature' | 'notes' | 'experiments' | 'writing' | 'files';
export type WorkContext = {
  experimentId?: string;
  projectId?: string;
  workspace: WorkspaceId | 'projects';
  title: string;
  resourceId?: string;
  path?: string;
  workspaceRoot?: string;
  text?: string;
  selection?: string;
  page?: number;
  /** The open PDF, relative to the project's literature folder; the agent reads it with its paper tools. */
  paperPath?: string;
  browser?: { tabId: string; url: string };
  materials?: { path: string; title: string; text: string; truncated?: boolean }[];
  warnings?: string[];
};
