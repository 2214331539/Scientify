import { expect, it, vi } from 'vitest';
import type { FileContent, ResearchBackend } from '../platform/research';
import {
  beginFileOperation,
  FileSession,
  getFileSession,
  hasPendingFileOperations,
  hasUnsavedFileChanges,
  invalidateProjectFileSessions,
} from './sessions';

function backend() {
  let disk = { path: 'paper.md', content: '# Original', version: 'v1' };
  const result: ResearchBackend = {
    listFiles: async () => [],
    readFile: vi.fn(async () => ({ ...disk })),
    writeFile: vi.fn(async (_projectId, path, content, expectedVersion) => {
      if (expectedVersion !== disk.version) throw new Error('文件已被外部修改，请比较后重试');
      disk = { path, content, version: 'v2' };
      return { ...disk };
    }),
    importPdf: async () => null,
    readPdf: async () => new Uint8Array(),
    gitStatus: async () => [],
    listModels: async () => [],
    testModel: async () => {},
    askAI: async () => '',
    fetchArxiv: async () => '',
  };
  return {
    result,
    externalEdit: (content: string) => {
      disk = { ...disk, content, version: 'external' };
    },
  };
}

it('shares a buffer across workspace views but isolates projects and backend instances', async () => {
  const { result } = backend();
  const session = getFileSession(result, 'project-a', 'paper.md');
  await session.load();
  session.edit('A draft');
  expect(getFileSession(result, 'project-a', 'paper.md')).toBe(session);
  expect(getFileSession(result, 'project-b', 'paper.md')).not.toBe(session);
  expect(getFileSession(backend().result, 'project-a', 'paper.md')).not.toBe(session);
  expect(hasUnsavedFileChanges(result)).toBe(true);
  await getFileSession(result, 'project-a', 'paper.md').load();
  expect(session.getSnapshot().content).toBe('A draft');
});

it('keeps later input dirty when an earlier save finishes', async () => {
  const { result } = backend();
  let complete!: (file: FileContent) => void;
  result.writeFile = vi.fn(
    () =>
      new Promise<FileContent>((resolve) => {
        complete = resolve;
      }),
  );
  const session = new FileSession(result, 'project-a', 'paper.md');
  await session.load();
  session.edit('First edit');
  const saving = session.save();
  session.edit('Later input');
  complete({ path: 'paper.md', content: 'First edit', version: 'v2' });
  expect(await saving).toBe(true);
  expect(session.getSnapshot()).toMatchObject({
    content: 'Later input',
    version: 'v2',
    dirty: true,
    phase: 'ready',
  });
  expect(result.writeFile).toHaveBeenCalledWith('project-a', 'paper.md', 'First edit', 'v1');
});

it('preserves the buffer and expected version on external modification conflict', async () => {
  const { result, externalEdit } = backend();
  const session = new FileSession(result, 'project-a', 'paper.md');
  await session.load();
  session.edit('My unsaved result');
  externalEdit('Changed by another editor');
  expect(await session.save()).toBe(false);
  expect(session.getSnapshot()).toMatchObject({
    content: 'My unsaved result',
    version: 'v1',
    dirty: true,
  });
  expect(session.getSnapshot().error).toContain('外部修改');
  expect((await result.readFile('project-a', 'paper.md')).content).toBe(
    'Changed by another editor',
  );
});

it('retains failed writes and allows retry without losing the draft', async () => {
  const { result } = backend();
  vi.mocked(result.writeFile).mockRejectedValueOnce(new Error('磁盘空间不足'));
  const session = new FileSession(result, 'project-a', 'paper.md');
  await session.load();
  session.edit('Important experiment conclusion');
  expect(await session.save()).toBe(false);
  expect(session.getSnapshot()).toMatchObject({
    content: 'Important experiment conclusion',
    dirty: true,
    error: '磁盘空间不足',
  });
  expect(await session.save()).toBe(true);
  expect(session.getSnapshot()).toMatchObject({ dirty: false, error: null });
});

it('returns clean when edits are undone to the saved baseline', async () => {
  const { result } = backend();
  const session = new FileSession(result, 'project-a', 'paper.md');
  await session.load();
  session.edit('temporary');
  session.edit('# Original');
  expect(session.getSnapshot().dirty).toBe(false);
  expect(await session.save()).toBe(true);
  expect(result.writeFile).not.toHaveBeenCalled();
});

it('does not destroy edits if a reread fails or arrives after new input', async () => {
  const { result } = backend();
  const session = new FileSession(result, 'project-a', 'paper.md');
  await session.load();
  session.edit('Keep this');
  vi.mocked(result.readFile).mockRejectedValueOnce(new Error('文件不可读'));
  expect(await session.reloadDiscardingEdits()).toBe(false);
  expect(session.getSnapshot().content).toBe('Keep this');
  let complete!: (file: FileContent) => void;
  result.readFile = vi.fn(
    () =>
      new Promise<FileContent>((resolve) => {
        complete = resolve;
      }),
  );
  const loading = session.reloadDiscardingEdits();
  session.edit('Even newer');
  complete({ path: 'paper.md', content: 'disk', version: 'v9' });
  expect(await loading).toBe(false);
  expect(session.getSnapshot()).toMatchObject({ content: 'Even newer', dirty: true });
});

it('deduplicates concurrent reads and does not save during a pending save', async () => {
  const { result } = backend();
  const session = new FileSession(result, 'project-a', 'paper.md');
  await Promise.all([session.load(), session.load()]);
  expect(result.readFile).toHaveBeenCalledTimes(1);
  session.edit('draft');
  let complete!: (file: FileContent) => void;
  result.writeFile = vi.fn(
    () =>
      new Promise<FileContent>((resolve) => {
        complete = resolve;
      }),
  );
  const saving = session.save();
  expect(await session.save()).toBe(false);
  complete({ path: 'paper.md', content: 'draft', version: 'v2' });
  await saving;
  expect(result.writeFile).toHaveBeenCalledTimes(1);
});

it('keeps a save pending even after the user undoes back to the old baseline', async () => {
  const { result } = backend();
  const session = getFileSession(result, 'project-a', 'paper.md');
  await session.load();
  session.edit('submitted');
  let complete!: (file: FileContent) => void;
  result.writeFile = vi.fn(
    () =>
      new Promise<FileContent>((resolve) => {
        complete = resolve;
      }),
  );
  const saving = session.save();
  session.edit('# Original');
  expect(hasUnsavedFileChanges(result)).toBe(false);
  expect(hasPendingFileOperations(result)).toBe(true);
  expect(invalidateProjectFileSessions(result, 'project-a')).toBe(false);
  complete({ path: 'paper.md', content: 'submitted', version: 'v2' });
  await saving;
  expect(hasPendingFileOperations(result)).toBe(false);
  expect(hasUnsavedFileChanges(result)).toBe(true);
});

it('tracks new file writes and invalidates only clean sessions in the rebound project', async () => {
  const { result } = backend();
  const original = getFileSession(result, 'project-a', 'paper.md');
  const otherProject = getFileSession(result, 'project-b', 'paper.md');
  await original.load();
  const finish = beginFileOperation(result);
  expect(hasPendingFileOperations(result)).toBe(true);
  expect(invalidateProjectFileSessions(result, 'project-a')).toBe(false);
  finish();
  finish();
  expect(hasPendingFileOperations(result)).toBe(false);
  original.edit('draft');
  expect(invalidateProjectFileSessions(result, 'project-a')).toBe(false);
  original.edit('# Original');
  expect(invalidateProjectFileSessions(result, 'project-a')).toBe(true);
  expect(getFileSession(result, 'project-a', 'paper.md')).not.toBe(original);
  expect(getFileSession(result, 'project-b', 'paper.md')).toBe(otherProject);
});

it('blocks saves, duplicate reads and root rebinding while a reread is pending', async () => {
  const { result } = backend();
  const session = getFileSession(result, 'project-a', 'paper.md');
  await session.load();
  session.edit('draft');
  let complete!: (file: FileContent) => void;
  result.readFile = vi.fn(
    () =>
      new Promise<FileContent>((resolve) => {
        complete = resolve;
      }),
  );
  const reading = session.reloadDiscardingEdits();
  expect(await session.save()).toBe(false);
  expect(await session.reloadDiscardingEdits()).toBe(false);
  expect(hasPendingFileOperations(result)).toBe(true);
  expect(invalidateProjectFileSessions(result, 'project-a')).toBe(false);
  expect(result.writeFile).not.toHaveBeenCalled();
  complete({ path: 'paper.md', content: 'disk', version: 'v3' });
  expect(await reading).toBe(true);
  expect(hasPendingFileOperations(result)).toBe(false);
  expect(session.getSnapshot()).toMatchObject({ content: 'disk', version: 'v3', dirty: false });
});

it('preserves an edit followed by undo during a reread and allows retry after failure', async () => {
  const { result } = backend();
  const session = new FileSession(result, 'project-a', 'paper.md');
  await session.load();
  let complete!: (file: FileContent) => void;
  vi.mocked(result.readFile).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const reading = session.reloadDiscardingEdits();
  session.edit('temporary');
  session.edit('# Original');
  complete({ path: 'paper.md', content: 'external', version: 'v3' });
  expect(await reading).toBe(false);
  expect(session.getSnapshot()).toMatchObject({ content: '# Original', phase: 'ready' });
  vi.mocked(result.readFile).mockRejectedValueOnce(new Error('offline'));
  expect(await session.reloadDiscardingEdits()).toBe(false);
  expect(session.getSnapshot().phase).toBe('ready');
  expect(await session.reloadDiscardingEdits()).toBe(true);
  expect(session.getSnapshot().error).toBeNull();
});
