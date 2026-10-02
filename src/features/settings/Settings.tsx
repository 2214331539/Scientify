import { t, translateError } from '../../i18n';
import { Button, Input } from '../../components/primitives';
import { PreferenceFields } from './Appearance';
import { useEffect, useState } from 'react';
import { useStore } from 'zustand';
import { confirmAction } from '../../components/prompts';
import { Modal } from '../../components/Modal';
import type { WorkspaceStore } from '../../stores/workspace';
import type { StorageLocation } from '../../platform/desktop';
import { CircleHelp, Database, Palette, Settings } from 'lucide-react';
import './settings.css';

function DataPreferences({ store }: { store: WorkspaceStore }) {
  const state = useStore(store);
  const [location, setLocation] = useState<StorageLocation | null>(null);
  const [locationError, setLocationError] = useState('');
  const [changing, setChanging] = useState(false);
  const blocked = state.busy || state.dirty || changing || !!Object.keys(state.agentTasks).length;
  useEffect(() => {
    let disposed = false;
    void store
      .getState()
      .storageLocation()
      .then((value) => {
        if (!disposed) setLocation(value);
      })
      .catch((error) => {
        if (!disposed) setLocationError(String(error));
      });
    return () => {
      disposed = true;
    };
  }, [store]);
  async function changeLocation(cancel = false) {
    if (blocked) return;
    setChanging(true);
    setLocationError('');
    try {
      const directory = cancel ? null : await state.chooseDirectory();
      if (!cancel && !directory) return;
      setLocation(await store.getState().changeStorage(directory));
    } catch (error) {
      setLocationError(String(error));
    } finally {
      setChanging(false);
    }
  }
  const confirmReplace = async (
    kind: 'restore' | 'migrateLegacy' | 'importWorkspace',
    text: string,
  ) => {
    if (await confirmAction(text)) void state.replace(kind);
  };
  return (
    <div className="settings-data">
      <p className="muted">{t('应用数据保存在本机。已关联的项目和文献目录保留原位置。')}</p>
      <label>
        {t('当前目录')}
        <code className="data-path">{location?.directory || state.directory || t('尚未载入')}</code>
      </label>
      <section className="setting-row">
        <div>
          <h3>{t('数据存储位置')}</h3>
          <p>
            {t('选择空文件夹。保存并退出应用后，下次启动将迁移数据、托管代码、AI 历史和浏览缓存。')}
          </p>
        </div>
        <Button disabled={blocked || !location} onClick={() => void changeLocation()}>
          {t('更改位置')}
        </Button>
      </section>
      {location?.pending ? (
        <div className="storage-pending" role="status">
          <span>{t('下次启动迁移到')}</span>
          <code className="data-path">{location.pending}</code>
          <Button disabled={blocked} variant="ghost" onClick={() => void changeLocation(true)}>
            {t('取消迁移')}
          </Button>
        </div>
      ) : null}
      {locationError ? (
        <p role="alert" className="error-text">
          {translateError(locationError)}
        </p>
      ) : null}
      <section className="setting-row">
        <div>
          <h3>{t('迁移 Electron 数据')}</h3>
          <p>{t('先关闭旧应用。复制整个工作区及附件，保留旧目录。仅支持迁入空的新工作区。')}</p>
        </div>
        <Button
          disabled={blocked || !state.legacyAvailable || state.data?.revision !== 0}
          onClick={() =>
            confirmReplace(
              'migrateLegacy',
              t(
                '请先关闭 Electron 版 Scientify。将复制整个旧工作区到新目录，原数据保持不变。继续迁移？',
              ),
            )
          }
        >
          {t('复制旧数据')}
        </Button>
      </section>
      {!state.legacyAvailable ? (
        <p className="muted">{t('未检测到默认目录中的 Electron 工作区。')}</p>
      ) : null}
      <section className="setting-row">
        <div>
          <h3>{t('JSON 导入与导出')}</h3>
          <p>{t('JSON 包含记录与附件索引，不含附件文件。跨电脑迁移需另行复制完整数据目录。')}</p>
        </div>
        <div className="button-row">
          <Button
            disabled={blocked || state.phase !== 'ready'}
            onClick={() =>
              confirmReplace(
                'importWorkspace',
                t('导入会替换当前记录，并保存导入前备份。JSON 不包含附件二进制。继续选择文件？'),
              )
            }
          >
            {t('导入')}
          </Button>
          <Button
            disabled={blocked || state.phase !== 'ready'}
            onClick={() => void state.exportWorkspace()}
          >
            {t('导出')}
          </Button>
        </div>
      </section>
      <section className="setting-row">
        <div>
          <h3>{t('恢复最近备份')}</h3>
          <p>{t('恢复上一次保存内容，并另存当前主文件。')}</p>
        </div>
        <Button
          disabled={blocked}
          onClick={() => confirmReplace('restore', t('恢复最近一次备份？当前主文件会另存保留。'))}
        >
          {t('恢复备份')}
        </Button>
      </section>
      {state.dirty ? (
        <p className="muted">{t('请先保存或清空未保存的内容，再进行数据导入、导出与恢复。')}</p>
      ) : null}
      {state.error ? (
        <p role="alert" className="error-text">
          {translateError(state.error)}
        </p>
      ) : null}
      {state.notice ? <p role="status">{translateError(state.notice)}</p> : null}
    </div>
  );
}

export function SettingsDialog({
  store,
  onClose,
  initialSection = 'general',
}: {
  store: WorkspaceStore;
  onClose(): void;
  initialSection?: 'general' | 'appearance' | 'data' | 'about';
}) {
  const data = useStore(store, (s) => s.data);
  const [section, setSection] = useState(initialSection);
  const [profile, setProfile] = useState({
    name: data?.settings.name ?? '',
    saved: data?.settings.name ?? '',
  });
  const [profileError, setProfileError] = useState('');
  const [saved, setSaved] = useState(false);
  const busy = useStore(store, (s) => s.busy);
  const dirty = profile.name !== profile.saved;
  useEffect(() => {
    store.getState().setDirtySource('settings-profile', dirty);
    return () => store.getState().setDirtySource('settings-profile', false);
  }, [dirty, store]);
  useEffect(() => {
    const next = data?.settings.name ?? '';
    setProfile((current) =>
      current.name === current.saved ? { name: next, saved: next } : current,
    );
  }, [data?.settings.name]);
  const sections = [
    { id: 'general', label: t('通用'), icon: Settings },
    { id: 'appearance', label: t('外观'), icon: Palette },
    { id: 'data', label: t('数据与备份'), icon: Database },
    { id: 'about', label: t('关于 Scientify'), icon: CircleHelp },
  ] as const;
  return (
    <Modal
      title={t('设置')}
      heading={sections.find((item) => item.id === section)?.label}
      className="settings-dialog"
      busy={busy}
      dirty={dirty}
      onClose={onClose}
      sidebar={
        <nav className="settings-navigation" aria-label={t('设置分类')}>
          <div className="settings-title">{t('设置')}</div>
          {sections.map(({ id, label, icon: Icon }) => (
            <Button
              key={id}
              type="button"
              variant="ghost"
              aria-current={section === id ? 'page' : undefined}
              onClick={() => setSection(id)}
            >
              <Icon size={15} aria-hidden="true" />
              <span>{label}</span>
            </Button>
          ))}
          <span className="settings-brand">Scientify</span>
        </nav>
      }
    >
      <div className="settings-scroll">
        <section hidden={section !== 'general'} aria-label={t('通用')}>
          <div className="settings-preference-row">
            <PreferenceFields field="language" />
            <p>{t('仅切换界面语言，不修改研究内容。')}</p>
          </div>
          <h3 className="settings-section-heading">{t('个人资料')}</h3>
          <form
            className="settings-profile"
            onSubmit={async (e) => {
              e.preventDefault();
              if (busy || !data || !dirty) return;
              setProfileError('');
              const name = profile.name;
              const success = await store.getState().update((d) => {
                d.settings.name = name;
              });
              if (success) {
                setProfile({ name, saved: name });
                setSaved(true);
              } else setProfileError(store.getState().error ?? t('保存失败，请重试。'));
            }}
          >
            <label className="settings-input-row">
              {t('显示名称')}
              <Input
                disabled={busy || !data}
                value={profile.name}
                maxLength={100}
                onChange={(e) => {
                  setProfile({ ...profile, name: e.target.value });
                  setSaved(false);
                  setProfileError('');
                }}
              />
            </label>
            <p className="settings-note">{t('这是本地个人资料，无需登录。')}</p>
            {profileError ? (
              <p role="alert" className="error-text">
                {translateError(profileError)}
              </p>
            ) : null}
            <footer className="settings-actions">
              <span role="status">{saved && !dirty ? t('已保存') : ''}</span>
              <Button type="submit" variant="primary" disabled={busy || !data || !dirty}>
                {busy ? t('正在保存…') : t('保存偏好')}
              </Button>
            </footer>
          </form>
        </section>
        <section hidden={section !== 'appearance'} aria-label={t('外观')}>
          <div className="settings-preference-row">
            <PreferenceFields field="theme" />
            <p>{t('跟随系统，或固定使用浅色和深色外观。')}</p>
          </div>
          <p className="settings-note">{t('顶栏按钮可直接切换亮暗。')}</p>
        </section>
        <section hidden={section !== 'data'} aria-label={t('数据与备份')}>
          <DataPreferences store={store} />
        </section>
        <section hidden={section !== 'about'} aria-label={t('关于 Scientify')}>
          <div className="settings-about">
            <h3>Scientify</h3>
            <p>{t('本地科研工作区 · 文献 / 笔记 / 实验 / 论文')}</p>
            <p>
              {t(
                '已支持：本地文献与 PDF 阅读、笔记、代码编辑、Git 差异、并行实验与日志、运行结果、Markdown 预览，以及可操作工作区的全局 AI。',
              )}
            </p>
            <p>
              {t(
                '后续接入：代码版本管理、LaTeX 编译、自动订阅更新与 PDF 批注。模型服务在 AI 助手中配置。',
              )}
            </p>
            <p>
              {t(
                'JSON 导出包含元数据，不包含 PDF 和源码；备份请保留完整数据目录及关联项目文件夹。',
              )}
            </p>
          </div>
        </section>
      </div>
    </Modal>
  );
}
