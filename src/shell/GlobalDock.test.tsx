import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useStore } from 'zustand';
import { emptyWorkspace } from '../domain/workspace';
import type { WorkContext } from '../domain/context';
import type { WorkspaceBackend } from '../platform/desktop';
import type { ResearchBackend } from '../platform/research';
import { createWorkspaceStore, type WorkspaceStore } from '../stores/workspace';
import { GlobalDock } from './GlobalDock';

afterEach(cleanup);

function Harness({
  store,
  context,
  tool,
}: {
  store: WorkspaceStore;
  context: WorkContext;
  tool: 'notes' | 'assistant';
}) {
  // The application observes global save state; dock callbacks must not create a loop.
  const state = useStore(store);
  return (
    <>
      <span>{state.dirty ? '有草稿' : '已同步'}</span>
      <GlobalDock
        store={store}
        backend={{ askAI: vi.fn() } as unknown as ResearchBackend}
        tool={tool}
        context={context}
        onClose={() => {}}
        onToolChange={() => {}}
        onDirtyChange={() => {}}
      />
    </>
  );
}

it('retains drafts across tool and project switches while hiding other project conversations', async () => {
  const data = emptyWorkspace();
  const adapter: WorkspaceBackend = {
    load: async () => ({ workspace: data, directory: '', legacyAvailable: false }),
    save: async (value) => value,
    restore: async () => data,
    migrateLegacy: async () => data,
    importWorkspace: async () => null,
    exportWorkspace: async () => true,
    chooseDirectory: async () => null,
  };
  const store = createWorkspaceStore(adapter);
  await store.getState().load();
  const user = userEvent.setup();
  const p1: WorkContext = { projectId: 'p1', workspace: 'overview', title: '项目一' };
  const p2: WorkContext = { projectId: 'p2', workspace: 'overview', title: '项目二' };
  const view = render(<Harness store={store} context={p1} tool="assistant" />);
  await user.type(screen.getByRole('textbox', { name: '向 AI 提问' }), '项目一的草稿');
  view.rerender(<Harness store={store} context={p1} tool="notes" />);
  expect(screen.queryByRole('textbox', { name: '向 AI 提问' })).toBeNull();
  view.rerender(<Harness store={store} context={p2} tool="assistant" />);
  expect((screen.getByRole('textbox', { name: '向 AI 提问' }) as HTMLTextAreaElement).value).toBe(
    '',
  );
  await user.type(screen.getByRole('textbox', { name: '向 AI 提问' }), '项目二的草稿');
  view.rerender(<Harness store={store} context={p1} tool="assistant" />);
  expect((screen.getByRole('textbox', { name: '向 AI 提问' }) as HTMLTextAreaElement).value).toBe(
    '项目一的草稿',
  );
  expect(store.getState().dirtySources['assistant:p1']).toBe(true);
  expect(store.getState().dirtySources['assistant:p2']).toBe(true);
});
