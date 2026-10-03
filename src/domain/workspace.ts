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
export type Experiment = Entity & {
  project: string;
  name: string;
  purpose: string;
  root: string;
  source: 'project' | 'existing' | 'empty';
  createdAt: string;
  updatedAt: string;
  archived?: boolean;
  runConfigurations?: unknown;
  python?: { executable: string; version: string; prefix: string; manager: string };
};
export type Workspace = {
  [key: string]: unknown;
  schema: 3;
  revision: number;
  updatedAt: string;
  teams: Team[];
  projects: Project[];
  experiments?: Experiment[];
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
    model: {
      endpoint: string;
      model: string;
      provider?: 'ollama' | 'openai' | 'anthropic' | 'gemini';
      serviceId?: string;
      modelCatalog?: string[];
      recentModels?: string[];
    };
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
    experiments: [],
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

/** Legacy projects retain their existing directory, configurations and chat history. */
export function normalizeExperiments(data: Workspace): Workspace {
  data.experiments ??= [];
  for (const project of data.projects) {
    if (project.experimentsInitialized === true) continue;
    if (!data.experiments.some((experiment) => experiment.project === project.id)) {
      if (data.experiments.some((experiment) => experiment.id === project.id))
        throw new Error('默认实验标识冲突。');
      data.experiments.push({
        id: project.id,
        project: project.id,
        name: '默认实验',
        purpose: '',
        root: '',
        source: 'project',
        createdAt: project.createdAt,
        updatedAt: project.updatedAt ?? project.createdAt,
        runConfigurations: project.runConfigurations ?? [],
      });
      for (const run of data.runs)
        if (run.project === project.id && !run.experimentId) run.experimentId = project.id;
    }
    project.experimentsInitialized = true;
  }
  return data;
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
