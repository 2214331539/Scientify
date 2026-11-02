import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SignInPage } from './SignInPage';
import { describeError, isPhone, maskPhone, normalizePhone } from './account';

const api = vi.hoisted(() => ({
  status: vi.fn(),
  sendCode: vi.fn(),
  login: vi.fn(),
  health: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    isMaximized: async () => false,
    onResized: async () => () => {},
  }),
}));
vi.mock('../../platform/browser-pane', () => ({ browserLayout: vi.fn(async () => {}) }));
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
  api.status.mockResolvedValue(signedOut);
  api.sendCode.mockResolvedValue({ accepted: true });
  api.login.mockResolvedValue({ ...signedOut, authenticated: true, phone: '13800138000' });
  api.health.mockResolvedValue({ ok: true });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it('signs in with a phone number and SMS code, then closes', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  const changed = vi.fn();
  window.addEventListener('scientify-collaboration-state-changed', changed);
  render(<SignInPage onClose={onClose} />);
  expect(await screen.findByRole('dialog', { name: '登录 Scientify' })).toBeTruthy();
  await waitFor(() => expect(api.status).toHaveBeenCalled());

  await user.type(screen.getByLabelText('手机号'), '138 0013 8000');
  await user.click(screen.getByRole('button', { name: '获取验证码' }));
  expect(api.sendCode).toHaveBeenCalledWith(endpoint, '13800138000');
  expect(await screen.findByRole('button', { name: '60 秒后重发' })).toHaveProperty(
    'disabled',
    true,
  );
  expect(screen.getByRole('status').textContent).toBe('验证码已发送至 138****8000');

  await user.type(screen.getByLabelText('验证码'), '12a3456');
  await user.click(screen.getByRole('button', { name: '登录' }));
  expect(api.login).toHaveBeenCalledWith(endpoint, '13800138000', '123456');
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(changed).toHaveBeenCalled();
  window.removeEventListener('scientify-collaboration-state-changed', changed);
});

it('checks the number before asking the server for a code', async () => {
  const user = userEvent.setup();
  render(<SignInPage onClose={() => {}} />);
  await waitFor(() => expect(api.status).toHaveBeenCalled());
  await user.type(screen.getByLabelText('手机号'), '12345');
  await user.click(screen.getByRole('button', { name: '获取验证码' }));
  expect(screen.getByText('请输入正确的 11 位手机号。')).toBeTruthy();
  expect(screen.getByLabelText('手机号').getAttribute('aria-invalid')).toBe('true');
  expect(api.sendCode).not.toHaveBeenCalled();
});

it("shows the server's reason without the HTTP wrapper and stays open", async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  api.login.mockRejectedValue('协作服务器请求失败（HTTP 400 Bad Request）：验证码不正确。');
  render(<SignInPage onClose={onClose} />);
  await waitFor(() => expect(api.status).toHaveBeenCalled());
  await user.type(screen.getByLabelText('手机号'), '13800138000');
  await user.type(screen.getByLabelText('验证码'), '000000');
  await user.click(screen.getByRole('button', { name: '登录' }));
  expect((await screen.findByRole('alert')).textContent).toBe('验证码不正确。');
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: '登录' })).toHaveProperty('disabled', false);
});

it('closes right away for an account that is already signed in', async () => {
  const onClose = vi.fn();
  api.status.mockResolvedValue({ ...signedOut, authenticated: true, phone: '13800138000' });
  render(<SignInPage onClose={onClose} />);
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
});

it('goes back with the back button and checks a self-hosted server', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  render(<SignInPage onClose={onClose} />);
  await waitFor(() => expect(api.status).toHaveBeenCalled());
  await user.click(screen.getByText('使用自托管协作服务'));
  const address = screen.getByLabelText('服务器地址');
  expect((address as HTMLInputElement).value).toBe(endpoint);
  await user.clear(address);
  await user.type(address, 'https://self.example');
  await user.click(screen.getByRole('button', { name: '检查连接' }));
  expect(api.health).toHaveBeenCalledWith('https://self.example');
  expect(await screen.findByText('协作服务连接正常。')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: '返回' }));
  expect(onClose).toHaveBeenCalledOnce();
});

it('reads phone numbers and failures the way people write and expect them', () => {
  expect(normalizePhone('+86 138-0013-8000')).toBe('13800138000');
  expect(isPhone('8613800138000')).toBe(true);
  expect(isPhone('1380013800')).toBe(false);
  expect(isPhone('12800138000')).toBe(false);
  expect(maskPhone('13800138000')).toBe('138****8000');
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
