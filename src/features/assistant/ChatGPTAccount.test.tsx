import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { ModelConnectionForm } from './ModelSettingsDialog';
import type { AISettings } from './model';
import type { ChatGPTAccount, ChatGPTBackend, ChatGPTSignIn } from '../../platform/chatgpt';
import type { ResearchBackend } from '../../platform/research';

afterEach(() => cleanup());

function fakeChatGPT() {
  let account: ChatGPTAccount = { signedIn: false, email: null, plan: null, waiting: false };
  let emit: ((event: ChatGPTSignIn) => void) | undefined;
  const backend = {
    account: vi.fn(async () => account),
    login: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    logout: vi.fn(async () => {
      account = { signedIn: false, email: null, plan: null, waiting: false };
    }),
    usage: vi.fn(async () => ({
      primary: { usedPercent: 32, windowDurationMins: 300, resetsAt: null },
      secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: null },
    })),
    models: vi.fn(async () => [{ id: 'gpt-5.5', name: 'GPT-5.5' }]),
    signedIn: vi.fn(async (callback: (event: ChatGPTSignIn) => void) => {
      emit = callback;
      return () => {};
    }),
  };
  const signIn = () => {
    account = { signedIn: true, email: 'me@example.com', plan: 'plus', waiting: false };
    return act(() => emit?.({ success: true, error: null }));
  };
  return { backend: backend as ChatGPTBackend & typeof backend, signIn };
}

function Form({
  chatgpt,
  research,
  onSave,
}: {
  chatgpt: ChatGPTBackend;
  research: ResearchBackend;
  onSave: (value: AISettings, key: string) => Promise<void>;
}) {
  const [value, setValue] = useState<AISettings>({
    provider: 'openai',
    endpoint: 'https://api.openai.com/v1',
    model: '',
    serviceId: 'openai',
  });
  const [key, setKey] = useState('');
  return (
    <ModelConnectionForm
      profileId="p"
      profileName=""
      onNameChange={() => {}}
      value={value}
      apiKey={key}
      keyStored={false}
      error=""
      saving={false}
      requestBusy={false}
      backend={research}
      loadKey={async () => ''}
      onChange={setValue}
      onKeyChange={setKey}
      onSave={onSave}
      onClose={() => {}}
      chatgpt={chatgpt}
    />
  );
}

it('signs in with a ChatGPT plan, shows its usage and saves a model without a key', async () => {
  const user = userEvent.setup();
  const { backend, signIn } = fakeChatGPT();
  const research = {
    listModels: vi.fn(),
    verifyModel: vi.fn(),
    testModel: vi.fn(),
  } as unknown as ResearchBackend;
  const onSave = vi.fn(async () => {});
  render(<Form chatgpt={backend} research={research} onSave={onSave} />);

  await user.selectOptions(screen.getByRole('combobox', { name: '模型提供方' }), 'chatgpt');
  expect(screen.queryByLabelText('API 密钥')).toBeNull();
  await user.click(await screen.findByRole('button', { name: '用 ChatGPT 登录' }));
  expect(backend.login).toHaveBeenCalled();
  expect(screen.getByText('请在浏览器里完成登录')).toBeTruthy();

  await signIn();
  expect(await screen.findByText('me@example.com')).toBeTruthy();
  expect(screen.getByText('Plus')).toBeTruthy();
  expect(await screen.findByText('5 小时额度')).toBeTruthy();
  expect(screen.getByText('每周额度')).toBeTruthy();
  expect(screen.getByText('已用 32%')).toBeTruthy();
  // Signing in is enough to list the plan's models.
  expect(await screen.findByRole('option', { name: 'GPT-5.5 · gpt-5.5' })).toBeTruthy();

  await user.click(screen.getByRole('button', { name: '保存模型配置' }));
  expect(onSave).toHaveBeenCalledWith(
    expect.objectContaining({ provider: 'chatgpt', serviceId: 'chatgpt', model: 'gpt-5.5' }),
    '',
  );
  expect(research.verifyModel).not.toHaveBeenCalled();

  await user.click(screen.getByRole('button', { name: '退出登录' }));
  expect(backend.logout).toHaveBeenCalled();
  expect(await screen.findByRole('button', { name: '用 ChatGPT 登录' })).toBeTruthy();
});
