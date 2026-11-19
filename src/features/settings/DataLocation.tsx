import { useEffect, useState } from 'react';
import { useStore } from 'zustand';
import { t, translateError } from '../../i18n';
import { Button } from '../../components/primitives';
import type { StorageLocation } from '../../platform/desktop';
import type { WorkspaceStore } from '../../stores/workspace';

/** `D:\data` rather than the `\\?\D:\data` form Windows uses internally. */
export const plainPath = (path: string) =>
  path.replace(/^\\\\\?\\UNC\\/, '\\\\').replace(/^\\\\\?\\(?=[A-Za-z]:)/, '');

/**
 * Where this installation keeps its data, and the two ways to change it: move
 * into an empty folder, or use a folder that already holds Scientify data (from
 * another installation). Both take effect on the next start.
 */
export function useDataLocation(store: WorkspaceStore) {
  const state = useStore(store);
  const [location, setLocation] = useState<StorageLocation | null>(null);
  // The folder this window started with; an adopted folder only applies after a restart.
  const [current, setCurrent] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [changing, setChanging] = useState(false);
  const blocked = state.busy || state.dirty || changing || !!Object.keys(state.agentTasks).length;
  useEffect(() => {
    let disposed = false;
    void store
      .getState()
      .storageLocation()
      .then((value) => {
        if (disposed) return;
        setLocation(value);
        setCurrent(value?.directory ?? null);
      })
      .catch((reason) => {
        if (!disposed) setError(String(reason));
      });
    return () => {
      disposed = true;
    };
  }, [store]);
  async function change(mode: 'move' | 'adopt' | 'cancel') {
    if (blocked) return;
    setChanging(true);
    setError('');
    try {
      if (mode === 'cancel') {
        // A move is cancelled in place; an adopted folder is undone by adopting this one again.
        setLocation(
          await store
            .getState()
            .changeStorage(location?.pending ? null : current, !location?.pending),
        );
        return;
      }
      const directory = await state.chooseDirectory();
      if (!directory) return;
      setLocation(await store.getState().changeStorage(directory, mode === 'adopt'));
    } catch (reason) {
      setError(String(reason));
    } finally {
      setChanging(false);
    }
  }
  const directory = plainPath(current ?? location?.directory ?? state.directory ?? '');
  const next =
    location?.pending ??
    (location && current && location.directory !== current ? location.directory : null);
  return {
    directory,
    /** Where the data will be from the next start: a move target or an adopted folder. */
    next: next ? plainPath(next) : null,
    moving: !!location?.pending,
    ready: !!location,
    blocked,
    error,
    change,
  };
}

export async function restartApp() {
  const { relaunch } = await import('@tauri-apps/plugin-process');
  await relaunch();
}

/** The data section's location rows in settings. */
export function DataLocationRows({ store }: { store: WorkspaceStore }) {
  const data = useDataLocation(store);
  return (
    <>
      <label>
        {t('当前目录')}
        <code className="data-path">{data.directory || t('尚未载入')}</code>
      </label>
      <section className="setting-row">
        <div>
          <h3>{t('数据存储位置')}</h3>
          <p>
            {t('选择空文件夹。保存并退出应用后，下次启动将迁移数据、托管代码、AI 历史和浏览缓存。')}
          </p>
        </div>
        <Button disabled={data.blocked || !data.ready} onClick={() => void data.change('move')}>
          {t('更改位置')}
        </Button>
      </section>
      <section className="setting-row">
        <div>
          <h3>{t('使用已有数据')}</h3>
          <p>{t('选择另一个安装版本的数据目录，重启后直接使用，不复制。')}</p>
        </div>
        <Button disabled={data.blocked || !data.ready} onClick={() => void data.change('adopt')}>
          {t('选择数据目录')}
        </Button>
      </section>
      {data.next ? (
        <div className="storage-pending" role="status">
          <span>{data.moving ? t('下次启动迁移到') : t('重启后使用')}</span>
          <code className="data-path">{data.next}</code>
          <Button
            disabled={data.blocked}
            variant="ghost"
            onClick={() => void data.change('cancel')}
          >
            {data.moving ? t('取消迁移') : t('取消')}
          </Button>
          <Button disabled={data.blocked} onClick={() => void restartApp()}>
            {t('立即重启')}
          </Button>
        </div>
      ) : null}
      {data.error ? (
        <p role="alert" className="error-text">
          {translateError(data.error)}
        </p>
      ) : null}
    </>
  );
}
