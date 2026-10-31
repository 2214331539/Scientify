import './translator.css';
import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Button } from '../../components/primitives';
import { t, translateError } from '../../i18n';

type TranslationStatus = {
  enabled: boolean;
  running: boolean;
  hotkeyRunning: boolean;
  settingsError: string | null;
};
type TranslationAction =
  | { type: 'status' | 'settings' | 'clipboard' }
  | { type: 'enabled'; enabled: boolean }
  | { type: 'translate'; text: string };

export function translationService(action: TranslationAction) {
  return invoke<TranslationStatus>('translation_service', { action });
}

/** Settings entry for the original Yita controls; translation lives in its native popup. */
export function NativeTranslationPanel() {
  const [status, setStatus] = useState<TranslationStatus | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    try {
      setStatus(await translationService({ type: 'status' }));
      setError('');
    } catch (reason) {
      setError(translateError(String(reason)));
    }
  }, []);
  useEffect(() => {
    let disposed = false;
    const update = () => {
      if (!disposed) void refresh();
    };
    update();
    window.addEventListener('focus', update);
    let unlisten: (() => void) | undefined;
    void listen<string>('translation-service-stopped', ({ payload }) => {
      if (!disposed) {
        setStatus(null);
        setError(payload);
      }
    })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch((reason: unknown) => {
        if (!disposed) setError(translateError(String(reason)));
      });
    return () => {
      disposed = true;
      window.removeEventListener('focus', update);
      unlisten?.();
    };
  }, [refresh]);
  const run = async (action: TranslationAction) => {
    setBusy(true);
    setError('');
    try {
      setStatus(await translationService(action));
    } catch (reason) {
      setError(translateError(String(reason)));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="settings-data settings-translation sf-native-translator"
      aria-label={t('翻译')}
    >
      <h3>{t('划词翻译')}</h3>
      <p>
        {t(
          '在论文、浏览器或其他应用中选中文字，松开鼠标后自动翻译。固定窗口后，再次划词会打开新的翻译窗口。',
        )}
      </p>
      {status && (
        <div className="setting-row">
          <div>
            <strong>{status.enabled ? t('自动划词已启用') : t('自动划词已暂停')}</strong>
            <p>{t('Ctrl + Shift + T 翻译剪贴板中的文字。')}</p>
          </div>
          <Button
            disabled={busy}
            aria-pressed={status.enabled}
            onClick={() => void run({ type: 'enabled', enabled: !status.enabled })}
          >
            {status.enabled ? t('暂停划词') : t('启用划词')}
          </Button>
        </div>
      )}
      {status?.enabled && !status.running && (
        <p role="status">{t('系统取词尚未就绪，请在翻译设置中检查权限或修复输入捕获。')}</p>
      )}
      {status?.enabled && !status.hotkeyRunning && (
        <p role="status">{t('剪贴板快捷键尚未就绪，仍可使用下方按钮。')}</p>
      )}
      {status?.settingsError && (
        <p role="alert">{t('翻译设置无法读取，请在翻译设置中检查原文件。')}</p>
      )}
      <div className="sf-native-translator-actions">
        <Button disabled={busy} onClick={() => void run({ type: 'settings' })}>
          {t('打开完整翻译设置')}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => void run({ type: 'clipboard' })}>
          {t('翻译剪贴板')}
        </Button>
      </div>
      <p className="muted">
        {t(
          '语言、术语表、字体、浮窗外观、纠错记忆和问答记录在翻译设置中管理。模型与密钥沿用 AI 助手的配置。',
        )}
      </p>
      {error && (
        <div role="alert">
          <p>{error}</p>
          <Button disabled={busy} onClick={() => void run({ type: 'status' })}>
            {t('重试')}
          </Button>
        </div>
      )}
    </section>
  );
}
