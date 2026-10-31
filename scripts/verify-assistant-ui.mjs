import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { launchUiBrowser } from './ui-test-browser.mjs';

const directory = resolve('.test-artifacts/assistant-ui');
await mkdir(directory, { recursive: true });
const fixtureName = `assistant-fixture-${process.pid}.html`;
const fixturePath = join(directory, fixtureName);
const browser = await launchUiBrowser();
const page = await browser.newPage({ viewport: { width: 1100, height: 820 } });
page.setDefaultTimeout(15_000);
const errors = [];
const checks = [];
const diagnostics = [];
const check = (value, label) => {
  assert.ok(value, label);
  checks.push(label);
};
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') diagnostics.push(message.text());
});
page.on('requestfailed', (request) =>
  diagnostics.push(`${request.url()}: ${request.failure()?.errorText}`),
);
try {
  await writeFile(
    fixturePath,
    `<!doctype html><html><body><div id="root" style="width:340px;height:760px;margin:20px 20px 20px auto;display:flex;flex-direction:column;border:1px solid var(--sf-border-control)"></div><script type="module">
import React from 'react';
import {createRoot} from 'react-dom/client';
import '/src/styles.css';
import '/src/components/layout/layout.css';
import '/src/shell/auxiliary.css';
import {AssistantPanel} from '/src/features/assistant/AssistantPanel.tsx';
import {emptyWorkspace} from '/src/domain/workspace.ts';
import {createWorkspaceStore} from '/src/stores/workspace.ts';
window.turns=[];
window.stops=[];
window.skillRequests=[];
const data=emptyWorkspace();
data.projects.push({id:'fixture',name:'Fixture',space:'personal',createdAt:'',question:''});
data.settings.model={provider:'ollama',endpoint:'http://127.0.0.1:11434',model:'fixture-model-with-a-long-name'};
const store=createWorkspaceStore({load:async()=>({workspace:data,directory:'fixture',legacyAvailable:false}),save:async value=>value});
await store.getState().load();
const queues=new Map();
const agent={
  skills:async request=>{window.skillRequests.push(request);return {skills:[{name:'paper-review',path:'F:/fixture/.agents/skills/paper-review/SKILL.md',description:'Review a paper using local materials',enabled:true}],errors:[]};},
  startThread:async(projectId,domain,connection,options)=>({projectId,domain,conversationId:options.conversationId,threadId:options.conversationId,cwd:'F:/fixture',model:connection.model,modelProvider:'scientify',instructionSources:[],sandbox:options.permission==='full'?'dangerFullAccess':'workspaceWrite'}),
  startTurn:async request=>{window.turns.push(request);return {turnId:'turn-'+request.conversationId,status:'inProgress',events:[]};},
  events:async(_project,_domain,id)=>queues.get(id)?.splice(0)??[],
  interrupt:async request=>{window.stops.push(request);queues.set(request.conversationId,[{kind:'notification',method:'turn/completed',params:{threadId:request.threadId,turn:{id:request.turnId,status:'interrupted'}}}]);},
  respond:async()=>{},release:async()=>{}
};
createRoot(document.getElementById('root')).render(React.createElement(AssistantPanel,{store,backend:{},agent,scope:'fixture',context:{projectId:'fixture',workspace:'experiments',title:'Fixture'}}));
</script></body></html>`,
  );
  const url = process.env.SCIENTIFY_UI_URL || 'http://127.0.0.1:1420';
  await page.goto(`${url}/.test-artifacts/assistant-ui/${fixtureName}`, {
    waitUntil: 'commit',
    timeout: 60_000,
  });
  const input = page.getByRole('textbox', { name: '向 AI 提问' });
  await input.waitFor({ timeout: 60_000 });
  const permissions = page.getByRole('button', { name: '执行权限' });
  const model = page.getByRole('button', { name: '选择模型' });
  const modelRect = await model.boundingBox();
  const permissionRect = await permissions.boundingBox();
  check(
    permissionRect.x > modelRect.x && Math.abs(permissionRect.y - modelRect.y) < 2,
    'Permission capsule follows the model on the same row',
  );
  await input.fill('/permission');
  await input.press('Enter');
  await page.getByRole('menuitemradio', { name: /^完全允许/ }).click();
  await page.waitForFunction(
    () => document.querySelector('[aria-label="执行权限"]').dataset.permission === 'full',
  );
  check(
    (await page.evaluate(() => window.turns.length)) === 0,
    'Slash permission command stays local',
  );
  await input.fill('/skills');
  await input.press('Enter');
  await page.getByRole('option', { name: /paper-review/ }).waitFor();
  check(
    await page.evaluate(() => document.activeElement === document.querySelector('textarea')),
    'Skill suggestions keep keyboard focus in the input',
  );
  await page.screenshot({ path: join(directory, 'skills-light.png') });
  await input.press('Enter');
  await page.getByLabel('待发送技能').waitFor();
  await input.fill('Review this paper');
  await input.press('Enter');
  await page.waitForFunction(() => window.turns.length === 1);
  check(
    await page.evaluate(
      () =>
        window.turns[0].permission === 'full' && window.turns[0].skills[0].name === 'paper-review',
    ),
    'Turn receives the selected permission and skill',
  );
  check(await permissions.isDisabled(), 'Permission cannot escalate during an active turn');
  await input.fill('Next message draft');
  check(
    (await input.inputValue()) === 'Next message draft',
    'Input stays editable while the Agent works',
  );
  await input.fill('/stop');
  await input.press('Enter');
  await page.waitForFunction(() => window.stops.length === 1);
  await page.getByRole('button', { name: '发送', exact: true }).waitFor();
  check(!(await permissions.isDisabled()), 'Permission unlocks after stop and result persistence');
  await page.getByRole('button', { name: '新建 AI 对话', exact: true }).click();
  check(
    (await permissions.getAttribute('data-permission')) === 'ask',
    'New chat does not inherit full access',
  );
  await page.evaluate(() => {
    document.getElementById('root').style.width = '270px';
  });
  check(
    await page
      .locator('.sf-ai-composer-actions')
      .evaluate((row) => row.scrollWidth <= row.clientWidth + 1),
    'Narrow 270px sidebar controls do not overflow',
  );
  await page.evaluate(() => {
    document.documentElement.classList.add('dark');
  });
  await input.fill('/');
  await page.getByRole('listbox', { name: '快捷命令' }).waitFor();
  const menuRect = await page.locator('.sf-ai-command-menu').boundingBox();
  check(
    menuRect.y >= 0 && menuRect.x + menuRect.width <= 1100,
    'Command menu stays within the viewport',
  );
  await page.screenshot({ path: join(directory, 'commands-dark.png') });
  await input.press('Escape');
  check((await page.getByRole('listbox').count()) === 0, 'Escape dismisses the command list');
  check(errors.length === 0, `No browser runtime errors: ${errors.join('; ')}`);
  await writeFile(
    join(directory, 'report.json'),
    JSON.stringify({ date: new Date().toISOString(), fixtureOnly: true, checks, errors }, null, 2),
  );
  console.log(`Assistant UI checks passed: ${checks.length}`);
} catch (error) {
  await page.screenshot({ path: join(directory, 'failure.png') });
  await writeFile(
    join(directory, 'failure.json'),
    JSON.stringify({ error: String(error), errors, diagnostics }, null, 2),
  );
  throw error;
} finally {
  await browser.close();
  await rm(fixturePath, { force: true });
}
