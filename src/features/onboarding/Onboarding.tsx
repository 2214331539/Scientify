import { useEffect, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { Button } from '../../components/primitives';
import { t, translateError } from '../../i18n';
import type { WorkspaceStore } from '../../stores/workspace';
import { restartApp, useDataLocation } from '../settings/DataLocation';
import { Tour, type TourStep } from './Tour';

const KEYS = { center: 'scientify.tour.center.v1', project: 'scientify.tour.project.v1' };
type Which = keyof typeof KEYS;

function seen(which: Which) {
  try {
    return localStorage.getItem(KEYS[which]) === 'done';
  } catch {
    return true;
  }
}
function remember(which: Which) {
  try {
    localStorage.setItem(KEYS[which], 'done');
  } catch {
    /* A tour that cannot be remembered may show again. */
  }
}

/** On a fresh installation: where the data will live, before anything is in it. */
function DataChoice({ store }: { store: WorkspaceStore }) {
  const data = useDataLocation(store);
  if (!data.ready) return null;
  return (
    <div className="sf-tour-data">
      <span>{t('数据保存在')}</span>
      <code>{data.next ?? data.directory}</code>
      {data.next ? (
        <div>
          <Button variant="primary" onClick={() => void restartApp()}>
            {t('重启后使用')}
          </Button>
          <Button variant="ghost" onClick={() => void data.change('cancel')}>
            {t('取消')}
          </Button>
        </div>
      ) : (
        <div>
          <Button disabled={data.blocked} onClick={() => void data.change('move')}>
            {t('换个位置')}
          </Button>
          <Button disabled={data.blocked} onClick={() => void data.change('adopt')}>
            {t('使用已有数据')}
          </Button>
        </div>
      )}
      {data.error ? <span role="alert">{translateError(data.error)}</span> : null}
    </div>
  );
}

export function centerSteps(store: WorkspaceStore, fresh: boolean): TourStep[] {
  return [
    {
      title: t('欢迎使用 Scientify'),
      body: t('读文献、写代码、写论文，都在一个窗口里。花一分钟认识一下。'),
      content: fresh ? <DataChoice store={store} /> : undefined,
    },
    {
      target: '[data-tour="new-project"]',
      title: t('一个课题，一个项目'),
      body: t('文献、代码、稿件和 AI 对话都放在项目里。'),
    },
    {
      target: '.sf-searchbox',
      title: t('搜索与命令'),
      body: t('Ctrl K 找项目、论文和笔记，也能直接执行命令。'),
    },
    {
      target: '[data-tour="settings"]',
      title: t('设置'),
      body: t('选择 AI 模型、数据位置和界面语言。'),
    },
    {
      target: '[data-tour="help"]',
      title: t('随时回看'),
      body: t('在帮助里能再看一遍导览。打开一个项目，继续认识里面的功能。'),
    },
  ];
}

export function projectSteps(): TourStep[] {
  return [
    {
      target: '.sf-nav',
      title: t('四个模块'),
      body: t('文献、代码、写作、文档，在这里切换。'),
    },
    {
      target: '[data-tour="import-library"]',
      title: t('从 Zotero 搬过来'),
      body: t('导入 Zotero 文库或 BibTeX、RIS，分类、PDF、笔记和高亮都会带上。'),
    },
    {
      target: '[data-tour="browser"]',
      title: t('内置浏览器'),
      body: t('查资料、下论文，不用离开 Scientify。'),
    },
    {
      target: '[data-tour="share"]',
      title: t('共享'),
      body: t('邀请同学或同事，一起读、一起写。'),
    },
    {
      target: '[data-tour="notes"]',
      title: t('文档'),
      body: t('随手记想法，块、表格和链接都支持。'),
    },
    {
      target: '[data-tour="assistant"]',
      title: t('AI 助手'),
      body: t('它能读你的论文和代码，帮你查、帮你改。读论文时选中文字，可以高亮、批注或直接问它。'),
    },
  ];
}

/**
 * Shows the window's main controls once: the project center at first launch,
 * the inside of a project the first time one is open. Help → 功能导览 replays.
 */
export function Onboarding({
  store,
  ready,
  inProject,
  auto = import.meta.env.MODE !== 'test',
}: {
  store: WorkspaceStore;
  ready: boolean;
  inProject: boolean;
  /** Start by itself the first time; tests of other screens turn it off. */
  auto?: boolean;
}) {
  const which: Which = inProject ? 'project' : 'center';
  const [running, setRunning] = useState<Which | null>(null);
  const [fresh, setFresh] = useState(false);
  useEffect(() => {
    if (!auto || !ready || running || seen(which)) return;
    // Let the page settle, and never start over a dialog.
    const timer = setTimeout(() => {
      if (document.querySelector('dialog[open]')) return;
      const data = store.getState().data;
      setFresh(isTauri() && !import.meta.env.DEV && !data?.projects.length);
      setRunning(which);
    }, 700);
    return () => clearTimeout(timer);
  }, [auto, ready, which, running, store]);
  useEffect(() => {
    const replay = () => {
      setFresh(false);
      setRunning(which);
    };
    window.addEventListener('scientify-start-tour', replay);
    return () => window.removeEventListener('scientify-start-tour', replay);
  }, [which]);
  if (!running) return null;
  return (
    <Tour
      key={running}
      label={t('功能导览')}
      steps={running === 'center' ? centerSteps(store, fresh) : projectSteps()}
      onFinish={() => {
        remember(running);
        setRunning(null);
      }}
    />
  );
}
