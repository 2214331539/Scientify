import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, useSyncExternalStore } from 'react';
import { EditorState } from '@codemirror/state';
import { emptyWorkspace, type Project } from '../../domain/workspace';
import { createWorkspaceStore } from '../../stores/workspace';
import type { ResearchBackend, ResearchFile } from '../../platform/research';
import type { FileSession } from '../../editor/sessions';
import { completionAt } from '../../editor/latex';
import { writingApi, type CompileResult } from '../../platform/writing';
import { WritingWorkspace } from './WritingWorkspace';
import {
  createManuscript,
  findManuscripts,
  folderName,
  manuscriptsOf,
  removeManuscript,
  saveManuscript,
  TEMPLATES,
  type Manuscript,
} from './manuscripts';

vi.mock('../../components/prompts', () => ({ confirmAction: vi.fn(async () => true) }));
vi.mock('../../editor/CodeEditor', () => ({
  CodeEditor: ({ session }: { session: FileSession }) => {
    const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
    return (
      <textarea
        aria-label="代码编辑"
        value={snapshot.content}
        onChange={(e) => session.edit(e.target.value)}
      />
    );
  },
}));
vi.mock('./PdfPreview', () => ({
  PdfPreview: ({ data }: { data: Uint8Array | null }) => (
    <div role="document" aria-label="PDF">
      {data?.length ?? 0}
    </div>
  ),
}));
vi.mock('../../platform/writing', () => ({
  writingApi: {
    available: vi.fn(() => true),
    status: vi.fn(),
    compile: vi.fn(),
    cancel: vi.fn(async () => {}),
    pdf: vi.fn(),
    synctex: vi.fn(),
    exportPdf: vi.fn(),
    importZip: vi.fn(),
    clone: vi.fn(),
    exportSource: vi.fn(),
  },
}));

const project: Project = {
  id: 'p1',
  name: 'Test',
  question: '',
  space: 'personal',
  createdAt: '2026-10-01',
};
const paper = {
  id: 'm1',
  name: 'Paper',
  folder: 'paper',
  main: 'main.tex',
  compiler: 'pdflatex',
  engine: 'auto',
  autoCompile: true,
  writePdf: false,
};
const MAIN = String.raw`\documentclass{article}
\begin{document}
\section{Intro}
Hello \cite{known} and \cite{lost}.
\bibliography{refs}
\end{document}
`;
const BIB = `@article{known,\n  title = {Known Work}\n}\n@book{spare,\n  title = {Spare}\n}\n`;
const LOCAL = {
  local: { distribution: 'TeX Live', bin: '/tex', latexmk: true, engines: ['pdflatex'] },
  builtin: '0.17.0',
};
const result = (patch: Partial<CompileResult>): CompileResult => ({
  status: 'success',
  engine: 'latexmk',
  bundled: false,
  durationMs: 1200,
  log: '',
  output: '',
  pdf: true,
  root: 'F:/work/paper',
  ...patch,
});

beforeEach(() => {
  localStorage.clear();
  vi.mocked(writingApi.available).mockReturnValue(true);
  vi.mocked(writingApi.status).mockResolvedValue(LOCAL);
  vi.mocked(writingApi.pdf).mockResolvedValue(new Uint8Array([1, 2, 3]));
  vi.mocked(writingApi.synctex).mockResolvedValue('SyncTeX Version:1\nInput:1:main.tex\n');
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const compileButton = async () =>
  (await screen.findAllByRole('button', { name: '重新编译' })).find((button) =>
    button.classList.contains('sf-writing-compile-main'),
  )!;

async function setup(manuscripts: unknown[] = [paper], extra: Record<string, unknown> = {}) {
  const data = emptyWorkspace();
  data.projects = [{ ...project, manuscripts, ...extra }];
  const persistence = {
    load: async () => ({ workspace: data, directory: '', legacyAvailable: false }),
    save: vi.fn(async (d: typeof data) => d),
    restore: async () => data,
    migrateLegacy: async () => data,
    importWorkspace: async () => null,
    exportWorkspace: async () => true,
    chooseDirectory: async () => null,
  };
  const store = createWorkspaceStore(persistence);
  await store.getState().load();
  const files: ResearchFile[] = [
    { path: 'paper', name: 'paper', kind: 'directory', size: 0 },
    { path: 'paper/main.tex', name: 'main.tex', kind: 'file', size: MAIN.length },
    { path: 'paper/refs.bib', name: 'refs.bib', kind: 'file', size: BIB.length },
    { path: 'paper/old.tex', name: 'old.tex', kind: 'file', size: 4 },
    { path: 'paper/main.aux', name: 'main.aux', kind: 'file', size: 4 },
  ];
  const backend: ResearchBackend = {
    listFiles: vi.fn(async () => files),
    readFile: vi.fn(async (_p, path) => ({
      path,
      content: path.endsWith('.bib') ? BIB : MAIN,
      version: 'v1',
    })),
    writeFile: vi.fn(async (_p, path, content) => ({ path, content, version: 'v2' })),
    createDirectory: vi.fn(async (_p, path) => path),
    gitStatus: async () => [],
    importPdf: async () => null,
    readPdf: async () => new Uint8Array(),
    askAI: async () => '',
    listModels: async () => [],
    testModel: async () => {},
  };
  const onOpen = vi.fn();
  function Harness() {
    const [path, setPath] = useState<string | null>(null);
    return (
      <WritingWorkspace
        project={project}
        store={store}
        backend={backend}
        view="files"
        onView={() => {}}
        activePath={path}
        onOpen={(next) => {
          onOpen(next);
          setPath(next);
        }}
        onContext={() => {}}
      />
    );
  }
  render(<Harness />);
  return { store, backend, onOpen };
}

it('lists a LaTeX folder that appears in the project as a manuscript', async () => {
  const { store } = await setup([]);
  expect(await screen.findByRole('button', { name: '稿件：paper' })).toBeTruthy();
  expect(manuscriptsOf(store.getState().data!.projects[0])).toEqual([
    expect.objectContaining({ name: 'paper', folder: 'paper', main: 'main.tex' }),
  ]);
});

it('shows a paper that appears while the project files view is open', async () => {
  localStorage.setItem('scientify.writing.manuscript.p1', '*');
  await setup([]);
  expect(await screen.findByRole('button', { name: '稿件：paper' })).toBeTruthy();
  expect(localStorage.getItem('scientify.writing.manuscript.p1')).not.toBe('*');
});

it('compiles a manuscript the first time it is opened and shows the PDF beside the source', async () => {
  vi.mocked(writingApi.compile).mockResolvedValue(result({}));
  await setup([{ ...paper, id: 'first-visit' }]);
  expect(await screen.findByRole('document', { name: 'PDF' })).toBeTruthy();
  expect(writingApi.compile).toHaveBeenCalledOnce();
});

it('keeps a manuscript taken out of writing out until it is added again', async () => {
  const { store, backend } = await setup();
  const live = () => store.getState().data!.projects[0];
  await removeManuscript(store, 'p1', 'm1');
  expect(live().manuscriptsDismissed).toEqual(['paper']);
  expect(await findManuscripts(backend, live())).toEqual([]);
  await saveManuscript(store, 'p1', paper as Manuscript);
  expect(live().manuscriptsDismissed).toEqual([]);
});

it('creates a manuscript from a template and opens its main document', async () => {
  const { store, backend, onOpen } = await setup([], { manuscriptsDismissed: ['paper'] });
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: '新建稿件…' }));
  const dialog = screen.getByRole('dialog', { name: '新建稿件' });
  await user.type(within(dialog).getByRole('textbox', { name: '名称' }), 'My Paper');
  await user.click(within(dialog).getByRole('radio', { name: /空白论文/ }));
  await user.click(within(dialog).getByRole('button', { name: '创建' }));
  await waitFor(() => expect(onOpen).toHaveBeenCalledWith('My Paper/main.tex'));
  expect(backend.createDirectory).toHaveBeenCalledWith('p1', 'My Paper');
  expect(backend.writeFile).toHaveBeenCalledWith(
    'p1',
    'My Paper/main.tex',
    expect.stringContaining(String.raw`\title{My Paper}`),
    null,
  );
  expect(manuscriptsOf(store.getState().data!.projects[0])).toEqual([
    expect.objectContaining({ name: 'My Paper', folder: 'My Paper', main: 'main.tex' }),
  ]);
  expect(await screen.findByRole('button', { name: '稿件：My Paper' })).toBeTruthy();
});

it('compiles the manuscript, shows the PDF and lists references', async () => {
  vi.mocked(writingApi.compile).mockResolvedValue(result({}));
  await setup();
  const user = userEvent.setup();
  await user.click(await compileButton());
  await waitFor(() =>
    expect(writingApi.compile).toHaveBeenCalledWith('p1', {
      folder: 'paper',
      main: 'main.tex',
      compiler: 'pdflatex',
      engine: 'auto',
      draft: false,
      stopOnError: false,
      clean: false,
      writePdf: false,
    }),
  );
  expect((await screen.findByRole('document', { name: 'PDF' })).textContent).toBe('3');
  expect(screen.getByRole('button', { name: /编译成功 · 1\.2 秒/ })).toBeTruthy();
  await user.click(screen.getByRole('tab', { name: '参考文献' }));
  const refs = await screen.findByText('lost');
  expect(refs.closest('.sf-ref-row')?.className).toContain('is-missing');
  expect(screen.getByText('known').closest('.sf-ref-row')?.className).not.toContain('is-');
  await user.click(screen.getByRole('button', { name: /未使用/ }));
  expect(screen.getByText('spare').closest('.sf-ref-row')?.className).toContain('is-unused');
});

it('shows compile errors in the log and opens the source line', async () => {
  vi.mocked(writingApi.compile).mockResolvedValue(
    result({
      status: 'failed',
      pdf: false,
      log: '(./main.tex\n./main.tex:4: Undefined control sequence.\nl.4 Hello \\foo\n\n)\n',
    }),
  );
  const { onOpen } = await setup();
  const user = userEvent.setup();
  await user.click(await compileButton());
  const item = await screen.findByRole('button', { name: /Undefined control sequence/ });
  expect(item.textContent).toContain('main.tex:4');
  expect(item.textContent).toContain('未定义的命令');
  expect(screen.getByRole('button', { name: '日志和输出文件' }).textContent).toBe('1');
  await user.click(item);
  await waitFor(() => expect(onOpen).toHaveBeenLastCalledWith('paper/main.tex'));
});

const MISSING =
  "(./main.tex\n! LaTeX Error: File `nicematrix.sty' not found.\n\nl.3 \\usepackage\n)\n";

it('switches to the bundled engine when local TeX lacks a package', async () => {
  vi.mocked(writingApi.compile)
    .mockResolvedValueOnce(result({ status: 'failed', pdf: false, log: MISSING }))
    .mockResolvedValue(result({ bundled: true, engine: '内置引擎 Tectonic 0.17.0' }));
  // Opening a manuscript that was never compiled compiles it.
  const { store } = await setup([{ ...paper, id: 'switch' }]);
  const user = userEvent.setup();
  const notice = await screen.findByRole('status');
  expect(notice.textContent).toContain('本机 TeX 缺少 nicematrix.sty，已改用内置引擎编译');
  await waitFor(() => expect(writingApi.compile).toHaveBeenCalledTimes(2));
  expect(vi.mocked(writingApi.compile).mock.calls[1][1]).toMatchObject({ engine: 'builtin' });
  expect(await screen.findByRole('document', { name: 'PDF' })).toBeTruthy();
  await user.click(within(notice).getByRole('button', { name: '以后都用内置引擎' }));
  await waitFor(() =>
    expect(manuscriptsOf(store.getState().data!.projects[0])[0].engine).toBe('builtin'),
  );
  expect(screen.queryByRole('status')).toBeNull();
});

it('offers the bundled engine when the chosen TeX lacks a package', async () => {
  vi.mocked(writingApi.compile)
    .mockResolvedValueOnce(result({ status: 'failed', pdf: false, log: MISSING }))
    .mockResolvedValue(result({ bundled: true }));
  await setup([{ ...paper, id: 'local', engine: 'local' }]);
  const user = userEvent.setup();
  const notice = await screen.findByRole('status');
  expect(notice.textContent).toContain('本机 TeX 缺少 nicematrix.sty');
  expect(writingApi.compile).toHaveBeenCalledTimes(1);
  await user.click(within(notice).getByRole('button', { name: '用内置引擎下载并编译' }));
  await waitFor(() => expect(writingApi.compile).toHaveBeenCalledTimes(2));
  expect(vi.mocked(writingApi.compile).mock.calls[1][1]).toMatchObject({ engine: 'builtin' });
});

it('downloads missing packages again as soon as the computer is back online', async () => {
  vi.mocked(writingApi.compile)
    .mockResolvedValueOnce(
      result({
        status: 'failed',
        bundled: true,
        pdf: false,
        log: MISSING,
        output: 'error: failed to fetch: error sending request for url (https://relay.example)',
      }),
    )
    .mockResolvedValue(result({ bundled: true }));
  await setup([{ ...paper, id: 'offline' }]);
  const notice = await screen.findByRole('status');
  expect(notice.textContent).toContain('nicematrix.sty 需要联网下载');
  expect(within(notice).getByRole('button', { name: '重新下载' })).toBeTruthy();
  window.dispatchEvent(new Event('online'));
  await waitFor(() => expect(writingApi.compile).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
});

it('compiles with the bundled engine when chosen, and says so when it is missing', async () => {
  vi.mocked(writingApi.status).mockResolvedValue({ local: null, builtin: null });
  // Builds are kept per manuscript across mounts, so this one has never been compiled.
  const { store } = await setup([{ ...paper, id: 'fresh' }]);
  const user = userEvent.setup();
  expect(await screen.findByRole('heading', { name: '没有找到内置引擎' })).toBeTruthy();
  await user.click(screen.getByRole('button', { name: /^稿件：/ }));
  await user.click(screen.getByRole('menuitem', { name: '编译设置…' }));
  const dialog = screen.getByRole('dialog', { name: '编译设置' });
  await user.selectOptions(within(dialog).getByRole('combobox', { name: 'TeX 环境' }), 'builtin');
  await user.click(within(dialog).getByRole('button', { name: '保存' }));
  await waitFor(() =>
    expect(manuscriptsOf(store.getState().data!.projects[0])[0].engine).toBe('builtin'),
  );
});

it('imports a downloaded Overleaf zip as a manuscript', async () => {
  vi.mocked(writingApi.importZip).mockResolvedValue({
    folder: 'My Paper',
    files: ['refs.bib', 'sections/intro.tex', 'main.tex'],
  });
  const { store, onOpen } = await setup([], { manuscriptsDismissed: ['paper'] });
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: '从 Overleaf 导入…' }));
  await user.click(screen.getByRole('button', { name: '选择 zip…' }));
  await waitFor(() => expect(onOpen).toHaveBeenCalledWith('My Paper/main.tex'));
  expect(writingApi.importZip).toHaveBeenCalledWith('p1');
  expect(manuscriptsOf(store.getState().data!.projects[0])).toEqual([
    expect.objectContaining({
      name: 'My Paper',
      folder: 'My Paper',
      main: 'main.tex',
      compiler: 'pdflatex',
      engine: 'auto',
    }),
  ]);
});

it('clones an Overleaf project by Git with its token', async () => {
  vi.mocked(writingApi.clone).mockResolvedValue({ folder: 'Thesis', files: ['main.tex'] });
  const { store, onOpen } = await setup([], { manuscriptsDismissed: ['paper'] });
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: '从 Overleaf 导入…' }));
  const dialog = screen.getByRole('dialog', { name: '从 Overleaf 导入' });
  await user.type(
    within(dialog).getByRole('textbox', { name: 'Git 地址' }),
    'https://git.overleaf.com/abc123',
  );
  await user.type(within(dialog).getByLabelText('Git 令牌'), 'olp_secret');
  await user.type(within(dialog).getByRole('textbox', { name: '名称' }), 'Thesis');
  await user.click(within(dialog).getByRole('button', { name: '克隆' }));
  await waitFor(() => expect(onOpen).toHaveBeenCalledWith('Thesis/main.tex'));
  expect(writingApi.clone).toHaveBeenCalledWith(
    'p1',
    'https://git.overleaf.com/abc123',
    'Thesis',
    'olp_secret',
  );
  expect(manuscriptsOf(store.getState().data!.projects[0])[0]).toMatchObject({
    name: 'Thesis',
    folder: 'Thesis',
  });
});

it('exports a source package with the files the document uses', async () => {
  vi.mocked(writingApi.exportSource).mockResolvedValue('F:/out/paper.zip');
  await setup();
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: '更多操作' }));
  await user.click(screen.getByRole('menuitem', { name: '导出源码包…' }));
  const dialog = await screen.findByRole('dialog', { name: '导出源码包' });
  const box = (name: string) => within(dialog).getByRole('checkbox', { name }) as HTMLInputElement;
  await waitFor(() => expect(box('refs.bib').checked).toBe(true));
  expect(box('main.tex').checked).toBe(true);
  expect(box('old.tex').checked).toBe(false);
  expect(within(dialog).queryByRole('checkbox', { name: 'main.aux' })).toBeNull();
  await user.click(box('附上编译生成的 .bbl（arXiv 需要）'));
  await user.click(within(dialog).getByRole('button', { name: '导出…' }));
  await waitFor(() =>
    expect(writingApi.exportSource).toHaveBeenCalledWith(
      'p1',
      { folder: 'paper', main: 'main.tex' },
      ['main.tex', 'refs.bib'],
      true,
    ),
  );
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '导出源码包' })).toBeNull());
});

it('keeps manuscripts well formed and their folders unique', async () => {
  expect(
    manuscriptsOf({
      ...project,
      manuscripts: [paper, { id: 'x' }, null, { ...paper, id: 'm2', compiler: 'tex' }],
    }).map((item) => [item.id, item.compiler]),
  ).toEqual([
    ['m1', 'pdflatex'],
    ['m2', 'pdflatex'],
  ]);
  expect(folderName('A/B: "draft"')).toBe('A B draft');
  expect(folderName('..')).toBe('manuscript');
  const backend = {
    createDirectory: vi.fn(async () => {}),
    writeFile: vi.fn(async () => ({})),
  } as unknown as ResearchBackend;
  const paperTemplate = TEMPLATES.find((item) => item.id === 'paper')!;
  const created = await createManuscript(
    backend,
    project,
    'Paper',
    paperTemplate,
    new Set(['paper']),
  );
  expect(created).toMatchObject({ folder: 'Paper 2', main: 'main.tex' });
  const written = vi.mocked(backend.writeFile).mock.calls.map((call) => call[1]);
  expect(written).toContain('Paper 2/main.tex');
  expect(written.some((path) => path.startsWith('Paper 2/sections/'))).toBe(true);
  expect(backend.createDirectory).toHaveBeenCalledWith('p1', 'Paper 2/figures');
});

it('completes citations, labels and files in LaTeX', () => {
  const source = {
    labels: () => ['sec:intro', 'fig:plot'],
    citations: () => [{ key: 'yang2025', detail: 'A Title' }, { key: 'li2024' }],
    files: (kind: 'image' | 'tex') =>
      kind === 'image' ? ['figures/plot.png'] : ['sections/intro.tex'],
  };
  const at = (text: string) =>
    completionAt(EditorState.create({ doc: text, selection: { anchor: text.length } }), source);
  expect(at(String.raw`see \cite{ya`)?.options.map((item) => item.label)).toEqual(['yang2025']);
  expect(at(String.raw`\citep[p.~2]{li2024, ya`)?.options[0].label).toBe('yang2025');
  expect(at(String.raw`\ref{fig`)?.options.map((item) => item.label)).toEqual(['fig:plot']);
  expect(at(String.raw`\includegraphics[width=\linewidth]{`)?.options[0].label).toBe(
    'figures/plot.png',
  );
  expect(at(String.raw`\input{sec`)?.options[0].insert).toBe('sections/intro');
  expect(at(String.raw`% \cite{ya`)).toBeNull();
});
