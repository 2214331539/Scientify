import { t, translateError } from '../../i18n';
import { useEffect, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Copy, Minus, Square, X } from 'lucide-react';
import { Button } from '../primitives';

/** Close requests go through App's existing unsaved-work guard. */
export function WindowControls() {
  const native = isTauri();
  const [maximized, setMaximized] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!native) return;
    const win = getCurrentWindow();
    let active = true;
    const sync = () =>
      void win
        .isMaximized()
        .then((value) => {
          if (active) setMaximized(value);
        })
        .catch(() => {});
    sync();
    const listener = win.onResized(sync);
    return () => {
      active = false;
      void listener.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [native]);
  if (!native) return null;
  const win = getCurrentWindow();
  const run = (action: () => Promise<void>) => {
    setError('');
    void action().catch(() => setError(t('窗口操作失败，请重试')));
  };
  return (
    <div className="window-controls" role="group" aria-label={t('窗口控制')}>
      <Button
        type="button"
        variant="ghost"
        iconOnly
        aria-label={t('最小化窗口')}
        onClick={() => run(() => win.minimize())}
      >
        <Minus />
      </Button>
      <Button
        type="button"
        variant="ghost"
        iconOnly
        aria-label={maximized ? t('还原窗口') : t('最大化窗口')}
        onClick={() =>
          run(async () => {
            await win.toggleMaximize();
            setMaximized(await win.isMaximized());
          })
        }
      >
        {maximized ? <Copy /> : <Square />}
      </Button>
      <Button
        type="button"
        variant="ghost"
        iconOnly
        className="window-close"
        aria-label={t('关闭窗口')}
        onClick={() => run(() => win.close())}
      >
        <X />
      </Button>
      {error && (
        <span className="window-control-error" role="alert">
          {translateError(error)}
        </span>
      )}
    </div>
  );
}
