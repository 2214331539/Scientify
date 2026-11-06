import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProjectSidebar } from './ProjectSidebar';
import { cloudStore } from './cloud';

const api = vi.hoisted(() => ({ status: vi.fn(), logout: vi.fn() }));
const prompts = vi.hoisted(() => ({ confirmAction: vi.fn(async () => true) }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }));
vi.mock('../../components/prompts', () => prompts);
vi.mock('../../platform/collaboration', async (original) => ({
  ...(await original<typeof import('../../platform/collaboration')>()),
  collaboration: api,
}));

const state = {
  clientId: 'c1',
  enabled: true,
  endpoint: 'https://collab.test',
  authenticated: false,
  userId: null as string | null,
  phone: null as string | null,
};

function sidebar(handlers: Partial<Parameters<typeof ProjectSidebar>[0]> = {}) {
  const props = {
    page: 'home' as const,
    ready: true,
    counts: { mine: 3, team: 2, inbox: 1 },
    teamAlert: true,
    favorites: [{ id: 'p1', name: 'Alpha', color: '#496b8d', team: false }],
    onPage: vi.fn(),
    onOpen: vi.fn(),
    onSearch: vi.fn(),
    onSettings: vi.fn(),
    ...handlers,
  };
  render(<ProjectSidebar {...props} />);
  return props;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  cloudStore.setState({ state: null, reachable: true });
});

it('navigates between the four pages, opens favorites and the search', async () => {
  cloudStore.setState({ available: true, state });
  const user = userEvent.setup();
  const props = sidebar();
  expect(screen.getByRole('button', { name: /首页/ }).getAttribute('aria-current')).toBe('page');
  await user.click(screen.getByRole('button', { name: /我的项目/ }));
  expect(props.onPage).toHaveBeenCalledWith('mine');
  await user.click(screen.getByRole('button', { name: /团队项目/ }));
  expect(props.onPage).toHaveBeenCalledWith('team');
  expect(screen.getByLabelText('有需要处理的事项')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: /收集箱/ }));
  expect(props.onPage).toHaveBeenCalledWith('inbox');
  await user.click(screen.getByRole('button', { name: 'Alpha' }));
  expect(props.onOpen).toHaveBeenCalledWith('p1');
  await user.click(screen.getByRole('button', { name: /搜索/ }));
  expect(props.onSearch).toHaveBeenCalledOnce();
  await user.click(screen.getByRole('button', { name: '帮助' }));
  await user.click(await screen.findByRole('menuitem', { name: '快捷键' }));
  expect(props.onSettings).toHaveBeenCalledWith('shortcuts');
});

it('asks for the sign-in page instead of opening a menu when signed out', async () => {
  cloudStore.setState({ available: true, state });
  const user = userEvent.setup();
  const requested = vi.fn();
  window.addEventListener('scientify-sign-in-request', requested);
  sidebar();
  await user.click(screen.getByRole('button', { name: '登录' }));
  expect(requested).toHaveBeenCalledOnce();
  expect(screen.queryByRole('menu')).toBeNull();
  window.removeEventListener('scientify-sign-in-request', requested);
});

it('offers the account menu when signed in and signs out after confirming', async () => {
  cloudStore.setState({
    available: true,
    state: { ...state, authenticated: true, userId: 'u1', phone: '13800008000' },
  });
  api.logout.mockResolvedValue(state);
  const changed = vi.fn();
  window.addEventListener('scientify-collaboration-state-changed', changed);
  const user = userEvent.setup();
  const props = sidebar();
  const account = screen.getByRole('button', { name: /138\*\*\*\*8000/ });
  await user.click(account);
  await user.click(await screen.findByRole('menuitem', { name: '同步与协作设置' }));
  expect(props.onSettings).toHaveBeenCalledWith('collaboration');
  await user.click(account);
  await user.click(await screen.findByRole('menuitem', { name: '退出登录' }));
  await waitFor(() => expect(api.logout).toHaveBeenCalledOnce());
  expect(prompts.confirmAction).toHaveBeenCalledOnce();
  expect(changed).toHaveBeenCalled();
  window.removeEventListener('scientify-collaboration-state-changed', changed);
});
