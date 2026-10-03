import type { Workspace, Project } from '../../domain/workspace';

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

export const projectCoverColors = ['#435e55', '#496b8d', '#a18a67', '#756b83', '#667775'];
export function coverColor(project: Project) {
  if (project.color && /^#[0-9a-f]{6}$/i.test(project.color)) return project.color;
  const seed = Array.from(project.id).reduce((value, char) => value + char.charCodeAt(0), 0);
  return projectCoverColors[seed % projectCoverColors.length];
}
export function coverInk(color: string) {
  const channels = [1, 3, 5].map((start) => {
    const value = parseInt(color.slice(start, start + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  return luminance > 0.179 ? '#17211d' : '#ffffff';
}
