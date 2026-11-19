import type { WorkspaceId } from '../../domain/context';

export const secondaryViews: Record<WorkspaceId, { id: string; label: string }[]> = {
  overview: [],
  literature: [{ id: 'local', label: 'Library' }],
  notes: [],
  // The workbench is one view; the others are where older links land (a tab or a side view).
  experiments: [
    { id: 'files', label: 'Code' },
    { id: 'versions', label: 'Git' },
    { id: 'runs', label: 'Runs' },
  ],
  writing: [{ id: 'files', label: 'Manuscript' }],
  remote: [],
  files: [{ id: 'files', label: 'All files' }],
};
