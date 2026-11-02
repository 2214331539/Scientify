import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProjectSidebar } from './ProjectSidebar';

const api = vi.hoisted(() => ({ status: vi.fn(), logout: vi.fn() }));
const prompts = vi.hoisted(() => ({ confirmAction: vi.fn(async () => true) }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }));
vi.mock('../../components/prompts', () => prompts);
vi.mock('../settings/Appearance', () => ({ AppearanceControls: () => null }));
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

function sidebar(onCollaborationSettings = vi.fn()) {
  render(
    <ProjectSidebar
      space="personal"
      ready
      onSpace={() => {}}
      onSettings={() => {}}
      onCollaborationSettings={onCollaborationSettings}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it('asks for the sign-in page instead of opening settings when signed out', async () => {
  const user = userEvent.setup();
  const requested = vi.fn();
  window.addEventListener('scientify-sign-in-request', requested);
  api.status.mockResolvedValue(state);
  sidebar();
  await waitFor(() => expect(api.status).toHaveBeenCalled());
  await user.click(screen.getByRole('button', { name: '登录协作' }));
  expect(requested).toHaveBeenCalledOnce();
  expect(screen.queryByRole('menu')).toBeNull();
  window.removeEventListener('scientify-sign-in-request', requested);
});

it('offers the account menu when signed in and signs out after confirming', async () => {
  const user = userEvent.setup();
  const onCollaborationSettings = vi.fn();
  api.status.mockResolvedValue({ ...state, authenticated: true, phone: '13800138000' });
  api.logout.mockImplementation(async () => {
    api.status.mockResolvedValue(state);
    return state;
  });
  sidebar(onCollaborationSettings);
  const account = await screen.findByRole('button', { name: /138\*\*\*\*8000/ });
  await user.click(account);
  await user.click(await screen.findByRole('menuitem', { name: '同步与协作设置' }));
  expect(onCollaborationSettings).toHaveBeenCalledOnce();

  await user.click(account);
  await user.click(await screen.findByRole('menuitem', { name: '退出登录' }));
  await waitFor(() => expect(api.logout).toHaveBeenCalledOnce());
  expect(prompts.confirmAction).toHaveBeenCalledOnce();
  expect(await screen.findByRole('button', { name: '登录协作' })).toBeTruthy();
});
