import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { ModelPreferences } from './ModelPreferences';
import { createWorkspaceStore } from '../../stores/workspace';
import { emptyWorkspace, type Workspace } from '../../domain/workspace';
import type { WorkspaceBackend } from '../../platform/desktop';
import type { ResearchBackend } from '../../platform/research';
import type { CredentialBackend } from '../../platform/credentials';

vi.mock('../../platform/collaboration', () => ({
  collaboration: {
    status: vi.fn(async () => ({ endpoint: 'https://official.example' })),
    accessToken: vi.fn(async () => 'token'),
  },
}));

afterEach(cleanup);

const verified = { model: 'deepseek-flash', checkedAt: '', chat: true, agent: true };

async function fixture() {
  const data = emptyWorkspace();
  data.settings.modelProfiles = [
    {
      id: 'deepseek',
      name: 'DeepSeek',
      provider: 'openai',
      serviceId: 'deepseek',
      endpoint: 'https://api.deepseek.com',
      model: 'deepseek-flash',
      verification: verified,
    },
    {
      id: 'local',
      name: '本机 Ollama',
      provider: 'ollama',
      serviceId: 'ollama',
      endpoint: 'http://127.0.0.1:11434',
      model: 'qwen3',
      verification: { ...verified, model: 'qwen3', agent: false },
    },
  ];
  data.settings.defaultModelProfileId = 'deepseek';
  const store = createWorkspaceStore({
    load: async () => ({ workspace: data, directory: 'test', legacyAvailable: false }),
    save: vi.fn(async (value: Workspace) => value),
  } as unknown as WorkspaceBackend);
  await store.getState().load();
  const credentials: CredentialBackend = {
    load: vi.fn(async () => 'sk-stored'),
    save: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
  };
  const backend = {
    listModels: vi.fn(async () => [{ id: 'deepseek-flash', name: 'deepseek-flash' }]),
    testModel: vi.fn(),
    verifyModel: vi.fn(async () => ({ chat: true, agent: true })),
  } as unknown as ResearchBackend;
  render(<ModelPreferences store={store} backend={backend} credentials={credentials} />);
  return { store, credentials, backend, user: userEvent.setup() };
}

it('lists connections with their default and verified abilities', async () => {
  const { store, user } = await fixture();
  const rows = screen.getAllByRole('listitem');
  expect(within(rows[0]).getByText('DeepSeek')).toBeTruthy();
  expect(within(rows[0]).getByText('默认')).toBeTruthy();
  expect(within(rows[1]).getByText('Agent').dataset.tone).toBe('bad');
  await user.click(within(rows[1]).getByRole('button', { name: '设为默认' }));
  await waitFor(() => expect(store.getState().data?.settings.defaultModelProfileId).toBe('local'));
  expect(store.getState().data?.settings.model.model).toBe('qwen3');
});

it('leaves an edit without saving anything', async () => {
  const { store, credentials, user } = await fixture();
  await user.click(
    within(screen.getAllByRole('listitem')[1]).getByRole('button', { name: '编辑' }),
  );
  await waitFor(() =>
    expect((screen.getByLabelText('API 密钥') as HTMLInputElement).value).toBe('sk-stored'),
  );
  const name = screen.getByRole('textbox', { name: '连接名称' });
  await user.clear(name);
  await user.type(name, '实验室服务器');
  await user.click(screen.getByRole('button', { name: '全部连接' }));
  expect(screen.getByText('本机 Ollama')).toBeTruthy();
  expect(credentials.save).not.toHaveBeenCalled();
  expect(store.getState().data?.settings.defaultModelProfileId).toBe('deepseek');
});

it('verifies and saves an edited connection as the default', async () => {
  const { store, credentials, backend, user } = await fixture();
  await user.click(
    within(screen.getAllByRole('listitem')[0]).getByRole('button', { name: '编辑' }),
  );
  await waitFor(() =>
    expect((screen.getByLabelText('API 密钥') as HTMLInputElement).value).toBe('sk-stored'),
  );
  const name = screen.getByRole('textbox', { name: '连接名称' });
  await user.clear(name);
  await user.type(name, 'DeepSeek 主力');
  await user.click(screen.getByRole('button', { name: '测试连接' }));
  await user.click(await screen.findByRole('button', { name: '保存模型配置' }));
  await waitFor(() => expect(screen.getByText('DeepSeek 主力')).toBeTruthy());
  expect(backend.verifyModel).toHaveBeenCalled();
  expect(credentials.save).toHaveBeenCalledWith(
    { provider: 'openai', endpoint: 'https://api.deepseek.com' },
    'sk-stored',
  );
  expect(store.getState().data?.settings.defaultModelProfileId).toBe('deepseek');
  expect(store.getState().data?.settings.modelProfiles?.[0].name).toBe('DeepSeek 主力');
});
