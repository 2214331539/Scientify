import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { launchUiBrowser } from './ui-test-browser.mjs';

const dir = resolve('.test-artifacts/collaboration-ui');
await mkdir(dir, { recursive: true });
const file = join(dir, `collaboration-fixture-${process.pid}.html`);
const browser = await launchUiBrowser();
const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
page.setDefaultTimeout(60_000);
const errors = [];
const pending = new Set();
page.on('request', (request) => pending.add(request.url()));
page.on('requestfinished', (request) => pending.delete(request.url()));
page.on('requestfailed', (request) => pending.delete(request.url()));
page.on('pageerror', (error) => errors.push(error.message));
try {
  await writeFile(
    file,
    `<!doctype html><html><body><div id="root"></div><script type="module">
import React from 'react'; import {createRoot} from 'react-dom/client';
import '/src/styles.css'; import '/src/components/layout/layout.css';
import {ProjectSyncControl} from '/src/features/projects/ProjectSyncControl.tsx';
import {createWorkspaceStore} from '/src/stores/workspace.ts';
import {emptyWorkspace} from '/src/domain/workspace.ts';
import {collaboration} from '/src/platform/collaboration.ts';
import {setPreferences} from '/src/i18n/preferences.ts';
setPreferences({language:'zh-CN',theme:'light'});
const project={id:'demo',name:'协作验收 · 示例项目',question:'',space:'personal',createdAt:'',collaborationRole:'owner'};
const data=emptyWorkspace(); data.projects=[project];
const store=createWorkspaceStore({load:async()=>({workspace:data,directory:'test',legacyAvailable:false}),save:async(d)=>d}); await store.getState().load();
collaboration.status=async()=>({authenticated:true,enabled:true});
collaboration.syncState=async()=>({lastSyncAt:'2026-11-11T00:00:00Z',lastError:null,tracked:24,pending:2,paused:false,conflicts:[{domain:'record',path:'研究笔记 · 方法比较',copy:'local',at:'2026-11-11T00:00:00Z'}]});
collaboration.conflictPreview=async()=>({token:'demo',canKeepLocal:true,canKeepBoth:true,local:{exists:true,text:'# 方法比较\\n\\n保留本机的消融实验分析。\\n\\n- 基准模型\\n- 参数变化',bytes:124,truncated:false},remote:{exists:true,text:'# 方法比较\\n\\n同事补充了对照实验结果。\\n\\n- 基准模型\\n- 结果分析',bytes:128,truncated:false}});
createRoot(document.getElementById('root')).render(React.createElement(ProjectSyncControl,{project,store}));
</script></body></html>`,
  );
  const url = process.env.SCIENTIFY_UI_URL ?? 'http://127.0.0.1:5173';
  await page.goto(`${url}/.test-artifacts/collaboration-ui/${file.split(/[\\/]/).at(-1)}`, {
    waitUntil: 'commit',
    timeout: 60_000,
  });
  await page.getByRole('button', { name: '项目同步：有冲突' }).click();
  await page.getByRole('button', { name: '查看对比' }).waitFor();
  await page.screenshot({ path: join(dir, 'sync-panel.png') });
  await page.getByRole('button', { name: '查看对比' }).click();
  await page.getByRole('button', { name: '保留本机' }).waitFor();
  await page.screenshot({ path: join(dir, 'conflict-comparison.png') });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
  await page.screenshot({ path: join(dir, 'conflict-dark.png') });
  await page.evaluate(() => {
    delete document.documentElement.dataset.theme;
  });
  await page.setViewportSize({ width: 600, height: 720 });
  await page.screenshot({ path: join(dir, 'conflict-narrow.png') });
  const overflow = await page
    .locator('.project-sync-content')
    .evaluate((el) => el.scrollWidth > el.clientWidth + 1);
  assert.equal(overflow, false, 'The sync panel must not overflow on a narrow window');
  await page.getByRole('button', { name: '两份都保留' }).scrollIntoViewIfNeeded();
  assert.ok(await page.getByRole('button', { name: '两份都保留' }).isVisible());
  assert.deepEqual(errors, []);
  console.log('Collaboration UI passed: sync panel, conflict comparison and narrow layout.');
} catch (error) {
  console.error('Browser errors:', errors);
  console.error('Pending requests:', [...pending]);
  await page.screenshot({ path: join(dir, 'failure.png'), timeout: 5000 }).catch(() => {});
  throw error;
} finally {
  await browser.close();
  await rm(file, { force: true });
}
