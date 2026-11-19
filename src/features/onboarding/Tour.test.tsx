import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Tour } from './Tour';
import { Onboarding } from './Onboarding';
import { emptyWorkspace } from '../../domain/workspace';
import { createWorkspaceStore } from '../../stores/workspace';
import type { WorkspaceBackend } from '../../platform/desktop';

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function Window() {
  return (
    <div>
      <button data-tour="new-project">新建项目</button>
      <button className="sf-searchbox">搜索</button>
      <button data-tour="help">帮助</button>
    </div>
  );
}

it('lights up each control in turn, leaves out what is not on screen and can go back', async () => {
  const user = userEvent.setup();
  const finish = vi.fn();
  // jsdom lays nothing out; give controls a size so they can be lit.
  const size = vi
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockReturnValue(new DOMRect(10, 10, 80, 24));
  render(
    <>
      <Window />
      <Tour
        label="导览"
        onFinish={finish}
        steps={[
          { title: '欢迎', body: '一分钟' },
          { target: '[data-tour="new-project"]', title: '项目', body: '一个课题一个项目' },
          { target: '[data-tour="missing"]', title: '不在屏幕上', body: '跳过' },
          { target: '[data-tour="help"]', title: '帮助', body: '再看一遍' },
        ]}
      />
    </>,
  );
  const dialog = screen.getByRole('dialog', { name: '导览' });
  expect(dialog.querySelector('.sf-tour-dim')).toBeTruthy();
  expect(screen.getByRole('heading', { name: '欢迎' })).toBeTruthy();
  await user.click(screen.getByRole('button', { name: '下一步' }));
  expect(screen.getByRole('heading', { name: '项目' })).toBeTruthy();
  expect(dialog.querySelector('.sf-tour-spot')).toBeTruthy();
  fireEvent.keyDown(window, { key: 'ArrowRight' });
  // The missing control's step is not shown.
  expect(screen.getByRole('heading', { name: '帮助' })).toBeTruthy();
  fireEvent.keyDown(window, { key: 'ArrowLeft' });
  expect(screen.getByRole('heading', { name: '项目' })).toBeTruthy();
  fireEvent.keyDown(window, { key: 'ArrowRight' });
  expect(screen.queryByRole('button', { name: '跳过' })).toBeNull();
  await user.click(screen.getByRole('button', { name: '开始使用' }));
  expect(finish).toHaveBeenCalledWith(true);
  size.mockRestore();
});

it('Escape skips the tour', () => {
  const finish = vi.fn();
  render(
    <Tour
      label="导览"
      onFinish={finish}
      steps={[
        { title: 'A', body: 'a' },
        { title: 'B', body: 'b' },
      ]}
    />,
  );
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(finish).toHaveBeenCalledWith(false);
});

it('shows the center tour once, and again from Help', async () => {
  vi.useFakeTimers();
  const backend = {
    load: async () => ({ workspace: emptyWorkspace(), directory: 'test', legacyAvailable: false }),
  } as unknown as WorkspaceBackend;
  const store = createWorkspaceStore(backend);
  const view = render(
    <>
      <Window />
      <Onboarding store={store} ready inProject={false} auto />
    </>,
  );
  await act(async () => vi.advanceTimersByTime(800));
  expect(screen.getByRole('heading', { name: '欢迎使用 Scientify' })).toBeTruthy();
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(screen.queryByRole('dialog', { name: '功能导览' })).toBeNull();
  expect(localStorage.getItem('scientify.tour.center.v1')).toBe('done');
  view.rerender(
    <>
      <Window />
      <Onboarding store={store} ready inProject={false} auto />
    </>,
  );
  await act(async () => vi.advanceTimersByTime(800));
  expect(screen.queryByRole('dialog', { name: '功能导览' })).toBeNull();
  act(() => {
    window.dispatchEvent(new Event('scientify-start-tour'));
  });
  expect(screen.getByRole('heading', { name: '欢迎使用 Scientify' })).toBeTruthy();
});
