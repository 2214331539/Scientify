import { isTauri } from '@tauri-apps/api/core';
import { useEffect, useId, useRef, useState } from 'react';
import {
  ArrowLeft,
  ChevronDown,
  Cloud,
  History,
  LoaderCircle,
  ShieldCheck,
  UsersRound,
} from 'lucide-react';
import { Button, Input } from '../../components/primitives';
import { BrandMark } from '../../components/layout/BrandMark';
import { WindowControls } from '../../components/layout/WindowControls';
import { t } from '../../i18n';
import { browserLayout } from '../../platform/browser-pane';
import { collaboration, collaborationStateEvent } from '../../platform/collaboration';
import { describeError, isPhone, maskPhone, normalizePhone } from './account';
import './sign-in.css';

/** The server lets one number ask for a new code once a minute. */
const RESEND_SECONDS = 60;

type Busy = 'code' | 'login' | 'server' | null;

/**
 * Full-window sign-in with a phone number and an SMS code. It covers whatever
 * is open, including settings, and closes itself once the account signs in.
 */
export function SignInPage({ onClose }: { onClose(): void }) {
  const native = isTauri();
  const ref = useRef<HTMLDialogElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const phoneId = useId();
  const phoneHintId = useId();
  const codeId = useId();
  const serverId = useId();
  // Captured before the phone field takes focus, so closing returns to the trigger.
  const [trigger] = useState(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  const [endpoint, setEndpoint] = useState('');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [sentTo, setSentTo] = useState('');
  const [countdown, setCountdown] = useState(0);
  const [checkPhone, setCheckPhone] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState('');
  const [server, setServer] = useState<{ ok: boolean; text: string } | null>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const dialog = ref.current!;
    let active = true;
    const show = () => {
      dialog.showModal();
      dialog.querySelector<HTMLElement>('[data-autofocus="true"]')?.focus({ preventScroll: true });
    };
    // Native browser panes sit above the page, so hide them first as Modal does.
    if (native)
      void browserLayout({ op: 'hideAll' })
        .catch(() => {})
        .then(() => {
          if (active) show();
        });
    else show();
    return () => {
      active = false;
      dialog.close();
      queueMicrotask(() => {
        if (trigger?.isConnected) trigger.focus({ preventScroll: true });
      });
    };
  }, [native, trigger]);

  useEffect(() => {
    if (!native) return;
    let active = true;
    collaboration
      .status()
      .then((state) => {
        if (!active) return;
        if (state.authenticated) close.current();
        else setEndpoint(state.endpoint);
      })
      .catch((reason) => {
        if (active) setError(describeError(reason));
      });
    return () => {
      active = false;
    };
  }, [native]);

  useEffect(() => {
    if (!countdown) return;
    const timer = window.setTimeout(() => setCountdown((value) => Math.max(0, value - 1)), 1_000);
    return () => window.clearTimeout(timer);
  }, [countdown]);

  const number = normalizePhone(phone);
  const phoneError = checkPhone && !isPhone(phone) ? t('请输入正确的 11 位手机号。') : '';
  // A different number may ask for its own code straight away.
  const waiting = countdown > 0 && number === sentTo;

  async function sendCode() {
    setCheckPhone(true);
    if (!isPhone(phone) || busy || waiting) return;
    setBusy('code');
    setError('');
    try {
      await collaboration.sendCode(endpoint, number);
      setSentTo(number);
      setCountdown(RESEND_SECONDS);
      codeRef.current?.focus();
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setBusy(null);
    }
  }

  async function signIn() {
    setCheckPhone(true);
    if (!isPhone(phone) || busy) return;
    if (!code) {
      codeRef.current?.focus();
      return;
    }
    setBusy('login');
    setError('');
    try {
      await collaboration.login(endpoint, number, code);
    } catch (reason) {
      setError(describeError(reason));
      setBusy(null);
      return;
    }
    window.dispatchEvent(new Event(collaborationStateEvent));
    onClose();
  }

  async function checkServer() {
    if (busy || !endpoint.trim()) return;
    setBusy('server');
    setServer(null);
    try {
      await collaboration.health(endpoint);
      setServer({ ok: true, text: t('协作服务连接正常。') });
    } catch (reason) {
      setServer({ ok: false, text: describeError(reason) });
    } finally {
      setBusy(null);
    }
  }

  function leave() {
    if (busy !== 'login') onClose();
  }

  return (
    <dialog
      ref={ref}
      className="sign-in-page"
      data-native-overlay="true"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        leave();
      }}
    >
      <header className="sign-in-topbar" data-tauri-drag-region>
        <Button
          variant="ghost"
          className="sign-in-back"
          disabled={busy === 'login'}
          onClick={leave}
        >
          <ArrowLeft />
          {t('返回')}
        </Button>
        <span className="spacer" data-tauri-drag-region />
        <WindowControls />
      </header>
      <div className="sign-in-body">
        <aside className="sign-in-intro">
          <div className="sign-in-brand">
            <BrandMark />
            <span>Scientify</span>
          </div>
          <div className="sign-in-pitch">
            <p>{t('同一账号，多端继续')}</p>
            <h2>{t('让研究资料和团队进度自然流转')}</h2>
          </div>
          <ul className="sign-in-benefits">
            <li>
              <History aria-hidden="true" />
              <span>
                <strong>{t('多设备同步')}</strong>
                <small>{t('在另一台电脑登录后取回协作项目与进度。')}</small>
              </span>
            </li>
            <li>
              <UsersRound aria-hidden="true" />
              <span>
                <strong>{t('多人协同')}</strong>
                <small>{t('按所有者、编辑者、审阅者和查看者分配权限。')}</small>
              </span>
            </li>
            <li>
              <Cloud aria-hidden="true" />
              <span>
                <strong>{t('本地优先')}</strong>
                <small>{t('断网时继续工作，恢复连接后自动合并变更。')}</small>
              </span>
            </li>
          </ul>
        </aside>
        <div className="sign-in-main">
          <form
            className="sign-in-form"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void signIn();
            }}
          >
            <header>
              <h1 id={titleId}>{t('登录 Scientify')}</h1>
              <p>{t('使用手机号登录。未注册的手机号验证后会自动创建账号。')}</p>
            </header>
            {native ? null : (
              <p className="sign-in-error" role="alert">
                {t('登录和协作同步需要在 Scientify 桌面应用中使用。')}
              </p>
            )}
            <div className="sign-in-field">
              <label htmlFor={phoneId}>{t('手机号')}</label>
              <div className="sign-in-phone" data-invalid={phoneError ? 'true' : undefined}>
                <span aria-hidden="true">+86</span>
                <Input
                  id={phoneId}
                  autoFocus
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel-national"
                  maxLength={16}
                  value={phone}
                  placeholder={t('请输入手机号')}
                  disabled={!native || !!busy}
                  aria-invalid={phoneError ? true : undefined}
                  aria-describedby={phoneError ? phoneHintId : undefined}
                  onChange={(event) => setPhone(event.target.value)}
                  onBlur={() => {
                    if (phone.trim()) setCheckPhone(true);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter') return;
                    event.preventDefault();
                    if (sentTo && number === sentTo) codeRef.current?.focus();
                    else void sendCode();
                  }}
                />
              </div>
              {phoneError ? (
                <small id={phoneHintId} className="sign-in-hint" data-tone="error">
                  {phoneError}
                </small>
              ) : null}
            </div>
            <div className="sign-in-field">
              <label htmlFor={codeId}>{t('验证码')}</label>
              <div className="sign-in-code">
                <Input
                  ref={codeRef}
                  id={codeId}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={8}
                  value={code}
                  placeholder={t('6 位短信验证码')}
                  disabled={!native || busy === 'login'}
                  onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
                />
                <Button
                  type="button"
                  className="sign-in-send"
                  disabled={!native || !!busy || waiting || !phone.trim()}
                  onClick={() => void sendCode()}
                >
                  {busy === 'code' ? <LoaderCircle className="is-spinning" /> : null}
                  {waiting
                    ? t('{seconds} 秒后重发', { seconds: countdown })
                    : sentTo
                      ? t('重新获取')
                      : t('获取验证码')}
                </Button>
              </div>
            </div>
            {error ? (
              <p className="sign-in-error" role="alert">
                {error}
              </p>
            ) : sentTo ? (
              <p className="sign-in-hint" role="status">
                {t('验证码已发送至 {phone}', { phone: maskPhone(sentTo) })}
              </p>
            ) : null}
            <Button
              type="submit"
              variant="primary"
              className="sign-in-submit"
              disabled={!native || !!busy || !phone.trim() || !code}
            >
              {busy === 'login' ? <LoaderCircle className="is-spinning" /> : null}
              {busy === 'login' ? t('正在登录…') : t('登录')}
            </Button>
            <p className="sign-in-footnote">
              <ShieldCheck aria-hidden="true" />
              {t('账号与协作数据在本机和服务端加密传输。')}
            </p>
          </form>
          <details className="sign-in-server">
            <summary>
              <ChevronDown aria-hidden="true" />
              {t('使用自托管协作服务')}
            </summary>
            <div className="sign-in-field">
              <label htmlFor={serverId}>{t('服务器地址')}</label>
              <div className="sign-in-code">
                <Input
                  id={serverId}
                  value={endpoint}
                  placeholder="https://collab.example.com"
                  disabled={!native || !!busy}
                  onChange={(event) => {
                    setEndpoint(event.target.value);
                    setServer(null);
                  }}
                />
                <Button
                  type="button"
                  className="sign-in-send"
                  disabled={!native || !!busy || !endpoint.trim()}
                  onClick={() => void checkServer()}
                >
                  {busy === 'server' ? <LoaderCircle className="is-spinning" /> : null}
                  {t('检查连接')}
                </Button>
              </div>
              <small
                className="sign-in-hint"
                data-tone={server && !server.ok ? 'error' : undefined}
              >
                {server ? server.text : t('登录成功后，这台设备会使用该地址。')}
              </small>
            </div>
          </details>
        </div>
      </div>
    </dialog>
  );
}
