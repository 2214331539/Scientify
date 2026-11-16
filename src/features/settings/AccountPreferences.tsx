import { useEffect, useId, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { Modal } from '../../components/Modal';
import { Button, Input } from '../../components/primitives';
import { confirmAction } from '../../components/prompts';
import { t } from '../../i18n';
import {
  collaboration,
  collaborationStateEvent,
  type CollaborationState,
} from '../../platform/collaboration';
import { describeError, maskPhone } from '../account/account';
import { passwordProblem } from '../account/SignInPage';

/** Settings → 账号: who is signed in, the password, and signing out. */
export function AccountPreferences() {
  const [state, setState] = useState<CollaborationState | null>(null);
  const [hasPassword, setHasPassword] = useState<boolean | undefined>(undefined);
  const [changing, setChanging] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    void collaboration
      .status()
      .then((next) => alive && setState(next))
      .catch((reason) => alive && setError(describeError(reason)));
    void collaboration
      .account()
      .then((account) => alive && setHasPassword(account.hasPassword))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  const phone = state?.phone ?? '';
  async function signOut() {
    if (!(await confirmAction(t('退出登录？这台电脑上的资料会保留，重新登录后继续同步。')))) return;
    try {
      await collaboration.logout();
      window.dispatchEvent(new Event(collaborationStateEvent));
    } catch (reason) {
      setError(describeError(reason));
    }
  }
  return (
    <div className="settings-account">
      <dl>
        <dt>{t('手机号')}</dt>
        <dd>{phone ? maskPhone(phone) : '—'}</dd>
        <dt>{t('密码')}</dt>
        <dd>
          {hasPassword === undefined ? '—' : hasPassword ? t('已设置') : t('未设置')}
          <Button size="sm" disabled={!phone} onClick={() => setChanging(true)}>
            {hasPassword === false ? t('设置密码') : t('修改密码')}
          </Button>
        </dd>
      </dl>
      {error ? (
        <p role="alert" className="error-text">
          {error}
        </p>
      ) : null}
      <footer>
        <Button onClick={() => void signOut()}>{t('退出登录')}</Button>
      </footer>
      {changing && state ? (
        <PasswordDialog
          endpoint={state.endpoint}
          phone={phone}
          first={hasPassword === false}
          onClose={() => setChanging(false)}
          onDone={() => {
            setHasPassword(true);
            setChanging(false);
          }}
        />
      ) : null}
    </div>
  );
}

/** Sets or changes the password after an SMS code to the signed-in number. */
function PasswordDialog({
  endpoint,
  phone,
  first,
  onClose,
  onDone,
}: {
  endpoint: string;
  phone: string;
  first: boolean;
  onClose(): void;
  onDone(): void;
}) {
  const codeId = useId();
  const passwordId = useId();
  const confirmId = useId();
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [countdown, setCountdown] = useState(0);
  const [busy, setBusy] = useState<'code' | 'save' | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!countdown) return;
    const timer = window.setTimeout(() => setCountdown((value) => Math.max(0, value - 1)), 1_000);
    return () => window.clearTimeout(timer);
  }, [countdown]);
  async function sendCode() {
    setBusy('code');
    setError('');
    try {
      await collaboration.sendCode(endpoint, phone);
      setCountdown(60);
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setBusy(null);
    }
  }
  async function save() {
    const problem = passwordProblem(password);
    if (!code) return setError(t('请输入验证码。'));
    if (problem) return setError(problem);
    if (password !== confirm) return setError(t('两次输入的密码不一致。'));
    setBusy('save');
    setError('');
    try {
      await collaboration.signIn(endpoint, first ? 'register' : 'reset', phone, { code, password });
      window.dispatchEvent(new Event(collaborationStateEvent));
      onDone();
    } catch (reason) {
      setError(describeError(reason));
      setBusy(null);
    }
  }
  return (
    <Modal title={first ? t('设置密码') : t('修改密码')} busy={busy === 'save'} onClose={onClose}>
      <form
        className="settings-password"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <p className="muted">
          {first
            ? t('验证码会发送到 {phone}。', { phone: maskPhone(phone) })
            : t('验证码会发送到 {phone}。改密码后，其他设备需要重新登录。', {
                phone: maskPhone(phone),
              })}
        </p>
        <label htmlFor={codeId}>{t('验证码')}</label>
        <div className="settings-password-code">
          <Input
            id={codeId}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={8}
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
          />
          <Button type="button" disabled={!!busy || countdown > 0} onClick={() => void sendCode()}>
            {countdown > 0 ? t('{seconds} 秒后重发', { seconds: countdown }) : t('获取验证码')}
          </Button>
        </div>
        <label htmlFor={passwordId}>{t('新密码')}</label>
        <Input
          id={passwordId}
          type="password"
          autoComplete="new-password"
          maxLength={64}
          placeholder={t('8–64 位，包含字母和数字')}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <label htmlFor={confirmId}>{t('确认密码')}</label>
        <Input
          id={confirmId}
          type="password"
          autoComplete="new-password"
          maxLength={64}
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
        />
        {error ? (
          <p role="alert" className="error-text">
            {error}
          </p>
        ) : null}
        <footer>
          <Button type="button" disabled={busy === 'save'} onClick={onClose}>
            {t('取消')}
          </Button>
          <Button type="submit" variant="primary" disabled={!!busy}>
            {busy === 'save' ? <LoaderCircle className="is-spinning" /> : null}
            {t('保存')}
          </Button>
        </footer>
      </form>
    </Modal>
  );
}
