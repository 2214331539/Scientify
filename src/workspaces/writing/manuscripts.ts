import type { Project } from '../../domain/workspace';
import type { ResearchBackend } from '../../platform/research';
import type { Engine, Imported } from '../../platform/writing';
import type { WorkspaceStore } from '../../stores/workspace';
import { t } from '../../i18n';
import { detectCompiler, isMainDocument } from './latex';

export type Compiler = 'pdflatex' | 'xelatex' | 'lualatex';
/** A LaTeX folder inside the project; `folder` is relative to the project folder ('' is the folder itself). */
export type Manuscript = {
  id: string;
  name: string;
  folder: string;
  main: string;
  compiler: Compiler;
  /** Which TeX compiles it: the computer's when it has the compiler ('auto'), or as chosen. */
  engine: Engine;
  autoCompile: boolean;
  writePdf: boolean;
};
const ENGINES: Engine[] = ['auto', 'builtin', 'local'];
const COMPILERS: Compiler[] = ['pdflatex', 'xelatex', 'lualatex'];
export const compilerLabel = (compiler: Compiler) =>
  ({ pdflatex: 'pdfLaTeX', xelatex: 'XeLaTeX', lualatex: 'LuaLaTeX' })[compiler];

/** The project's manuscripts, skipping malformed entries from older or synced data. */
export function manuscriptsOf(project: Project | undefined): Manuscript[] {
  const list = Array.isArray(project?.manuscripts) ? (project.manuscripts as unknown[]) : [];
  return list.flatMap((value) => {
    const item = value as Partial<Manuscript>;
    if (typeof item?.id !== 'string' || typeof item.name !== 'string') return [];
    if (typeof item.folder !== 'string' || typeof item.main !== 'string') return [];
    return [
      {
        id: item.id,
        name: item.name,
        folder: item.folder,
        main: item.main,
        compiler: COMPILERS.includes(item.compiler as Compiler)
          ? (item.compiler as Compiler)
          : 'pdflatex',
        engine: ENGINES.includes(item.engine as Engine) ? (item.engine as Engine) : 'auto',
        autoCompile: item.autoCompile !== false,
        writePdf: item.writePdf === true,
      },
    ];
  });
}

/** Folders taken out of writing on purpose, so finding manuscripts does not bring them back. */
function dismissedOf(project: Project | undefined): string[] {
  const list = project?.manuscriptsDismissed;
  return Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : [];
}
const sameFolder = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Adds or replaces a manuscript in the project. */
export async function saveManuscript(store: WorkspaceStore, projectId: string, next: Manuscript) {
  const ok = await store.getState().update((data) => {
    const project = data.projects.find((item) => item.id === projectId);
    if (!project) throw new Error(t('项目不存在'));
    const list = manuscriptsOf(project).filter((item) => item.id !== next.id);
    project.manuscripts = [...list, next];
    const dismissed = dismissedOf(project);
    if (dismissed.some((folder) => sameFolder(folder, next.folder)))
      project.manuscriptsDismissed = dismissed.filter((folder) => !sameFolder(folder, next.folder));
  });
  if (!ok) throw new Error(store.getState().error || t('保存失败'));
}

/** Forgets a manuscript; its folder and files stay on disk. */
export async function removeManuscript(store: WorkspaceStore, projectId: string, id: string) {
  const ok = await store.getState().update((data) => {
    const project = data.projects.find((item) => item.id === projectId);
    if (!project) return;
    const removed = manuscriptsOf(project).find((item) => item.id === id);
    project.manuscripts = manuscriptsOf(project).filter((item) => item.id !== id);
    if (removed) project.manuscriptsDismissed = [...dismissedOf(project), removed.folder];
  });
  if (!ok) throw new Error(store.getState().error || t('保存失败'));
}

export const manuscriptChoiceKey = (projectId: string) =>
  `scientify.writing.manuscript.${projectId}`;

/** The manuscript the writing page shows: the one picked last, else the first ('*' is the file view). */
export function currentManuscript(project: Project | undefined): Manuscript | null {
  const list = manuscriptsOf(project);
  let choice = '';
  try {
    choice = (project && localStorage.getItem(manuscriptChoiceKey(project.id))) || '';
  } catch {
    /* Preferences are optional. */
  }
  return choice === '*' ? null : (list.find((item) => item.id === choice) ?? list[0] ?? null);
}

const NOT_MANUSCRIPTS = /^(\.|node_modules$|__pycache__$|venv$|env$|build$|dist$|target$)/i;

/**
 * LaTeX folders at the top of the project that are not manuscripts yet: a folder whose own main
 * document has \documentclass (main.tex first). The writing page adds them by itself, so a paper
 * the AI wrote or someone copied in shows up without a separate step.
 */
export async function findManuscripts(
  backend: ResearchBackend,
  project: Project,
): Promise<Manuscript[]> {
  const known = [...manuscriptsOf(project).map((item) => item.folder), ...dismissedOf(project)];
  const folders = new Map<string, string[]>();
  for (const file of await backend.listFiles(project.id)) {
    const [folder, name, ...deeper] = file.path.split('/');
    if (file.kind !== 'file' || deeper.length || !name || !/\.tex$/i.test(name)) continue;
    if (NOT_MANUSCRIPTS.test(folder) || known.some((item) => sameFolder(item, folder))) continue;
    folders.set(folder, [...(folders.get(folder) ?? []), name]);
  }
  const found: Manuscript[] = [];
  for (const [folder, names] of folders) {
    names.sort(
      (a, b) =>
        Number(b.toLowerCase() === 'main.tex') - Number(a.toLowerCase() === 'main.tex') ||
        a.localeCompare(b),
    );
    for (const name of names.slice(0, 20)) {
      const text = await backend
        .readFile(project.id, `${folder}/${name}`)
        .then((file) => file.content)
        .catch(() => '');
      if (!isMainDocument(text)) continue;
      found.push({
        id: crypto.randomUUID(),
        name: folder,
        folder,
        main: name,
        compiler: detectCompiler(text),
        engine: 'auto',
        autoCompile: true,
        writePdf: false,
      });
      break;
    }
  }
  return found;
}

/** Registers the LaTeX folders `findManuscripts` returns; folders added meanwhile are skipped. */
export async function adoptManuscripts(
  store: WorkspaceStore,
  backend: ResearchBackend,
  project: Project,
): Promise<Manuscript[]> {
  const found = await findManuscripts(backend, project);
  if (!found.length) return [];
  const added: Manuscript[] = [];
  const ok = await store.getState().update((data) => {
    added.length = 0;
    const target = data.projects.find((item) => item.id === project.id);
    if (!target) return;
    const known = [...manuscriptsOf(target).map((item) => item.folder), ...dismissedOf(target)];
    for (const item of found)
      if (!known.some((folder) => sameFolder(folder, item.folder))) added.push(item);
    if (added.length) target.manuscripts = [...manuscriptsOf(target), ...added];
  });
  if (!ok) throw new Error(store.getState().error || t('保存失败'));
  return added;
}

export const join = (folder: string, path: string) => (folder ? `${folder}/${path}` : path);

/** A folder name made from a manuscript name, without characters file systems reject. */
export const folderName = (name: string) =>
  name
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '') || 'manuscript';

const BIB = String.raw`@article{example2025,
  title   = {An Example Reference},
  author  = {Author, Ada and Writer, Ben},
  journal = {Journal of Examples},
  year    = {2025}
}
`;
const section = (name: string, label: string, body: string) =>
  `\\section{${name}}\n\\label{sec:${label}}\n\n${body}\n`;

export type Template = {
  id: string;
  label: string;
  description: string;
  compiler: Compiler;
  files(title: string): Record<string, string>;
};
export const TEMPLATES: Template[] = [
  {
    id: 'article',
    label: '空白论文',
    description: 'article',
    compiler: 'pdflatex',
    files: (title) => ({
      'main.tex': String.raw`\documentclass{article}
\usepackage[utf8]{inputenc}
\usepackage{amsmath}
\usepackage{graphicx}
\usepackage{hyperref}

\title{${title}}
\author{}
\date{}

\begin{document}
\maketitle

\begin{abstract}
\end{abstract}

\section{Introduction}

\bibliographystyle{plain}
\bibliography{references}
\end{document}
`,
      'references.bib': BIB,
    }),
  },
  {
    id: 'paper',
    label: '会议论文',
    description: '分章节、图表和参考文献',
    compiler: 'pdflatex',
    files: (title) => ({
      'main.tex': String.raw`\documentclass[11pt]{article}
\usepackage[margin=1in]{geometry}
\usepackage{amsmath,amssymb}
\usepackage{graphicx}
\usepackage{booktabs}
\usepackage[numbers]{natbib}
\usepackage{hyperref}

\title{${title}}
\author{}
\date{}

\begin{document}
\maketitle

\begin{abstract}
\end{abstract}

\input{sections/introduction}
\input{sections/related}
\input{sections/method}
\input{sections/experiments}
\input{sections/conclusion}

\bibliographystyle{plainnat}
\bibliography{references}
\end{document}
`,
      'sections/introduction.tex': section(
        'Introduction',
        'intro',
        'Motivate the problem here \\citep{example2025}.',
      ),
      'sections/related.tex': section('Related Work', 'related', ''),
      'sections/method.tex': section('Method', 'method', ''),
      'sections/experiments.tex': section(
        'Experiments',
        'experiments',
        String.raw`\begin{table}[t]
  \centering
  \caption{Main results.}
  \label{tab:main}
  \begin{tabular}{lcc}
    \toprule
    Method & Metric A & Metric B \\
    \midrule
    Baseline & 0.00 & 0.00 \\
    Ours & 0.00 & 0.00 \\
    \bottomrule
  \end{tabular}
\end{table}`,
      ),
      'sections/conclusion.tex': section('Conclusion', 'conclusion', ''),
      'references.bib': BIB,
    }),
  },
  {
    id: 'ctex',
    label: '中文论文',
    description: 'ctexart · XeLaTeX',
    compiler: 'xelatex',
    files: (title) => ({
      'main.tex': String.raw`\documentclass[UTF8]{ctexart}
\usepackage{amsmath}
\usepackage{graphicx}
\usepackage{hyperref}

\title{${title}}
\author{}
\date{}

\begin{document}
\maketitle

\begin{abstract}
\end{abstract}

\section{引言}

\bibliographystyle{plain}
\bibliography{references}
\end{document}
`,
      'references.bib': BIB,
    }),
  },
  {
    id: 'beamer',
    label: '报告幻灯片',
    description: 'beamer',
    compiler: 'pdflatex',
    files: (title) => ({
      'main.tex': String.raw`\documentclass{beamer}
\usetheme{default}
\setbeamertemplate{navigation symbols}{}

\title{${title}}
\author{}
\date{\today}

\begin{document}
\frame{\titlepage}

\begin{frame}{Outline}
  \tableofcontents
\end{frame}

\section{Motivation}
\begin{frame}{Motivation}
  \begin{itemize}
    \item
  \end{itemize}
\end{frame}
\end{document}
`,
    }),
  },
];

/** Writes a template into a new folder of the project and returns the manuscript to register. */
export async function createManuscript(
  backend: ResearchBackend,
  project: Project,
  name: string,
  template: Template,
  taken: Set<string>,
): Promise<Manuscript> {
  const base = folderName(name);
  let folder = base;
  for (let n = 2; taken.has(folder.toLowerCase()); n++) folder = `${base} ${n}`;
  if (!backend.createDirectory) throw new Error(t('新建稿件需要桌面应用。'));
  await backend.createDirectory(project.id, folder);
  const title = name.replace(/[\\{}$&#^_%~]/g, '');
  for (const [path, content] of Object.entries(template.files(title)))
    await backend.writeFile(project.id, `${folder}/${path}`, content, null);
  if (template.id === 'paper') await backend.createDirectory(project.id, `${folder}/figures`);
  return {
    id: crypto.randomUUID(),
    name: name.trim(),
    folder,
    main: 'main.tex',
    compiler: template.compiler,
    engine: 'auto',
    autoCompile: true,
    writePdf: false,
  };
}

/**
 * A manuscript for a folder that was just imported: its main document is the .tex file with
 * \documentclass (main.tex first, then the shallowest), its compiler guessed from the source.
 */
export async function manuscriptFromImport(
  backend: ResearchBackend,
  projectId: string,
  imported: Imported,
  name: string,
): Promise<Manuscript> {
  const read = (path: string) =>
    backend
      .readFile(projectId, join(imported.folder, path))
      .then((file) => file.content)
      .catch(() => '');
  const candidates = imported.files
    .filter((path) => /\.tex$/i.test(path))
    .sort(
      (a, b) =>
        Number(b.toLowerCase() === 'main.tex') - Number(a.toLowerCase() === 'main.tex') ||
        a.split('/').length - b.split('/').length ||
        a.localeCompare(b),
    )
    .slice(0, 200);
  for (const path of candidates) {
    const text = await read(path);
    if (!isMainDocument(text)) continue;
    const rc = imported.files.find((file) => /^\.?latexmkrc$/i.test(file));
    return {
      id: crypto.randomUUID(),
      name: name.trim() || imported.folder,
      folder: imported.folder,
      main: path,
      compiler: detectCompiler(text, rc ? await read(rc) : ''),
      engine: 'auto',
      autoCompile: true,
      writePdf: false,
    };
  }
  throw new Error(
    t('已导入到“{folder}”，但没有找到包含 \\documentclass 的 .tex 文件。', {
      folder: imported.folder,
    }),
  );
}
