import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { launchUiBrowser } from './ui-test-browser.mjs';

const directory = resolve('.test-artifacts/sources-ui');
await mkdir(directory, { recursive: true });
const name = `sources-fixture-${process.pid}.html`;
const fixture = join(directory, name);
const browser = await launchUiBrowser();
const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
page.setDefaultTimeout(60000);
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
async function checkDialog(name, maxWidth) {
  const dialog = page.getByRole('dialog', { name, exact: true });
  await dialog.waitFor();
  for (const viewport of [
    { width: 1100, height: 760 },
    { width: 390, height: 500 },
  ]) {
    await page.setViewportSize(viewport);
    const layout = await dialog.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const form = el.querySelector('form');
      return {
        width: rect.width,
        height: rect.height,
        x: rect.x,
        y: rect.y,
        overflow: el.scrollWidth > el.clientWidth,
        padding: parseFloat(getComputedStyle(form).paddingLeft),
        controlsFit: [...form.querySelectorAll('input,select,button')].every((control) => {
          const box = control.getBoundingClientRect();
          return box.left >= rect.left + 16 && box.right <= rect.right - 16;
        }),
      };
    });
    assert.ok(
      layout.width <= maxWidth && layout.width <= viewport.width - 38,
      `${name}: compact width`,
    );
    assert.ok(
      layout.height < viewport.height - 60 && layout.y >= 20,
      `${name}: content-sized height`,
    );
    assert.ok(
      !layout.overflow && layout.padding >= 16 && layout.controlsFit,
      `${name}: padded controls without overflow`,
    );
    await page.screenshot({ path: join(directory, `${name}-${viewport.width}.png`) });
  }
  await page.setViewportSize({ width: 1100, height: 760 });
}
try {
  await writeFile(
    fixture,
    `<!doctype html><html><body><div id="root"></div><script type="module">
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import '/src/styles.css';
    import '/src/components/layout/layout.css';
    import {SubscriptionSidebar} from '/src/workspaces/literature/SubscriptionSidebar.tsx';
    import {FeaturePlaceholder} from '/src/components/workspace/FeaturePlaceholder.tsx';
    import {emptyWorkspace} from '/src/domain/workspace.ts';
    import {createWorkspaceStore} from '/src/stores/workspace.ts';
    let disk=emptyWorkspace();
    window.store=createWorkspaceStore({load:async()=>({workspace:structuredClone(disk),directory:'fixture',legacyAvailable:false}),save:async data=>{disk=structuredClone(data);return data;}});
    await window.store.getState().load();
    window.opened=[];
    function App(){const [recommendations,setRecommendations]=React.useState(false);return React.createElement('main',{style:{display:'flex',height:'100vh'}},
      React.createElement('aside',{id:'sources',style:{display:'flex',width:240,flexShrink:0,borderRight:'1px solid var(--sf-border-subtle)'}},React.createElement(SubscriptionSidebar,{store:window.store,onNewBrowser:()=>{},onOpen:async url=>window.opened.push(url),onRecommendations:()=>setRecommendations(true),bookmark:null,onBookmarkHandled:()=>{}})),
      React.createElement('section',{style:{flex:1,minWidth:0,display:'flex'}},recommendations?React.createElement(FeaturePlaceholder,{feature:'recommendations'}):React.createElement('p',{style:{margin:'auto'}},'浏览器 / 文献工作区')));}
    createRoot(document.getElementById('root')).render(React.createElement(App));
  </script></body></html>`,
  );
  await page.goto(`${process.env.SCIENTIFY_UI_URL}/.test-artifacts/sources-ui/${name}`, {
    waitUntil: 'commit',
  });
  await page.getByRole('button', { name: '新建分组', exact: true }).click();
  await checkDialog('新建分组', 400);
  await page.getByRole('textbox', { name: '新建分组', exact: true }).fill('论文网站');
  await page.getByRole('button', { name: '确认', exact: true }).click();
  const group = await page.evaluate(() => window.store.getState().data.webSources.groups[0].id);
  await page.getByRole('button', { name: '添加信息源', exact: true }).click();
  await checkDialog('添加信息源', 440);
  await page.getByRole('textbox', { name: '名称', exact: true }).fill('arXiv · 论文与预印本');
  await page.getByRole('textbox', { name: '网址', exact: true }).fill('https://arxiv.org');
  await page.getByRole('combobox', { name: '分组', exact: true }).selectOption(group);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('button', { name: 'arXiv · 论文与预印本', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.opened), ['https://arxiv.org/']);
  await page.getByRole('button', { name: '论文网站', exact: true }).click();
  assert.equal(
    await page.getByRole('button', { name: 'arXiv · 论文与预印本', exact: true }).count(),
    0,
  );
  await page.getByRole('button', { name: '论文网站', exact: true }).click();
  for (const width of [200, 240, 320]) {
    await page.locator('#sources').evaluate((el, width) => {
      el.style.width = `${width}px`;
    }, width);
    assert.equal(
      await page.locator('#sources').evaluate((el) => el.scrollWidth <= el.clientWidth),
      true,
      `source sidebar fits ${width}px`,
    );
  }
  await page.locator('#sources').evaluate((el) => {
    el.style.width = '240px';
  });
  await page.getByRole('button', { name: /消息推荐/ }).click();
  await page.getByText('敬请期待', { exact: true }).waitFor();
  await page.screenshot({ path: join(directory, 'subscriptions.png') });
  assert.deepEqual(errors, []);
  console.log(
    'Sources UI passed: group/source creation, open, collapse, narrow layouts and recommendation entry.',
  );
} catch (error) {
  await writeFile(
    join(directory, 'failure.json'),
    JSON.stringify({ error: String(error), errors }, null, 2),
  );
  await page.screenshot({ path: join(directory, 'failure.png') });
  throw error;
} finally {
  await browser.close();
  await rm(fixture, { force: true });
}
