export type Entity = { id: string; [key: string]: unknown };
export type Team = Entity & { name: string; color: string; description?: string };
export type Project = Entity & {
  name: string;
  question: string;
  createdAt: string;
  updatedAt?: string;
  space: string;
  field?: string;
  stage?: string;
  path?: string;
  repo?: string;
  color?: string;
  archived?: boolean;
  favorite?: boolean;
};
export type ResearchRecord = Entity & {
  project: string;
  title: string;
  body: string;
  type: string;
  status: string;
  updatedAt: string;
  createdAt: string;
};
export type Paper = Entity & { title: string; projects: string[] };
export type Task = Entity & { project: string; title: string; done?: boolean };
export type Workspace = {
  [key: string]: unknown;
  schema: 3;
  revision: number;
  updatedAt: string;
  teams: Team[];
  projects: Project[];
  papers: Paper[];
  records: ResearchRecord[];
  runs: (Entity & { project: string })[];
  tasks: Task[];
  sessions: (Entity & { project: string })[];
  subscriptions: Entity[];
  trash: Entity[];
  recent: { key: string }[];
  activity: Entity[];
  settings: {
    [key: string]: unknown;
    theme: string;
    name: string;
    model: { endpoint: string; model: string };
  };
  navigation: {
    [key: string]: unknown;
    tabs: string[];
    active: string;
    expanded: string[];
    panel: string | null;
  };
};

export function emptyWorkspace(): Workspace {
  return {
    schema: 3,
    revision: 0,
    updatedAt: new Date().toISOString(),
    teams: [],
    projects: [],
    papers: [],
    records: [],
    runs: [],
    tasks: [],
    sessions: [],
    subscriptions: [],
    trash: [],
    recent: [],
    activity: [],
    settings: {
      theme: 'system',
      name: '',
      model: { endpoint: 'http://127.0.0.1:11434', model: '' },
    },
    navigation: { tabs: ['home'], active: 'home', expanded: [], panel: null },
  };
}

/** The launcher exposes a single collection, including recoverable archived projects. */
export function selectProjects(data: Workspace, space: string, query: string) {
  const term = query.trim().toLocaleLowerCase();
  return data.projects
    .filter(
      (p) =>
        p.space === space &&
        [p.name, p.question, p.field ?? ''].join(' ').toLocaleLowerCase().includes(term),
    )
    .sort((a, b) => (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt));
}
