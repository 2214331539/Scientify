import { useEffect, useRef, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { Button } from '../../components/primitives';
import { t, translateError } from '../../i18n';
import { errorMessage } from '../../domain/errors';
import {
  chatgpt as nativeChatGPT,
  type ChatGPTAccount as Account,
  type ChatGPTBackend,
  type ChatGPTUsage,
  type ChatGPTWindow,
} from '../../platform/chatgpt';

const PLANS: Record<string, string> = {
  free: 'Free',
  go: 'Go',
  plus: 'Plus',
  pro: 'Pro',
  team: 'Team',
  business: 'Business',
  enterprise: 'Enterprise',
  edu: 'Edu',
};

function windowName(window: NonNullable<ChatGPTWindow>) {
  const minutes = window.windowDurationMins ?? 0;
  if (minutes === 7 * 24 * 60) return t('每周额度');
  if (minutes >= 24 * 60) return t('{days} 天额度', { days: Math.round(minutes / 1440) });
  if (minutes > 0) return t('{hours} 小时额度', { hours: Math.round(minutes / 60) });
  return t('用量');
}

/** Sign-in, plan and usage of the ChatGPT account that drives the Agent. */
export function ChatGPTAccount({
  disabled,
  onAccount,
  backend = nativeChatGPT,
}: {
  disabled?: boolean;
  onAccount?(account: Account): void;
  backend?: ChatGPTBackend;
}) {
  const [account, setAccount] = useState<Account | null>(null);
  const [usage, setUsage] = useState<ChatGPTUsage | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const report = useRef(onAccount);
  report.current = onAccount;

  async function refresh() {
    try {
      const current = await backend.account();
      setAccount(current);
      report.current?.(current);
      setUsage(current.signedIn ? await backend.usage().catch(() => null) : null);
    } catch (reason) {
      setFailure(errorMessage(reason));
      setAccount(
        (previous) => previous ?? { signedIn: false, email: null, plan: null, waiting: false },
      );
    }
  }
  useEffect(() => {
    let live = true;
    void refresh();
    const stop = backend.signedIn((event) => {
      if (!live) return;
      setAccount((previous) => previous && { ...previous, waiting: false });
      if (!event.success) setFailure(event.error || t('登录没有完成。'));
      else {
        setFailure('');
        void refresh();
      }
    });
    return () => {
      live = false;
      void stop.then((unlisten) => unlisten());
    };
  }, [backend]);

  async function act(work: () => Promise<void>, waiting = false) {
    setBusy(true);
    setFailure('');
    try {
      await work();
      if (waiting) setAccount((previous) => previous && { ...previous, waiting: true });
      else await refresh();
    } catch (reason) {
      setFailure(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  const windows = [usage?.primary, usage?.secondary].filter(
    (window): window is NonNullable<ChatGPTWindow> => !!window,
  );
  return (
    <div className="sf-chatgpt-account" aria-label={t('ChatGPT 账号')}>
      {!account ? (
        <p className="sf-chatgpt-line" role="status">
          <LoaderCircle size={14} className="sf-model-spinner" />
          {t('正在读取账号…')}
        </p>
      ) : account.signedIn ? (
        <>
          <div className="sf-chatgpt-line">
            <span className="sf-chatgpt-name">
              {account.email ?? t('已登录')}
              {account.plan && PLANS[account.plan] ? <em>{PLANS[account.plan]}</em> : null}
            </span>
            <Button
              type="button"
              disabled={disabled || busy}
              onClick={() => void act(() => backend.logout())}
            >
              {t('退出登录')}
            </Button>
          </div>
          {windows.map((window, index) => (
            <div key={index} className="sf-chatgpt-usage">
              <span>{windowName(window)}</span>
              <div className="settings-meter" aria-label={windowName(window)}>
                <div className="settings-meter-bar">
                  <i
                    style={{ width: `${Math.min(100, Math.max(0, window.usedPercent))}%` }}
                    data-level={
                      window.usedPercent >= 100
                        ? 'full'
                        : window.usedPercent >= 85
                          ? 'high'
                          : undefined
                    }
                  />
                </div>
                <span>{t('已用 {percent}%', { percent: Math.round(window.usedPercent) })}</span>
              </div>
            </div>
          ))}
        </>
      ) : account.waiting ? (
        <div className="sf-chatgpt-line">
          <span role="status">{t('请在浏览器里完成登录')}</span>
          <Button type="button" disabled={busy} onClick={() => void act(() => backend.cancel())}>
            {t('取消')}
          </Button>
        </div>
      ) : (
        <div className="sf-chatgpt-line">
          <span>{t('用你的 ChatGPT 订阅驱动 AI 助手')}</span>
          <Button
            type="button"
            variant="primary"
            disabled={disabled || busy}
            onClick={() => void act(() => backend.login(), true)}
          >
            {t('用 ChatGPT 登录')}
          </Button>
        </div>
      )}
      {failure ? (
        <p role="alert" className="sf-model-settings-error">
          {translateError(failure)}
        </p>
      ) : null}
    </div>
  );
}
