import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
const require = createRequire(resolve('.test-tools/package.json'));
const { chromium } = require('playwright');
const browser = await chromium.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 940 } });
const directory = resolve('.test-artifacts/git-ui');
await mkdir(directory, { recursive: true });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const checks = [];
function check(value, label) {
  if (!value) throw new Error(label);
  checks.push(label);
}
try {
  await page.addInitScript(() => {
    const project = {
      id: 'git-fixture',
      name: 'Git worktree verification',
      question: '',
      space: 'personal',
      createdAt: '2026-10-02',
    };
    const data = {
      schema: 3,
      revision: 0,
      updatedAt: '2026-10-02',
      projects: [project],
      teams: [],
      papers: [],
      records: [],
      runs: [],
      tasks: [],
      sessions: [],
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
      'scientify.preferences.v1',
      JSON.stringify({ language: 'zh-CN', theme: 'light' }),
    );
    localStorage.setItem(
      'scientify.ui.v2',
      JSON.stringify({
        version: 2,
        projectId: project.id,
        space: 'personal',
        locations: {
          [project.id]: {
            workspace: 'overview',
            view: 'overview',
            paths: { experiments: 'train.py' },
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
  });
  await page.getByRole('button', { name: '实验', exact: true }).waitFor();
  await page.evaluate(async () => {
    // Vite can retain HMR timestamps even across fresh pages. Use the modules
    // already loaded by the app so the fixture patches those exact instances.
    window.__gitModuleUrl = (path) =>
      performance
        .getEntriesByType('resource')
        .find((entry) => new URL(entry.name).pathname === path)?.name ?? path;
    const { gitApi } = await import(window.__gitModuleUrl('/src/platform/git.ts'));
    const { browserResearch } = await import(window.__gitModuleUrl('/src/platform/browser.ts'));
    const root = 'F:/fixture/main';
    const other = 'F:/fixture/new-loss';
    const tree = (path, branch) => ({
      root: path,
      branch,
      head: '123456abcdef',
      locked: false,
      missing: false,
      busy: false,
      changes: 0,
    });
    const base = {
      root,
      repository: true,
      branch: 'main',
      head: '123456abcdef',
      busy: false,
      changes: [
        { path: 'train.py', status: 'MM' },
        { path: 'new.py', status: '??' },
      ],
      branches: [
        { name: 'main', current: true },
        { name: 'feature/new-loss', current: false },
      ],
      history: [
        {
          sha: '123456abcdef',
          subject: 'baseline',
          author: 'Fixture',
          time: '2026-10-02T00:00:00Z',
        },
      ],
      stashes: [],
      worktrees: [tree(root, 'main'), tree(other, 'feature/new-loss')],
    };
    const state = {
      snapshots: {
        [root]: base,
        [other]: { ...structuredClone(base), root: other, branch: 'feature/new-loss', changes: [] },
      },
      files: {
        [root]: { 'train.py': 'print("main")\n', 'new.py': '# new\n' },
        [other]: { 'train.py': 'print("new-loss")\n' },
      },
      actions: [],
      diffs: [],
      failCommit: true,
    };
    window.__gitFixture = state;
    gitApi.available = () => true;
    gitApi.inspect = async (_project, selected) =>
      structuredClone(state.snapshots[selected || root]);
    gitApi.diff = async (_project, selected, path, staged, commit) => {
      state.diffs.push({ selected, path, staged, commit });
      return '@@ -1 +1 @@\n-print("baseline")\n+print("new-loss")\n';
    };
    gitApi.action = async (_project, selected, request) => {
      state.actions.push({ selected, ...request });
      const snapshot = state.snapshots[selected];
      if (request.kind === 'commit') {
        if (state.failCommit) {
          state.failCommit = false;
          throw new Error('Fixture identity missing');
        }
        snapshot.changes = snapshot.changes.filter((c) => c.status === '??');
        snapshot.history.unshift({
          sha: '987654abcdef',
          subject: request.message,
          author: 'Fixture',
          time: '2026-10-02T01:00:00Z',
        });
        return '987654abcdef';
      }
      if (request.kind === 'stage')
        snapshot.changes.find((c) => c.path === request.path).status = 'A ';
      if (request.kind === 'unstage')
        snapshot.changes.find((c) => c.path === request.path).status = '??';
      if (request.kind === 'branch-create')
        snapshot.branches.push({ name: request.name, current: false });
      if (request.kind === 'worktree-add')
        snapshot.worktrees.push(tree(request.target, request.name));
      if (request.kind === 'stash-save')
        snapshot.stashes.unshift({
          id: 'stash@{0}',
          sha: 'stash-fixture',
          subject: request.message,
        });
      if (request.kind === 'stash-pop') snapshot.stashes.shift();
      if (request.kind === 'init') snapshot.repository = true;
      return '';
    };
    browserResearch.listFiles = async (_project, selected = root) =>
      Object.keys(state.files[selected]).map((path) => ({
        path,
        name: path,
        kind: 'file',
        size: 16,
      }));
    browserResearch.readFile = async (_project, path, selected = root) => ({
      path,
      content: state.files[selected][path],
      version: selected + path,
    });
    browserResearch.writeFile = async (_project, path, content, _version, selected = root) => {
      state.files[selected][path] = content;
      return { path, content, version: selected + path + content.length };
    };
  });
  await page.getByRole('button', { name: '实验', exact: true }).click();
  await page.locator('.cm-editor:visible').waitFor();
  check(
    (await page.locator('.cm-content:visible').innerText()).includes('main'),
    'Initial editor resolves the native directory before opening',
  );
  const activity = await page.locator('.sf-code-activity').boundingBox();
  const editor = await page.locator('.sf-experiment-editor').boundingBox();
  check(activity.x < editor.x, 'IDE tools stay to the left of the editor');
  await page.getByRole('button', { name: '搜索工作区', exact: true }).click();
  await page.getByLabel('搜索工作区内容').fill('main');
  await page.locator('.sf-code-search').getByRole('button', { name: '搜索', exact: true }).click();
  await page
    .locator('.sf-code-search-results')
    .getByRole('button', { name: /train.py/ })
    .click();
  check(
    (await page.locator('.sf-file-footer').innerText()).includes('列 12'),
    'Search result reveals its match in the real CodeMirror editor',
  );
  await page.getByRole('button', { name: '代码', exact: true }).click();
  await page.getByRole('button', { name: '查找文件内容', exact: true }).click();
  await page.locator('.cm-search').getByLabel('查找', { exact: true }).fill('main');
  await page.getByRole('button', { name: '替换文件内容', exact: true }).click();
  await page.locator('.cm-search').getByLabel('替换', { exact: true }).fill('main_updated');
  await page.locator('.cm-search').getByRole('button', { name: '全部替换', exact: true }).click();
  check(
    (await page.locator('.cm-content:visible').innerText()).includes('main_updated'),
    'Editor replacement changes the buffer',
  );
  await page.locator('.cm-search').getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  check(
    !(await page.locator('.cm-content:visible').innerText()).includes('main_updated'),
    'Undo keeps replacement in normal editor history',
  );
  await page.getByRole('button', { name: '重做', exact: true }).click();
  check(
    (await page.locator('.cm-content:visible').innerText()).includes('main_updated'),
    'Redo toolbar restores the edit',
  );
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await page.getByRole('button', { name: '自动换行', exact: true }).click();
  check(
    (await page.locator('.cm-lineWrapping').count()) === 1,
    'Word wrap uses the editor extension',
  );
  await page.getByRole('button', { name: '自动换行', exact: true }).click();
  await page.getByRole('button', { name: '最大化输出面板', exact: true }).click();
  check(
    (await page.locator('.sf-experiment-editor:visible').count()) === 0,
    'Output can maximize without closing the file',
  );
  await page.getByRole('button', { name: '还原输出面板', exact: true }).click();
  await page.getByRole('button', { name: '关闭输出面板', exact: true }).click();
  await page.getByRole('button', { name: '展开运行日志', exact: true }).click();
  check(
    (await page.locator('.sf-experiment-editor:visible').count()) === 1,
    'Editor returns after restoring output',
  );
  await page.screenshot({ path: join(directory, 'IDE-Code-light.png') });
  await page.evaluate(() => {
    window.__gitFixture.files['F:/fixture/main']['windows.py'] = 'one\r\nneedle\r\nthree';
  });
  await page.getByRole('button', { name: '搜索工作区', exact: true }).click();
  await page.getByLabel('搜索工作区内容').fill('needle');
  await page.locator('.sf-code-search').getByRole('button', { name: '搜索', exact: true }).click();
  await page
    .locator('.sf-code-search-results')
    .getByRole('button', { name: /windows.py/ })
    .click();
  check(
    (await page.locator('.sf-file-footer').innerText()).includes('行 2，列 7'),
    'CRLF search offsets agree with editor positions',
  );
  check(
    !(await page.locator('.sf-file-toolbar').innerText()).includes('未保存'),
    'Opening a CRLF match does not edit the buffer',
  );
  await page.getByRole('button', { name: '代码', exact: true }).click();
  await page.getByRole('treeitem', { name: 'train.py', exact: true }).click();
  for (const width of [1440, 1000, 800, 600, 390]) {
    await page.setViewportSize({ width, height: 940 });
    if (
      width <= 600 &&
      (await page.getByRole('tree', { name: '项目文件', exact: true }).isVisible())
    )
      await page.getByRole('button', { name: '收起资源', exact: true }).click();
    const toolbar = await page.locator('.sf-file-toolbar').boundingBox();
    for (const button of await page.locator('.sf-file-toolbar button:visible').all()) {
      const box = await button.boundingBox();
      check(
        box.x >= toolbar.x - 1 &&
          box.x + box.width <= toolbar.x + toolbar.width + 1 &&
          box.y + box.height <= toolbar.y + toolbar.height + 1,
        'Editor control contained at ' + width,
      );
    }
    check(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      'Code has no document overflow at ' + width,
    );
    await page.screenshot({ path: join(directory, `IDE-Code-${width}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 940 });
  if (!(await page.getByRole('tree', { name: '项目文件', exact: true }).isVisible()))
    await page.getByRole('button', { name: '展开资源', exact: true }).click();
  await page.getByRole('button', { name: 'Git', exact: true }).click();
  const git = page.locator('.sf-experiment-git:visible');
  await git.getByRole('button', { name: '查看已暂存 train.py', exact: true }).click();
  await git.getByRole('table', { name: '文件版本差异' }).waitFor();
  check(
    await page.evaluate(() => window.__gitFixture.diffs.at(-1).staged),
    'Index diff is requested separately',
  );
  await git.getByRole('button', { name: '暂存 new.py', exact: true }).click();
  await git.getByRole('button', { name: '查看已暂存 new.py', exact: true }).waitFor();
  check(
    await page.evaluate(() => window.__gitFixture.actions.at(-1).path === 'new.py'),
    'Only the selected file is staged',
  );
  await git.getByLabel('提交说明', { exact: true }).fill('fixture commit');
  await git.getByRole('button', { name: 'Commit', exact: true }).click();
  await git.getByText('Fixture identity missing', { exact: true }).waitFor();
  check(
    (await git.getByLabel('提交说明').inputValue()) === 'fixture commit',
    'Failed commit retains its message',
  );
  await page.getByRole('button', { name: '概览', exact: true }).click();
  await page.getByRole('button', { name: '实验', exact: true }).click();
  check(
    (await git.getByLabel('提交说明').inputValue()) === 'fixture commit',
    'Commit draft survives navigating away and back',
  );
  await git.getByRole('button', { name: 'Commit', exact: true }).click();
  await git.getByRole('status').filter({ hasText: 'Commit 987654abcdef' }).waitFor();
  check(
    (await git.getByLabel('提交说明').inputValue()) === '',
    'Successful commit clears only the submitted draft',
  );
  await git.getByRole('button', { name: '提交历史', exact: true }).click();
  await git.getByRole('button', { name: /fixture commit/ }).click();
  await git.locator('.sf-git-history-patch').waitFor();
  check(
    await page.evaluate(() => window.__gitFixture.diffs.at(-1).commit === '987654abcdef'),
    'History requests the chosen commit diff',
  );
  await git.getByRole('button', { name: '分支', exact: true }).click();
  await git.getByRole('button', { name: '创建分支', exact: true }).click();
  await page.getByRole('dialog').getByLabel('分支名称').fill('feature/verification');
  await page.getByRole('dialog').getByRole('button', { name: '创建', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await git.getByText('feature/verification', { exact: true }).waitFor();
  check(true, 'Branch creation refreshes the actual listing');
  await git.getByRole('button', { name: 'Worktree', exact: true }).click();
  await page.screenshot({ path: join(directory, 'Worktrees-light.png') });
  await git.getByRole('button', { name: '打开', exact: true }).click();
  await page.getByLabel('当前 worktree', { exact: true }).selectOption('F:/fixture/new-loss');
  await page.getByRole('button', { name: '代码', exact: true }).click();
  await page.getByRole('treeitem', { name: 'train.py', exact: true }).click();
  await page.locator('.cm-content:visible').filter({ hasText: 'new-loss' }).waitFor();
  await page.locator('.cm-content:visible').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('# independent draft');
  await page.getByLabel('当前 worktree', { exact: true }).selectOption('F:/fixture/main');
  await page.locator('.cm-content:visible').filter({ hasText: 'print("main")' }).waitFor();
  check(
    !(await page.locator('.cm-content:visible').innerText()).includes('independent draft'),
    'Worktree switch never reuses another directory buffer',
  );
  await page.getByLabel('当前 worktree', { exact: true }).selectOption('F:/fixture/new-loss');
  await page.locator('.cm-content:visible').filter({ hasText: 'independent draft' }).waitFor();
  check(true, 'Worktree draft survives switching back');
  await page.getByRole('button', { name: '保存全部', exact: true }).click();
  await page.getByLabel('当前 worktree', { exact: true }).selectOption('F:/fixture/main');
  await page.getByRole('button', { name: 'Git', exact: true }).click();
  for (const language of ['zh-CN', 'en']) {
    for (const theme of ['light', 'dark']) {
      await page.evaluate(
        async ({ language, theme }) => {
          const { setPreferences } = await import(
            window.__gitModuleUrl('/src/i18n/preferences.ts')
          );
          setPreferences({ language, theme });
        },
        { language, theme },
      );
      await git
        .getByRole('button', { name: language === 'en' ? 'Changes' : '更改', exact: true })
        .click();
      for (const width of [1440, 1000, 800, 600, 390]) {
        await page.setViewportSize({ width, height: 940 });
        check(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          `${language} ${theme}: no document overflow at ${width}`,
        );
        const controls = await page.locator('.sf-experiment-actions > *').evaluateAll((elements) =>
          elements.map((element) => {
            const { x, y, width, height } = element.getBoundingClientRect();
            return { x, y, width, height };
          }),
        );
        check(
          controls.every((box) => box.x >= 0 && box.x + box.width <= width + 1),
          `${language} ${theme}: run controls contained at ${width}`,
        );
        check(
          controls.every((a, i) =>
            controls
              .slice(i + 1)
              .every(
                (b) =>
                  Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) <= 1 ||
                  Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) <= 1,
              ),
          ),
          `${language} ${theme}: run controls do not overlap at ${width}`,
        );
        for (const button of await git.locator('.sf-git-toolbar button').all()) {
          const box = await button.boundingBox();
          check(
            box && box.x >= 0 && box.x + box.width <= width + 1,
            `${language} ${theme}: Git action inside viewport at ${width}`,
          );
        }
        await page.screenshot({ path: join(directory, `Git-${language}-${theme}-${width}.png`) });
      }
    }
  }
  check(errors.length === 0, 'No browser runtime errors: ' + errors.join('; '));
  await writeFile(
    join(directory, 'report.json'),
    JSON.stringify({ date: '2026-10-02', fixtureOnly: true, checks, errors }, null, 2),
  );
  console.log(`Git UI fixture checks passed: ${checks.length}`);
} catch (error) {
  await page.screenshot({ path: join(directory, 'failure.png') });
  throw error;
} finally {
  await browser.close();
}
