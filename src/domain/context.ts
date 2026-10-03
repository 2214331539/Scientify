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
};
