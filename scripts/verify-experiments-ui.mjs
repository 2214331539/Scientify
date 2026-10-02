import { createRequire } from 'node:module';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
const require = createRequire(join(process.env.TEMP, 'scientify-prototype-tools', 'package.json'));
const { chromium } = require('playwright');
const browser = await chromium.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 940 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const directory = join(process.env.TEMP, 'scientify-experiments-ui');
await mkdir(directory, { recursive: true });
const checks = [];
const check = (value, label) => {
  if (!value) throw new Error(label);
  checks.push(label);
};
try {
  await page.addInitScript(() => {
    const project = {
      id: 'ui-experiment',
      name: '实验工作区验收',
      question: '布局验收夹具，不是真实研究数据',
      space: 'personal',
      createdAt: '2026-10-01',
      runConfigurations: [
        {
          id: 'c1',
          name: 'Baseline',
          executable: 'python',
          args: ['src/train.py', '--seed', '42'],
          cwd: '.',
        },
      ],
    };
    const data = {
      schema: 3,
      revision: 0,
      updatedAt: '2026-10-01',
      teams: [],
      projects: [project],
      papers: [],
      records: [],
      runs: [
        {
          id: 'manual-a',
          project: project.id,
          name: 'Baseline 复现',
          status: 'completed',
          config: 'seed=42',
          conclusion: '验收用手动记录',
          metrics: [{ name: 'accuracy', value: 0.8 }],
          updatedAt: '2026-10-01',
        },
        {
          id: 'manual-b',
          project: project.id,
          name: '参数对照',
          status: 'completed',
          config: 'seed=43',
          metrics: [{ name: 'accuracy', value: 0.81 }],
          updatedAt: '2026-10-01',
        },
      ],
      tasks: [],
      sessions: [
        {
          id: 'fixture-chat',
          project: project.id,
          title: 'AI experiment fixture',
          messages: [],
          context: [],
          updatedAt: '2026-10-02',
        },
      ],
      subscriptions: [],
      trash: [],
      recent: [],
      activity: [],
      settings: {
        theme: 'light',
        name: '',
        model: { endpoint: 'http://127.0.0.1:11434', model: '' },
      },
      navigation: { tabs: ['home'], active: 'home', expanded: [], panel: null },
    };
    localStorage.setItem('scientify.mvp.preview.workspace.v1', JSON.stringify(data));
    localStorage.setItem(
      'scientify.mvp.preview.files.v1',
      JSON.stringify({
        [project.id]: {
          'src/train.py': {
            path: 'src/train.py',
            content:
              'from pathlib import Path\n\ndef train(seed=42):\n    print("training", seed)\n\nif __name__ == "__main__":\n    train()\n',
            version: 'test-v1',
          },
          'configs/baseline.json': {
            path: 'configs/baseline.json',
            content: '{"seed":42}',
            version: 'test-v1',
          },
        },
      }),
    );
    localStorage.setItem(
      'scientify.ui.v2',
      JSON.stringify({
        version: 2,
        projectId: project.id,
        space: 'personal',
        locations: {
          [project.id]: {
            workspace: 'experiments',
            view: 'files',
            paths: { experiments: 'src/train.py' },
            paperId: null,
          },
        },
        dock: 'assistant',
        dockOpen: false,
        leftWidth: 224,
        rightWidth: 340,
      }),
    );
  });
  await page.goto(process.env.SCIENTIFY_UI_URL || 'http://127.0.0.1:1420', {
    waitUntil: 'domcontentloaded',
    timeout: 120000,
  });
  await page.locator('.cm-editor').waitFor({ timeout: 120000 });
  check(
    await page.getByRole('button', { name: '运行', exact: true }).isDisabled(),
    'Browser never simulates native execution',
  );
  await page.screenshot({ path: join(directory, 'Code.png') });
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('\n# preserved');
  await page.getByRole('button', { name: '实验记录', exact: true }).click();
  await page.getByRole('table', { name: '实验记录列表' }).waitFor();
  await page.screenshot({ path: join(directory, 'Runs.png') });
  await page.getByRole('checkbox', { name: '比较 Baseline 复现' }).check();
  await page.getByRole('checkbox', { name: '比较 参数对照' }).check();
  await page.getByRole('button', { name: /比较 \(2/ }).click();
  check(
    (await page.getByRole('table', { name: '运行比较' }).count()) === 1,
    'Manual records compare',
  );
  await page.getByRole('button', { name: '代码', exact: true }).click();
  check(
    (await page.locator('.cm-content').innerText()).includes('# preserved'),
    'Code draft survives Runs view',
  );
  await page.getByRole('button', { name: '编辑运行配置' }).click();
  await page.getByLabel('配置名称', { exact: true }).fill('Baseline revised');
  await page.getByRole('button', { name: '保存配置' }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  check(
    (await page.getByLabel('运行配置', { exact: true }).innerText()).includes('revised'),
    'Real configuration persists in preview store',
  );
  await page.getByRole('button', { name: '环境与依赖' }).click();
  check(
    (await page.getByRole('dialog').innerText()).includes('不表示环境检测已通过'),
    'Environment distinguishes configuration from discovery',
  );
  await page.getByRole('button', { name: '关闭弹窗' }).click();
  await page.getByRole('button', { name: '变更', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Git' }).waitFor();
  check(true, 'Browser Git unavailable state is explicit');
  await page.getByRole('button', { name: '代码', exact: true }).click();
  for (const width of [1440, 1000, 800, 600, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 680 });
    const rect = await page.getByRole('button', { name: '运行', exact: true }).boundingBox();
    check(rect && rect.x >= 0 && rect.x + rect.width <= width, 'Run control visible at ' + width);
    check(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      'No document overflow at ' + width,
    );
    await page.screenshot({ path: join(directory, 'Code-' + width + '.png') });
  }
  await page.evaluate(() =>
    localStorage.setItem(
      'scientify.preferences.v1',
      JSON.stringify({ language: 'en', theme: 'dark' }),
    ),
  );
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.cm-editor').waitFor();
  await page.setViewportSize({ width: 1440, height: 940 });
  await page.getByRole('button', { name: 'AI assistant', exact: true }).click();
  for (const width of [1440, 1000, 800]) {
    await page.setViewportSize({ width, height: 940 });
    const rect = await page.getByRole('button', { name: 'Run', exact: true }).boundingBox();
    check(
      rect && rect.x >= 0 && rect.x + rect.width <= width,
      'English run visible with AI open at ' + width,
    );
    check(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      'Dark English AI-open no overflow at ' + width,
    );
    const bar = await page.locator('.workspace-commandbar').boundingBox();
    const actions = await page.locator('.sf-experiment-actions').boundingBox();
    check(
      actions.y + actions.height <= bar.y + bar.height + 1,
      'Experiment actions stay inside header at ' + width,
    );
  }
  await page.screenshot({ path: join(directory, 'Code-dark-English-AI.png') });
  await page.getByRole('button', { name: 'Runs', exact: true }).click();
  await page.getByRole('table', { name: 'Experiment records' }).waitFor();
  check(true, 'English Runs table available with AI open');
  await page.evaluate(async () => {
    const { executionStore, experimentApi } =
      await import('/src/workspaces/experiments/runtime.ts');
    const run = {
      id: 'fixture-run',
      project: 'ui-experiment',
      name: 'Evaluation · seed 42 · long experiment name',
      status: 'running',
      startedAt: 1,
      endedAt: null,
      exitCode: null,
      configuration: {
        id: 'cfg',
        name: 'Evaluation',
        executable: 'python',
        args: ['eval.py'],
        cwd: '.',
      },
      directory: 'C:/fixture',
      executable: 'python',
      platform: 'windows',
      gitCommit: null,
      gitChanges: [],
      error: null,
      permission: 'workspace-write',
      source: {
        conversationId: 'fixture-chat',
        threadId: 'fixture-thread',
        turnId: 'fixture-turn',
        callId: 'fixture-call',
        workspaceRoot: 'C:/fixture',
      },
    };
    executionStore.setState({ runs: [run] });
    experimentApi.log = async () => 'Fixture log: evaluation complete\naccuracy=0.9';
    experimentApi.artifacts = async () => [
      { path: 'metrics.json', name: 'metrics.json', kind: 'file', size: 16 },
    ];
    experimentApi.artifact = async () => ({
      path: 'metrics.json',
      content: '{"accuracy":0.9}',
      version: 'fixture',
    });
    experimentApi.stop = async () =>
      executionStore.setState({ runs: [{ ...run, status: 'cancelled', endedAt: 2 }] });
  });
  await page.locator('.sf-ai-run').waitFor();
  for (const width of [1440, 1000, 800, 600, 390]) {
    await page.setViewportSize({ width, height: 940 });
    const row = await page.locator('.sf-ai-run').boundingBox();
    check(row && row.x >= 0 && row.x + row.width <= width, 'Linked run visible at ' + width);
    for (const button of await page.locator('.sf-ai-run button').all()) {
      const box = await button.boundingBox();
      check(
        box && box.x >= row.x && box.x + box.width <= row.x + row.width + 1,
        'Linked run action contained at ' + width,
      );
    }
    await page.screenshot({ path: join(directory, 'AI-run-' + width + '.png') });
  }
  await page.setViewportSize({ width: 1000, height: 940 });
  await page.getByRole('button', { name: 'View logs and results', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByLabel('Read-only run log')
    .filter({ hasText: 'accuracy=0.9' })
    .waitFor();
  await page
    .getByRole('dialog')
    .evaluate(async (element) =>
      Promise.all(
        element
          .getAnimations({ subtree: true })
          .map((animation) => animation.finished.catch(() => {})),
      ),
    );
  await page.screenshot({ path: join(directory, 'AI-run-logs.png') });
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByRole('button', { name: 'Open experiment run', exact: true }).click();
  check(
    (await page.locator('.sf-experiment-runs').innerText()).includes('AI experiment'),
    'Chat navigates to same formal run with AI source',
  );
  await page.getByRole('button', { name: 'Stop experiment', exact: true }).click();
  await page.locator('.sf-ai-run').filter({ hasText: 'Cancelled' }).waitFor();
  check(true, 'Stopping experiment updates linked card');
  check(errors.length === 0, 'No browser runtime errors: ' + errors.join('; '));
  await writeFile(
    join(directory, 'report.json'),
    JSON.stringify({ date: '2026-10-02', fixtureOnly: true, checks, errors }, null, 2),
  );
  console.log(JSON.stringify({ passed: checks.length, errors, screenshots: directory }, null, 2));
} finally {
  await browser.close();
}
