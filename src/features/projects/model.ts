import type { Workspace, Project } from '../../domain/workspace';
import { isSyncedProject } from '../../platform/collaboration';
import { locale, t } from '../../i18n';

/** Local space of projects that are shared with other people. */
export const COLLABORATION_TEAM_ID = 'scientify-collaboration';

export type CenterPage = 'mine' | 'team';
export const CENTER_PAGES: CenterPage[] = ['mine', 'team'];
export type ProjectFilter = 'all' | 'archived';
export type ProjectSort = 'opened' | 'updated' | 'name' | 'created';

/** Removing a project only changes workspace records; referenced disk files remain intact. */
export function deleteProject(data: Workspace, id: string) {
  data.projects = data.projects.filter((project) => project.id !== id);
  data.experiments = data.experiments?.filter((experiment) => experiment.project !== id);
  data.records = data.records.filter((item) => item.project !== id);
  data.runs = data.runs.filter((item) => item.project !== id);
  data.tasks = data.tasks.filter((item) => item.project !== id);
  data.sessions = data.sessions.filter((item) => item.project !== id);
  for (const paper of data.papers)
    paper.projects = paper.projects.filter((project) => project !== id);
  data.subscriptions = data.subscriptions.filter((item) => item.project !== id);
  data.activity = data.activity.filter((item) => item.project !== id);
  data.recent = data.recent.filter((item) => item.key !== id && item.key !== `project:${id}`);
}

export function deleteTeam(data: Workspace, id: string) {
  for (const project of data.projects) if (project.space === id) project.space = 'personal';
  data.teams = data.teams.filter((team) => team.id !== id);
}

/** Cloud projects shared with other people live in this local team space. */
export function ensureCollaborationTeam(data: Workspace) {
  if (!data.teams.some((team) => team.id === COLLABORATION_TEAM_ID))
    data.teams.push({
      id: COLLABORATION_TEAM_ID,
      name: '团队协作',
      color: '#56746a',
      description: 'Scientify collaboration projects',
    });
}

/** Team projects are shared with other people; personal projects may still sync to the owner's devices. */
export function isTeamProject(project: Project) {
  return isSyncedProject(project) && project.space !== 'personal';
}

export function personalProjects(data: Workspace) {
  return data.projects.filter((project) => !isTeamProject(project));
}

/** Covers use seven quiet neutrals; older, brighter cover colours map onto one of them. */
export const projectCoverColors = [
  '#4f5866',
  '#6a5f53',
  '#55625a',
  '#5e5a6b',
  '#6b6157',
  '#5a5f66',
  '#58615e',
];
export function toneOf(color: string) {
  const value = color.toLowerCase();
  if (projectCoverColors.includes(value)) return value;
  let hash = 0;
  for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return projectCoverColors[hash % projectCoverColors.length];
}
export function colorForId(id: string) {
  const seed = Array.from(id).reduce((value, char) => value + char.charCodeAt(0), 0);
  return projectCoverColors[seed % projectCoverColors.length];
}
export function coverColor(project: Pick<Project, 'id' | 'color'>) {
  if (project.color && /^#[0-9a-f]{6}$/i.test(project.color)) return project.color;
  return colorForId(project.id);
}
/** The neutral a project's cover shows wherever it appears. */
export function coverTone(project: Pick<Project, 'id' | 'color'>) {
  return toneOf(coverColor(project));
}

const openedKey = 'scientify.projects.opened';
/** When each project was last opened from this window; kept per device. */
export function readOpened(): Record<string, string> {
  try {
    const value = JSON.parse(localStorage.getItem(openedKey) ?? '{}');
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}
export function markOpened(id: string) {
  const opened = readOpened();
  opened[id] = new Date().toISOString();
  try {
    localStorage.setItem(openedKey, JSON.stringify(opened));
  } catch {
    /* Ordering is optional. */
  }
}

export function lastActive(project: Project, opened: Record<string, string>) {
  return opened[project.id] ?? project.updatedAt ?? project.createdAt;
}

export function filterProjects(projects: Project[], filter: ProjectFilter, query: string) {
  const term = query.trim().toLocaleLowerCase();
  return projects.filter(
    (project) =>
      (filter === 'archived' ? !!project.archived : !project.archived) &&
      [project.name, project.question, project.field ?? '']
        .join(' ')
        .toLocaleLowerCase()
        .includes(term),
  );
}

export function sortProjects(
  projects: Project[],
  sort: ProjectSort,
  opened: Record<string, string>,
) {
  const time = (value?: string) => value ?? '';
  const order: Record<ProjectSort, (a: Project, b: Project) => number> = {
    opened: (a, b) => lastActive(b, opened).localeCompare(lastActive(a, opened)),
    updated: (a, b) =>
      time(b.updatedAt ?? b.createdAt).localeCompare(time(a.updatedAt ?? a.createdAt)),
    name: (a, b) => a.name.localeCompare(b.name, locale()),
    created: (a, b) => time(b.createdAt).localeCompare(time(a.createdAt)),
  };
  return [...projects].sort(order[sort]);
}

/** Short relative time for lists: 刚刚, 5 分钟前, 昨天, 3 天前, then the date. */
export function relativeTime(value?: string | null) {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const minutes = Math.floor((Date.now() - date.getTime()) / 60000);
  if (minutes < 1) return t('刚刚');
  if (minutes < 60) return t('{count} 分钟前', { count: minutes });
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);
  const days = Math.round((today.getTime() - day.getTime()) / 86400000);
  if (days <= 0) return t('{count} 小时前', { count: Math.max(1, Math.floor(minutes / 60)) });
  if (days === 1) return t('昨天');
  if (days < 8) return t('{count} 天前', { count: days });
  return date.toLocaleDateString(locale());
}
