import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { passwordProblem, SignInPage } from './SignInPage';
import { describeError, isPhone, maskPhone, normalizePhone } from './account';

const api = vi.hoisted(() => ({
  status: vi.fn(),
  sendCode: vi.fn(),
  signIn: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    isMaximized: async () => false,
    onResized: async () => () => {},
  }),
}));
vi.mock('../../platform/collaboration', async (original) => ({
  ...(await original<typeof import('../../platform/collaboration')>()),
  collaboration: api,
}));

const endpoint = 'https://collab.test';
const signedOut = {
  clientId: 'c1',
  enabled: true,
  endpoint,
  authenticated: false,
  userId: null,
  phone: null,
};

beforeEach(() => {
  localStorage.clear();
  api.status.mockResolvedValue(signedOut);
  api.sendCode.mockResolvedValue({ accepted: true });
  api.signIn.mockResolvedValue({ ...signedOut, authenticated: true, phone: '13800138000' });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it('is a page of its own with no way around it, and signs in with an SMS code', async () => {
  const user = userEvent.setup();
  const changed = vi.fn();
  window.addEventListener('scientify-collaboration-state-changed', changed);
  render(<SignInPage />);
  expect(await screen.findByRole('main', { name: '登录 Scientify' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: '返回' })).toBeNull();
  expect(screen.queryByText(/自托管/)).toBeNull();
  await waitFor(() => expect(api.status).toHaveBeenCalled());

  await user.type(screen.getByLabelText('手机号'), '138 0013 8000');
  await user.click(screen.getByRole('button', { name: '获取验证码' }));
  expect(api.sendCode).toHaveBeenCalledWith(endpoint, '13800138000');
  expect(await screen.findByRole('button', { name: '60 秒后重发' })).toHaveProperty(
    'disabled',
    true,
  );
  expect(screen.getByRole('status').textContent).toContain('138****8000');
  await user.type(screen.getByLabelText('验证码'), '123456');
  await user.click(screen.getByRole('button', { name: '登录' }));
  await waitFor(() =>
    expect(api.signIn).toHaveBeenCalledWith(endpoint, 'code', '13800138000', { code: '123456' }),
  );
  expect(changed).toHaveBeenCalled();
  window.removeEventListener('scientify-collaboration-state-changed', changed);
});

it('signs in with a password and remembers that choice', async () => {
  const user = userEvent.setup();
  render(<SignInPage />);
  await user.click(await screen.findByRole('tab', { name: '密码登录' }));
  expect(screen.queryByLabelText('验证码')).toBeNull();
  await user.type(screen.getByLabelText('手机号'), '13800138000');
  await user.type(screen.getByLabelText('密码'), 'secret2026');
  await user.click(screen.getByRole('button', { name: '显示密码' }));
  expect((screen.getByLabelText('密码') as HTMLInputElement).type).toBe('text');
  await user.click(screen.getByRole('button', { name: '登录' }));
  await waitFor(() =>
    expect(api.signIn).toHaveBeenCalledWith(endpoint, 'password', '13800138000', {
      password: 'secret2026',
    }),
  );
  cleanup();
  render(<SignInPage />);
  expect((await screen.findByRole('tab', { name: '密码登录' })).getAttribute('aria-selected')).toBe(
    'true',
  );
});

it('registers with a code and a confirmed password', async () => {
  const user = userEvent.setup();
  render(<SignInPage />);
  await user.click(await screen.findByRole('button', { name: '注册' }));
  expect(screen.getByRole('main', { name: '注册 Scientify' })).toBeTruthy();
  await user.type(screen.getByLabelText('手机号'), '13800138000');
  await user.type(screen.getByLabelText('验证码'), '123456');
  await user.type(screen.getByLabelText('密码'), 'onlyletters');
  await user.type(screen.getByLabelText('确认密码'), 'onlyletters');
  await user.click(screen.getByRole('button', { name: '注册' }));
  expect(screen.getByRole('alert').textContent).toBe('密码需要同时包含字母和数字。');
  await user.clear(screen.getByLabelText('密码'));
  await user.type(screen.getByLabelText('密码'), 'paper2026');
  await user.click(screen.getByRole('button', { name: '注册' }));
  expect(screen.getByRole('alert').textContent).toBe('两次输入的密码不一致。');
  await user.clear(screen.getByLabelText('确认密码'));
  await user.type(screen.getByLabelText('确认密码'), 'paper2026');
  await user.click(screen.getByRole('button', { name: '注册' }));
  await waitFor(() =>
    expect(api.signIn).toHaveBeenCalledWith(endpoint, 'register', '13800138000', {
      code: '123456',
      password: 'paper2026',
    }),
  );
  expect(api.signIn).toHaveBeenCalledTimes(1);
});

it('resets a forgotten password and shows what the server says', async () => {
  api.signIn.mockRejectedValueOnce(new Error('这个手机号还没有注册。'));
  const user = userEvent.setup();
  render(<SignInPage />);
  await user.click(await screen.findByRole('tab', { name: '密码登录' }));
  await user.click(screen.getByRole('button', { name: '忘记密码？' }));
  expect(screen.getByRole('main', { name: '找回密码' })).toBeTruthy();
  await user.type(screen.getByLabelText('手机号'), '13800138000');
  await user.type(screen.getByLabelText('验证码'), '654321');
  await user.type(screen.getByLabelText('新密码'), 'renewed2026');
  await user.type(screen.getByLabelText('确认密码'), 'renewed2026');
  await user.click(screen.getByRole('button', { name: '重置密码并登录' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', '这个手机号还没有注册。');
  await user.click(screen.getByRole('button', { name: '返回登录' }));
  expect(screen.getByRole('main', { name: '登录 Scientify' })).toBeTruthy();
});

it('reads phone numbers, passwords and failures the way people write and expect them', () => {
  expect(normalizePhone('+86 138-0013-8000')).toBe('13800138000');
  expect(isPhone('8613800138000')).toBe(true);
  expect(isPhone('1380013800')).toBe(false);
  expect(isPhone('12800138000')).toBe(false);
  expect(maskPhone('13800138000')).toBe('138****8000');
  expect(passwordProblem('abc123')).toBe('密码需要 8–64 位。');
  expect(passwordProblem('12345678')).toBe('密码需要同时包含字母和数字。');
  expect(passwordProblem('paper2026')).toBe('');
  expect(describeError('协作服务器连接失败：error sending request')).toBe(
    '无法连接协作服务，请检查网络后重试。',
  );
  expect(describeError('协作服务器请求失败（HTTP 429 Too Many Requests）：<html>busy</html>')).toBe(
    '请求过于频繁，请稍后再试。',
  );
  expect(describeError('协作服务器请求失败（HTTP 502 Bad Gateway）。')).toBe(
    '协作服务暂时不可用，请稍后再试。',
  );
  expect(describeError(new Error('请先登录协作账号。'))).toBe('请先登录协作账号。');
});
