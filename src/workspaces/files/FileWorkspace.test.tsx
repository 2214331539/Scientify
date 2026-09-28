import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useSyncExternalStore } from 'react';
import type { FileSession } from '../../editor/sessions';
import { emptyWorkspace, type Project } from '../../domain/workspace';
import { createWorkspaceStore } from '../../stores/workspace';
import type { WorkspaceBackend } from '../../platform/desktop';
import type { ResearchBackend } from '../../platform/research';
import { FileWorkspace } from './FileWorkspace';

vi.mock('../../editor/CodeEditor', () => ({
  CodeEditor: ({ session }: { session: FileSession }) => {
    const data = useSyncExternalStore(session.subscribe, session.getSnapshot);
    return (
      <textarea
        aria-label={`编辑 ${session.path}`}
        value={data.content}
        onChange={(event) => session.edit(event.target.value)}
      />
    );
  },
}));
afterEach(cleanup);
const project: Project = {
  id: 'p1',
  name: 'Research',
  question: '',
  createdAt: '2026-09-23',
  space: 'personal',
};

function setup() {
  const workspaceBackend: WorkspaceBackend = {
    load: async () => ({ workspace: emptyWorkspace(), directory: '', legacyAvailable: false }),
    save: async (data) => data,
    restore: async () => emptyWorkspace(),
    migrateLegacy: async () => emptyWorkspace(),
    importWorkspace: async () => null,
    exportWorkspace: async () => true,
    chooseDirectory: async () => null,
  };
  const backend: ResearchBackend = {
    listFiles: async () => [],
    readFile: vi.fn(async (_project, path) => ({ path, content: '# Draft', version: 'v1' })),
    writeFile: vi.fn(async (_project, path, content) => ({ path, content, version: 'v2' })),
    importPdf: async () => null,
    readPdf: async () => new Uint8Array(),
    gitStatus: async () => [],
    listModels: async () => [],
    testModel: async () => {},
    askAI: async () => '',
    fetchArxiv: async () => '',
  };
  return {
    backend,
    store: createWorkspaceStore(workspaceBackend),
    project,
    mode: 'writing' as const,
    view: 'files',
    onContext: vi.fn(),
  };
}

it('retries a failed disk reread from the error action', async () => {
  const props = setup();
  const user = userEvent.setup();
  render(<FileWorkspace {...props} activePath="paper.md" />);
  await screen.findByRole('textbox', { name: '编辑 paper.md' });
  vi.mocked(props.backend.readFile).mockRejectedValueOnce(new Error('暂时无法读取'));
  await user.click(screen.getByRole('button', { name: '重新读取文件' }));
  expect((await screen.findByRole('alert')).textContent).toContain('暂时无法读取');
  await screen.findByText('暂时无法读取');
  vi.mocked(props.backend.readFile).mockResolvedValueOnce({
    path: 'paper.md',
    content: '# Updated',
    version: 'v2',
  });
  await user.click(screen.getByRole('button', { name: '重试' }));
  await waitFor(() =>
    expect(
      (screen.getByRole('textbox', { name: '编辑 paper.md' }) as HTMLTextAreaElement).value,
    ).toBe('# Updated'),
  );
  expect(props.backend.readFile).toHaveBeenCalledTimes(3);
});

it('retains the file name after creation fails and retries the exact path', async () => {
  const props = setup();
  vi.mocked(props.backend.writeFile).mockRejectedValueOnce(new Error('目录只读'));
  const user = userEvent.setup();
  render(<FileWorkspace {...props} />);
  await user.click(screen.getAllByRole('button', { name: '新建文件' })[0]);
  await user.type(screen.getByLabelText('文件路径'), 'chapters/intro.md');
  await user.click(screen.getByRole('button', { name: '创建' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', '目录只读');
  expect((screen.getByLabelText('文件路径') as HTMLInputElement).value).toBe('chapters/intro.md');
  await user.click(screen.getByRole('button', { name: '创建' }));
  await screen.findByRole('textbox', { name: '编辑 chapters/intro.md' });
  expect(props.backend.writeFile).toHaveBeenLastCalledWith('p1', 'chapters/intro.md', '', null);
});

it('preserves an edited buffer on navigation remount and shares it with experiments', async () => {
  const props = setup();
  const user = userEvent.setup();
  const view = render(<FileWorkspace {...props} activePath="paper.md" />);
  const editor = await screen.findByRole('textbox', { name: '编辑 paper.md' });
  await user.type(editor, '\nConclusion');
  view.unmount();
  render(<FileWorkspace {...props} mode="experiments" activePath="paper.md" />);
  expect(
    ((await screen.findByRole('textbox', { name: '编辑 paper.md' })) as HTMLTextAreaElement).value,
  ).toBe('# Draft\nConclusion');
  expect(props.backend.readFile).toHaveBeenCalledTimes(1);
});

it('saves a conflict copy with the current buffer and never silently overwrites the original', async () => {
  const props = setup();
  const user = userEvent.setup();
  vi.mocked(props.backend.writeFile).mockRejectedValueOnce(new Error('版本冲突'));
  render(<FileWorkspace {...props} activePath="paper.md" />);
  const editor = await screen.findByRole('textbox', { name: '编辑 paper.md' });
  await user.clear(editor);
  await user.type(editor, '# My important conclusion');
  await user.click(screen.getByRole('button', { name: '保存' }));
  await screen.findByText('版本冲突');
  expect(
    (screen.getByRole('textbox', { name: '编辑 paper.md' }) as HTMLTextAreaElement).value,
  ).toBe('# My important conclusion');
  await user.click(screen.getByRole('button', { name: '另存副本' }));
  await user.type(screen.getByLabelText('副本路径'), 'paper-recovered.md');
  await user.click(screen.getByRole('button', { name: '创建' }));
  await waitFor(() =>
    expect(props.backend.writeFile).toHaveBeenLastCalledWith(
      'p1',
      'paper-recovered.md',
      '# My important conclusion',
      null,
    ),
  );
});

it('requires explicit discard before a reread replaces an unsaved buffer', async () => {
  const props = setup();
  const user = userEvent.setup();
  render(<FileWorkspace {...props} activePath="paper.md" />);
  await user.type(await screen.findByRole('textbox', { name: '编辑 paper.md' }), ' unsaved');
  vi.mocked(props.backend.readFile).mockResolvedValue({
    path: 'paper.md',
    content: 'External revision',
    version: 'v3',
  });
  await user.click(screen.getByRole('button', { name: '重新读取文件' }));
  expect(props.backend.readFile).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole('button', { name: '保留编辑' }));
  expect(
    (screen.getByRole('textbox', { name: '编辑 paper.md' }) as HTMLTextAreaElement).value,
  ).toBe('# Draft unsaved');
  await user.click(screen.getByRole('button', { name: '重新读取文件' }));
  await act(async () => {
    await user.click(screen.getByRole('button', { name: '丢弃编辑并重新读取' }));
  });
  expect(
    (screen.getByRole('textbox', { name: '编辑 paper.md' }) as HTMLTextAreaElement).value,
  ).toBe('External revision');
});
