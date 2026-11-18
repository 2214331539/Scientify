import { useCallback, useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { Button, Input } from '../../components/primitives';
import { t } from '../../i18n';
import {
  collaboration,
  type BillingSummary,
  type BillingUsage,
  type ModelDevice,
} from '../../platform/collaboration';
import { describeError } from '../account/account';

const day = (value: string) => value.slice(0, 10);
const points = (value: number) => Math.round(value).toLocaleString('en-US');
function size(bytes: number) {
  if (bytes >= 1024 ** 3)
    return `${(bytes / 1024 ** 3).toFixed(bytes >= 10 * 1024 ** 3 ? 1 : 2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function Meter({ value, total, label }: { value: number; total: number; label: string }) {
  const share = total > 0 ? Math.min(1, Math.max(0, value / total)) : 0;
  return (
    <div className="settings-meter" aria-label={label}>
      <div className="settings-meter-bar">
        <i
          style={{ width: `${share * 100}%` }}
          data-level={share >= 1 ? 'full' : share >= 0.85 ? 'high' : undefined}
        />
      </div>
      <span>{label}</span>
    </div>
  );
}

/** Settings → 账号与订阅: plan, points for the official models, storage, usage, codes and devices. */
export function SubscriptionPreferences() {
  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [usage, setUsage] = useState<BillingUsage | null>(null);
  const [devices, setDevices] = useState<ModelDevice[]>([]);
  const [error, setError] = useState('');
  const [code, setCode] = useState('');
  const [redeeming, setRedeeming] = useState(false);
  const [notice, setNotice] = useState('');
  const load = useCallback(async () => {
    try {
      const [nextSummary, nextUsage, nextDevices] = await Promise.all([
        collaboration.billing(),
        collaboration.billingUsage(30),
        collaboration.devices(),
      ]);
      setSummary(nextSummary);
      setUsage(nextUsage);
      setDevices(nextDevices.devices);
      setError('');
    } catch (reason) {
      setError(describeError(reason));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function redeem() {
    if (!code.trim()) return;
    setRedeeming(true);
    setNotice('');
    try {
      const { result } = await collaboration.redeem(code.trim());
      setCode('');
      setNotice(
        result.kind === 'points'
          ? t('已兑换 {points} 点。', { points: points(result.points) })
          : t('已开通{plan}，到期日 {date}。', { plan: result.plan, date: day(result.endsAt) }),
      );
      await load();
    } catch (reason) {
      setNotice(describeError(reason));
    } finally {
      setRedeeming(false);
    }
  }
  async function revoke(device: ModelDevice) {
    try {
      await collaboration.revokeDevice(device.id);
      setDevices((list) => list.filter((item) => item.id !== device.id));
    } catch (reason) {
      setError(describeError(reason));
    }
  }

  if (!summary)
    return (
      <section className="settings-subscription" aria-label={t('订阅')}>
        {error ? (
          <p role="alert" className="error-text">
            {error}
          </p>
        ) : (
          <p className="muted">
            <LoaderCircle className="is-spinning" /> {t('正在读取订阅…')}
          </p>
        )}
      </section>
    );

  const paid = !!summary.subscription;
  const peak = Math.max(1, ...(usage?.days.map((entry) => entry.points) ?? [0]));
  const extra = summary.grants.filter(
    (grant) => grant.source !== 'plan' && grant.source !== 'free',
  );
  return (
    <section className="settings-subscription" aria-label={t('订阅')}>
      <div className="settings-plan">
        <div>
          <strong>{summary.plan.name}</strong>
          <span className="muted">
            {paid
              ? t('{date} 到期', { date: day(summary.subscription!.endsAt) })
              : t('每月 1 日恢复 {points} 点', { points: points(summary.plan.monthlyPoints) })}
          </span>
        </div>
      </div>

      <h4>{t('官方模型额度')}</h4>
      <div className="settings-balance">
        <strong>{points(summary.balance)}</strong> <span className="muted">{t('点可用')}</span>
        <span className="muted settings-balance-reset">
          {t('{date} 恢复 {points} 点', {
            date: day(summary.period.end),
            points: points(summary.plan.monthlyPoints),
          })}
        </span>
      </div>
      <Meter
        value={summary.usedThisPeriod}
        total={summary.plan.monthlyPoints}
        // The plan's points come each month ("本周期" read as "this week").
        label={t('本月已用 {used} / {total} 点', {
          used: points(summary.usedThisPeriod),
          total: points(summary.plan.monthlyPoints),
        })}
      />
      {extra.length ? (
        <ul className="settings-grants">
          {extra.map((grant) => (
            <li key={grant.id}>
              <span>{t(grant.label)}</span>
              <span className="muted">
                {t('剩 {left} 点 · {date} 到期', {
                  left: points(grant.left),
                  date: day(grant.expiresAt),
                })}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="muted">
        {t('今天已用 {used} 点，单日上限 {limit} 点，防止对话失控时用光整月的额度。', {
          used: points(summary.usedToday),
          limit: points(summary.limits.dailyPoints),
        })}
        {summary.debt
          ? ` ${t('欠 {debt} 点，下次发放额度时先抵扣。', { debt: points(summary.debt) })}`
          : ''}
      </p>

      <h4>{t('同步空间')}</h4>
      <Meter
        value={summary.storage.usedBytes}
        total={summary.storage.limitBytes}
        label={`${size(summary.storage.usedBytes)} / ${size(summary.storage.limitBytes)}`}
      />
      <p className="muted">{t('按你拥有的项目计算，加入别人的项目不占你的空间。')}</p>

      {usage ? (
        <>
          <h4>{t('近 30 天用量')}</h4>
          <div className="settings-usage" role="img" aria-label={t('近 30 天每天的官方模型用量')}>
            {usage.days.map((entry) => (
              <i
                key={entry.day}
                title={`${entry.day.slice(5)}：${points(entry.points)}`}
                style={{ height: `${Math.max(2, (entry.points / peak) * 100)}%` }}
              />
            ))}
          </div>
        </>
      ) : null}

      <h4>{t('兑换码')}</h4>
      <form
        className="settings-redeem"
        onSubmit={(event) => {
          event.preventDefault();
          void redeem();
        }}
      >
        <Input
          aria-label={t('兑换码')}
          placeholder="SFY-XXXX-XXXX-XXXX"
          maxLength={64}
          value={code}
          onChange={(event) => setCode(event.target.value)}
        />
        <Button type="submit" disabled={redeeming || !code.trim()}>
          {redeeming ? <LoaderCircle className="is-spinning" /> : null}
          {t('兑换')}
        </Button>
      </form>
      {notice ? <p className="muted">{notice}</p> : null}

      {devices.length ? (
        <>
          <h4>{t('使用官方模型的设备')}</h4>
          <ul className="settings-devices">
            {devices.map((device) => (
              <li key={device.id}>
                <span>
                  {device.deviceName}
                  {device.current ? <span className="muted"> · {t('这台电脑')}</span> : null}
                </span>
                {device.current ? null : (
                  <Button size="sm" onClick={() => void revoke(device)}>
                    {t('移除')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {error ? (
        <p role="alert" className="error-text">
          {error}
        </p>
      ) : null}
    </section>
  );
}
