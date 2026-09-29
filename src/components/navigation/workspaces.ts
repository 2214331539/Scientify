import { BookOpen, FlaskConical, House, NotebookPen, PenLine } from 'lucide-react';
import type { WorkspaceId } from '../../domain/context';

export const workspaceItems = [
  { id: 'overview', label: 'Overview', icon: House },
  { id: 'literature', label: 'Literature', icon: BookOpen },
  { id: 'notes', label: 'Notes', icon: NotebookPen },
  { id: 'experiments', label: 'Experiments', icon: FlaskConical },
  { id: 'writing', label: 'Paper', icon: PenLine },
] as const;

export const secondaryViews: Record<WorkspaceId, { id: string; label: string }[]> = {
  overview: [],
  literature: [
    { id: 'local', label: 'Library' },
    { id: 'subscriptions', label: 'Subscriptions' },
  ],
  notes: [],
  experiments: [
    { id: 'files', label: 'Code' },
    { id: 'runs', label: 'Runs' },
    { id: 'versions', label: 'Changes' },
  ],
  writing: [
    { id: 'files', label: 'Manuscript' },
    { id: 'references', label: 'References' },
  ],
  files: [{ id: 'files', label: 'All files' }],
};
