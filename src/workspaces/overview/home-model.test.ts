import { t } from '../../i18n';
import { expect, it } from 'vitest';
import { emptyWorkspace } from '../../domain/workspace';
import { buildResearchHome } from './home-model';

it('continues the selected project paper even after a newer paper was collected', () => {
  const data = emptyWorkspace();
  data.papers.push(
    { id: 'reading', title: 'Reading', projects: ['p'], createdAt: '2026-09-01' },
    { id: 'new', title: 'New import', projects: ['p'], createdAt: '2026-09-24' },
    { id: 'foreign', title: 'Other project', projects: ['other'], createdAt: '2026-09-25' },
  );
  expect(buildResearchHome(data, 'p', {}, 'reading').continued[0].target.paperId).toBe('reading');
  expect(buildResearchHome(data, 'p', {}, 'foreign').continued[0].target.paperId).toBe('new');
});

it('resumes actual project resources without inventing work or file edit activity', () => {
  const data = emptyWorkspace();
  expect(buildResearchHome(data, 'project')).toEqual({ continued: [], activity: [], tasks: [] });
  data.papers.push(
    { id: 'own', title: 'Current paper', projects: ['project'], createdAt: '2026-09-20T12:00:00Z' },
    { id: 'other', title: 'Private paper', projects: ['other'], createdAt: '2026-09-24T12:00:00Z' },
  );
  data.records.push({
    id: 'note',
    project: 'project',
    title: 'A result',
    body: '',
    type: 'note',
    status: 'draft',
    createdAt: '2026-09-20T12:00:00Z',
    updatedAt: '2026-09-22T12:00:00Z',
  });
  const home = buildResearchHome(data, 'project', {
    writing: 'paper/draft.md',
    experiments: 'experiments/train.py',
    files: 'paper/draft.md',
  });
  expect(home.continued.map((item) => item.target)).toEqual([
    { workspace: 'writing', path: 'paper/draft.md' },
    { workspace: 'experiments', path: 'experiments/train.py' },
    { workspace: 'literature', paperId: 'own' },
    { workspace: 'notes', noteId: 'note' },
  ]);
  expect(home.activity.map((item) => item.title)).toEqual(['A result', 'Current paper']);
  expect(home.activity.map((item) => item.action)).toEqual([t('Modified note'), t('Added paper')]);
});

it('sorts recorded instants across time zones and omits undated or invalid activity', () => {
  const data = emptyWorkspace();
  data.papers.push(
    {
      id: 'older',
      title: 'Earlier',
      projects: ['project'],
      createdAt: '2026-09-24T09:00:00+08:00',
    },
    { id: 'newer', title: 'Later', projects: ['project'], createdAt: '2026-09-24T03:00:00Z' },
    { id: 'invalid', title: 'Undated', projects: ['project'], createdAt: 'invalid' },
  );
  data.runs.push({ id: 'run', project: 'project', name: 'Manual evaluation', status: 'running' });
  const home = buildResearchHome(data, 'project');
  expect(home.activity.map((item) => item.title)).toEqual(['Later', 'Earlier']);
  expect(home.continued.find((item) => item.module === t('Literature'))?.target.paperId).toBe(
    'newer',
  );
  expect(home.continued.find((item) => item.module === t('Experiments'))).toMatchObject({
    detail: '手动记录 · 进行中',
    target: { workspace: 'experiments', runId: 'run' },
  });
});

it('uses a valid creation date when update data is malformed and retains project tasks', () => {
  const data = emptyWorkspace();
  data.papers.push({
    id: 'paper',
    title: t('Paper'),
    projects: ['project'],
    createdAt: '2026-09-20T12:00:00Z',
    updatedAt: { invalid: true },
  });
  data.tasks.push(
    { id: 'own', project: 'project', title: 'Validate result' },
    { id: 'other', project: 'other', title: 'Other next step' },
  );
  const home = buildResearchHome(data, 'project');
  expect(home.activity[0]).toMatchObject({
    action: t('Added paper'),
    timestamp: '2026-09-20T12:00:00Z',
  });
  expect(home.tasks.map((task) => task.id)).toEqual(['own']);
});
