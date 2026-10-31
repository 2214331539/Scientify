import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { launchUiBrowser } from './ui-test-browser.mjs';

const dir = resolve('.test-artifacts/notes-ui');
await mkdir(dir, { recursive: true });
const file = join(dir, `notes-fixture-${process.pid}.html`);
const browser = await launchUiBrowser();
const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  await writeFile(
    file,
    `<!doctype html><html><body><div id="root" style="height:100vh"><script type="module">
import React from 'react'; import {createRoot} from 'react-dom/client';
import '/src/styles.css'; import '/src/components/layout/layout.css';
import {MarkdownLiveEditor} from '/src/features/notes/MarkdownLiveEditor.tsx';
const source='# Results\\n\\n## Formula\\n\\n$$\\nE = mc^2\\n$$\\n\\n| A | B |\\n| --- | --- |\\n| 1 | 2 |\\n\\n- [ ] Check';
const images={save:async()=> 'images/figure.png',read:async()=> 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII='};
window.changes=[]; createRoot(document.getElementById('root')).render(React.createElement(MarkdownLiveEditor,{value:source,images,ariaLabel:'笔记正文',onChange:v=>window.changes.push(v),onSave:()=>{}}));
</script></div></body></html>`,
  );
  await page.goto(
    `${process.env.SCIENTIFY_UI_URL}/.test-artifacts/notes-ui/${file.slice(dir.length + 1).replaceAll('\\\\', '/')}`,
    { waitUntil: 'commit' },
  );
  await page.locator('.sf-md-rendered').first().waitFor();
  assert.equal(await page.locator('.sf-md-rendered h1').textContent(), 'Results');
  assert.equal(await page.locator('.sf-md-rendered table').count(), 1);
  assert.ok((await page.locator('.sf-md-rendered .katex').count()) > 0, 'formula rendered');
  await page.getByRole('button', { name: '笔记标题目录' }).hover();
  await page.getByRole('button', { name: 'Results', exact: true }).waitFor();
  await page
    .getByRole('button', { name: '任务列表' })
    .count()
    .catch(() => {});
  assert.deepEqual(errors, []);
  console.log('Notes UI passed: live Markdown blocks, KaTeX, tables and heading outline.');
} finally {
  await browser.close();
  await rm(file, { force: true });
}
