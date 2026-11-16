import { isTauri } from '@tauri-apps/api/core';
import { useEffect, useId, useRef, useState } from 'react';
import { Eye, EyeOff, LoaderCircle } from 'lucide-react';
import { Button, Input } from '../../components/primitives';
import { BrandMark } from '../../components/layout/BrandMark';
import { WindowControls } from '../../components/layout/WindowControls';
import { t } from '../../i18n';
import {
  collaboration,
  collaborationStateEvent,
  type SignInMode,
} from '../../platform/collaboration';
import { describeError, isPhone, maskPhone, normalizePhone } from './account';
import './sign-in.css';

/** The server lets one number ask for a new code once a minute. */
const RESEND_SECONDS = 60;
const methodKey = 'scientify.sign-in.method';

type View = 'login' | 'register' | 'reset';
type Method = 'code' | 'password';

/** 8 to 64 characters with at least one letter and one digit, as the server requires. */
export function passwordProblem(password: string) {
  if (password.length < 8 || password.length > 64) return t('密码需要 8–64 位。');
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return t('密码需要同时包含字母和数字。');
  return '';
}

/**
 * The account page: Scientify shows only this while nobody is signed in, at first launch and
 * after signing out. Sign in by SMS code or password, register, or reset a forgotten password.
 */
export function SignInPage() {
  const native = isTauri();
  const titleId = useId();
  const phoneId = useId();
  const codeId = useId();
  const passwordId = useId();
  const confirmId = useId();
  const codeRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const [view, setView] = useState<View>('login');
  const [method, setMethod] = useState<Method>(() =>
    localStorage.getItem(methodKey) === 'password' ? 'password' : 'code',
  );
  const [endpoint, setEndpoint] = useState('');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [visible, setVisible] = useState(false);
  const [sentTo, setSentTo] = useState('');
  const [countdown, setCountdown] = useState(0);
  const [checkPhone, setCheckPhone] = useState(false);
  const [busy, setBusy] = useState<'code' | 'submit' | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!native) return;
    let active = true;
    collaboration
      .status()
      .then((state) => active && setEndpoint(state.endpoint))
      .catch((reason) => active && setError(describeError(reason)));
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
  const needsCode = view !== 'login' || method === 'code';
  const needsPassword = view !== 'login' || method === 'password';
  const choosing = view !== 'login';
  const disabled = !native || !!busy;

  function go(next: View) {
    setView(next);
    setCode('');
    setPassword('');
    setConfirm('');
    setError('');
  }
  function choose(next: Method) {
    setMethod(next);
    localStorage.setItem(methodKey, next);
    setError('');
  }

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

  async function submit() {
    setCheckPhone(true);
    if (!isPhone(phone) || busy) return;
    if (needsCode && !code) return codeRef.current?.focus();
    if (needsPassword && !password) return passwordRef.current?.focus();
    if (choosing) {
      const problem = passwordProblem(password);
      if (problem) return setError(problem);
      if (password !== confirm) return setError(t('两次输入的密码不一致。'));
    }
    setBusy('submit');
    setError('');
    const mode: SignInMode = view === 'login' ? method : view;
    try {
      await collaboration.signIn(endpoint, mode, number, {
        ...(needsCode ? { code } : {}),
        ...(needsPassword ? { password } : {}),
      });
    } catch (reason) {
      setError(describeError(reason));
      setBusy(null);
      return;
    }
    window.dispatchEvent(new Event(collaborationStateEvent));
  }

  const title =
    view === 'register'
      ? t('注册 Scientify')
      : view === 'reset'
        ? t('找回密码')
        : t('登录 Scientify');
  const action =
    view === 'register' ? t('注册') : view === 'reset' ? t('重置密码并登录') : t('登录');
  return (
    <main className="sign-in-page" aria-labelledby={titleId}>
      <header className="sign-in-topbar" data-tauri-drag-region>
        <span className="sign-in-brand" data-tauri-drag-region>
          <BrandMark />
          Scientify
        </span>
        <span className="spacer" data-tauri-drag-region />
        <WindowControls />
      </header>
      <div className="sign-in-main">
        <form
          className="sign-in-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <h1 id={titleId}>{title}</h1>
          {view === 'login' ? (
            <div className="sign-in-tabs" role="tablist" aria-label={t('登录方式')}>
              {(['code', 'password'] as const).map((item) => (
                <button
                  key={item}
                  type="button"
                  role="tab"
                  aria-selected={method === item}
                  disabled={!!busy}
                  onClick={() => choose(item)}
                >
                  {item === 'code' ? t('验证码登录') : t('密码登录')}
                </button>
              ))}
            </div>
          ) : (
            <p className="sign-in-lead">
              {view === 'register'
                ? t('用手机号注册，并设置登录密码。')
                : t('验证手机号后设置新密码。')}
            </p>
          )}
          {native ? null : (
            <p className="sign-in-error" role="alert">
              {t('登录需要在 Scientify 桌面应用中使用。')}
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
                disabled={disabled}
                aria-invalid={phoneError ? true : undefined}
                onChange={(event) => setPhone(event.target.value)}
                onBlur={() => phone.trim() && setCheckPhone(true)}
              />
            </div>
            {phoneError ? (
              <small className="sign-in-hint" data-tone="error">
                {phoneError}
              </small>
            ) : null}
          </div>
          {needsCode ? (
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
                  disabled={!native || busy === 'submit'}
                  onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
                />
                <Button
                  type="button"
                  className="sign-in-send"
                  disabled={disabled || waiting || !phone.trim()}
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
          ) : null}
          {needsPassword ? (
            <div className="sign-in-field">
              <span className="sign-in-label-row">
                <label htmlFor={passwordId}>{view === 'reset' ? t('新密码') : t('密码')}</label>
                {view === 'login' ? (
                  <button
                    type="button"
                    className="sign-in-link"
                    disabled={!!busy}
                    onClick={() => go('reset')}
                  >
                    {t('忘记密码？')}
                  </button>
                ) : null}
              </span>
              <div className="sign-in-password">
                <Input
                  ref={passwordRef}
                  id={passwordId}
                  type={visible ? 'text' : 'password'}
                  autoComplete={view === 'login' ? 'current-password' : 'new-password'}
                  maxLength={64}
                  value={password}
                  placeholder={view === 'login' ? t('请输入密码') : t('8–64 位，包含字母和数字')}
                  disabled={!native || busy === 'submit'}
                  onChange={(event) => setPassword(event.target.value)}
                />
                <Button
                  type="button"
                  variant="ghost"
                  iconOnly
                  aria-label={visible ? t('隐藏密码') : t('显示密码')}
                  onClick={() => setVisible(!visible)}
                >
                  {visible ? <EyeOff /> : <Eye />}
                </Button>
              </div>
            </div>
          ) : null}
          {choosing ? (
            <div className="sign-in-field">
              <label htmlFor={confirmId}>{t('确认密码')}</label>
              <Input
                id={confirmId}
                type={visible ? 'text' : 'password'}
                autoComplete="new-password"
                maxLength={64}
                value={confirm}
                placeholder={t('再输入一次')}
                disabled={!native || busy === 'submit'}
                onChange={(event) => setConfirm(event.target.value)}
              />
            </div>
          ) : null}
          {error ? (
            <p className="sign-in-error" role="alert">
              {error}
            </p>
          ) : sentTo && needsCode ? (
            <p className="sign-in-hint" role="status">
              {t('验证码已发送至 {phone}', { phone: maskPhone(sentTo) })}
            </p>
          ) : null}
          <Button type="submit" variant="primary" className="sign-in-submit" disabled={disabled}>
            {busy === 'submit' ? <LoaderCircle className="is-spinning" /> : null}
            {action}
          </Button>
          <p className="sign-in-switch">
            {view === 'login' ? (
              <>
                {t('还没有账号？')}
                <button
                  type="button"
                  className="sign-in-link"
                  disabled={!!busy}
                  onClick={() => go('register')}
                >
                  {t('注册')}
                </button>
              </>
            ) : view === 'register' ? (
              <>
                {t('已有账号？')}
                <button
                  type="button"
                  className="sign-in-link"
                  disabled={!!busy}
                  onClick={() => go('login')}
                >
                  {t('登录')}
                </button>
              </>
            ) : (
              <button
                type="button"
                className="sign-in-link"
                disabled={!!busy}
                onClick={() => go('login')}
              >
                {t('返回登录')}
              </button>
            )}
          </p>
        </form>
      </div>
    </main>
  );
}
