import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SubscriptionPreferences } from './SubscriptionPreferences';
import { officialModelProblem, type BillingSummary } from '../../platform/collaboration';
import { OfficialModelNotice } from '../assistant/OfficialModelNotice';

const api = vi.hoisted(() => ({
  billing: vi.fn(),
  billingUsage: vi.fn(),
  devices: vi.fn(),
  redeem: vi.fn(),
  revokeDevice: vi.fn(),
}));
vi.mock('../../platform/collaboration', async (original) => ({
  ...(await original<typeof import('../../platform/collaboration')>()),
  collaboration: api,
}));

const summary = (balance: number): BillingSummary => ({
  plan: {
    id: 'free',
    name: '免费',
    monthlyPoints: 300,
    storageBytes: 2 * 1024 ** 3,
    maxMembers: 5,
    historyDays: 7,
  },
  subscription: null,
  period: { start: '2026-11-01T00:00:00Z', end: '2026-12-01T00:00:00Z' },
  balance,
  debt: 0,
  usedThisPeriod: 120,
  usedToday: 40,
  limits: { dailyPoints: 400, rpm: 30, concurrency: 2 },
  grants: [
    {
      id: 'g1',
      source: 'free',
      label: '免费版月度额度',
      note: '',
      points: 300,
      left: 180,
      startsAt: '2026-11-01',
      expiresAt: '2026-12-01',
    },
    {
      id: 'g2',
      source: 'signup',
      label: '注册赠送',
      note: '',
      points: 1000,
      left: 1000,
      startsAt: '2026-11-10',
      expiresAt: '2026-12-10',
    },
  ],
  storage: { usedBytes: 300 * 1024 ** 2, limitBytes: 2 * 1024 ** 3 },
});

beforeEach(() => {
  api.billing.mockResolvedValue(summary(1180));
  api.billingUsage.mockResolvedValue({
    days: [{ day: '2026-11-16', points: 40, models: {} }],
    models: [],
  });
  api.devices.mockResolvedValue({
    devices: [
      {
        id: 't1',
        deviceId: 'here',
        deviceName: 'Windows · LAB-PC',
        createdAt: '',
        lastUsedAt: null,
        current: true,
      },
      {
        id: 't2',
        deviceId: 'mac',
        deviceName: 'Mac',
        createdAt: '',
        lastUsedAt: null,
        current: false,
      },
    ],
  });
  api.redeem.mockResolvedValue({ ok: true, result: { kind: 'points', points: 2000 } });
  api.revokeDevice.mockResolvedValue({ ok: true });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it('shows the plan, the points, the extra grants, storage and devices', async () => {
  render(<SubscriptionPreferences />);
  expect(await screen.findByText('1,180')).toBeTruthy();
  expect(screen.getByText('免费')).toBeTruthy();
  expect(screen.getByText('注册赠送')).toBeTruthy();
  expect(screen.getByText(/今天已用 40 点，单日上限 400 点/)).toBeTruthy();
  expect(screen.getByLabelText('300.0 MB / 2.00 GB')).toBeTruthy();
  // The device in use cannot be removed from here; the other one can.
  expect(screen.getAllByRole('button', { name: '移除' })).toHaveLength(1);
});

it('redeems a code and reloads the balance', async () => {
  const user = userEvent.setup();
  render(<SubscriptionPreferences />);
  await screen.findByText('1,180');
  api.billing.mockResolvedValue(summary(3180));
  await user.type(screen.getByRole('textbox', { name: '兑换码' }), ' SFY-AAAA-BBBB-CCCC ');
  await user.click(screen.getByRole('button', { name: '兑换' }));
  expect(api.redeem).toHaveBeenCalledWith('SFY-AAAA-BBBB-CCCC');
  expect(await screen.findByText('已兑换 2,000 点。')).toBeTruthy();
  await waitFor(() => expect(screen.getByText('3,180')).toBeTruthy());
});

it('reads the gateway codes out of an error and offers a way forward', async () => {
  expect(
    officialModelProblem(
      'unexpected status 402: {"error":"官方模型额度已用完。","code":"quota_exhausted"}',
    ),
  ).toBe('quota_exhausted');
  expect(officialModelProblem('网络错误')).toBeNull();
  const user = userEvent.setup();
  const opened = vi.fn();
  window.addEventListener('scientify-open-settings', opened);
  const choose = vi.fn();
  render(
    <OfficialModelNotice problem="quota_exhausted" onChooseModel={choose} onReconnect={() => {}} />,
  );
  await user.click(screen.getByRole('button', { name: '账号与订阅' }));
  expect((opened.mock.calls[0][0] as CustomEvent).detail).toBe('account');
  await user.click(screen.getByRole('button', { name: '改用自己的密钥' }));
  expect(choose).toHaveBeenCalled();
  window.removeEventListener('scientify-open-settings', opened);
});
