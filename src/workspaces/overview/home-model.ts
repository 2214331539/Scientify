import { t } from '../../i18n';
import type { WorkspaceId } from '../../domain/context';
import type { Entity, Workspace } from '../../domain/workspace';

export type ResumeTarget = {
  workspace: WorkspaceId;
  path?: string;
  paperId?: string;
  runId?: string;
  noteId?: string;
};
export type ContinueItem = {
  id: string;
  module: string;
  title: string;
  detail: string;
  target: ResumeTarget;
};
export type ActivityItem = {
  id: string;
  action: string;
  title: string;
  timestamp: string;
  target: ResumeTarget;
};
const text = (value: unknown) => (typeof value === 'string' ? value : '');
const validTime = (value: unknown) => {
  const timestamp = text(value);
  return timestamp && Number.isFinite(Date.parse(timestamp)) ? timestamp : '';
};
const latestTime = (entity: Entity) =>
  [validTime(entity.updatedAt), validTime(entity.createdAt)]
    .filter(Boolean)
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? '';
const byRecent = (a: Entity, b: Entity) =>
  (Date.parse(latestTime(b)) || 0) - (Date.parse(latestTime(a)) || 0);
const fileName = (path: string) => path.split(/[\\/]/).pop() || path;
const runStates: Record<string, string> = {
  planned: '计划中',
  running: '进行中',
  completed: '已完成',
  failed: '未成功',
};

export function buildResearchHome(
  data: Workspace,
  projectId: string,
  paths: Partial<Record<WorkspaceId, string | null>> = {},
  selectedPaperId?: string | null,
) {
  const papers = data.papers.filter((paper) => paper.projects.includes(projectId)).sort(byRecent);
  const notes = data.records.filter((note) => note.project === projectId).sort(byRecent);
  const runs = data.runs.filter((run) => run.project === projectId).sort(byRecent);
  const continued: ContinueItem[] = [];
  const addFile = (workspace: WorkspaceId, module: string) => {
    const path = paths[workspace];
    if (path && !continued.some((item) => item.target.path === path))
      continued.push({
        id: `${workspace}:${path}`,
        module,
        title: fileName(path),
        detail: path,
        target: { workspace, path },
      });
  };
  addFile('writing', t('Paper'));
  addFile('experiments', t('Experiments'));
  if (!paths.experiments && runs[0]) {
    const run = runs[0];
    const status = t(runStates[text(run.status)] ?? text(run.status));
    continued.push({
      id: `run:${run.id}`,
      module: t('Experiments'),
      title: text(run.name) || t('未命名实验'),
      detail: status ? t('手动记录 · {status}', { status }) : t('实验记录'),
      target: { workspace: 'experiments', runId: run.id },
    });
  }
  const resumePaper = papers.find((paper) => paper.id === selectedPaperId) ?? papers[0];
  if (resumePaper)
    continued.push({
      id: `paper:${resumePaper.id}`,
      module: t('Literature'),
      title: resumePaper.title || t('未命名文献'),
      detail: [t(text(resumePaper.status)), t('{count} 篇文献', { count: papers.length })]
        .filter(Boolean)
        .join(' · '),
      target: { workspace: 'literature', paperId: resumePaper.id },
    });
  if (notes[0])
    continued.push({
      id: `note:${notes[0].id}`,
      module: t('Notes'),
      title: notes[0].title || t('未命名笔记'),
      detail: t('{count} 篇笔记', { count: notes.length }),
      target: { workspace: 'notes', noteId: notes[0].id },
    });
  const activity: ActivityItem[] = [];
  const addActivity = (
    entity: Entity,
    kind: string,
    title: string,
    addedLabel: string,
    updatedLabel: string,
    target: ResumeTarget,
  ) => {
    const timestamp = latestTime(entity);
    if (!timestamp) return;
    const created = validTime(entity.createdAt);
    const updated = validTime(entity.updatedAt);
    const isUpdate = updated && (!created || Date.parse(updated) > Date.parse(created));
    activity.push({
      id: `${kind}:${entity.id}`,
      action: isUpdate ? updatedLabel : addedLabel,
      title,
      timestamp,
      target,
    });
  };
  for (const paper of papers)
    addActivity(
      paper,
      'paper',
      paper.title || t('未命名文献'),
      t('Added paper'),
      t('Updated paper'),
      {
        workspace: 'literature',
        paperId: paper.id,
      },
    );
  for (const note of notes)
    addActivity(
      note,
      'note',
      note.title || t('未命名笔记'),
      t('Created note'),
      t('Modified note'),
      {
        workspace: 'notes',
        noteId: note.id,
      },
    );
  for (const run of runs)
    addActivity(
      run,
      'run',
      text(run.name) || t('未命名实验'),
      t('Recorded experiment'),
      t('Updated experiment'),
      {
        workspace: 'experiments',
        runId: run.id,
      },
    );
  return {
    continued,
    activity: activity
      .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
      .slice(0, 8),
    tasks: data.tasks.filter((task) => task.project === projectId),
  };
}
