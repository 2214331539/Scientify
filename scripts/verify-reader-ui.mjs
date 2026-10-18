import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { launchUiBrowser } from './ui-test-browser.mjs';

// A generated document with text, links, an outline and a rotated second page.
// No user papers, directories or model credentials are read by this fixture.
const stream = 'BT /F1 20 Tf 50 700 Td (PDF rendering fixture) Tj ET';
const objects = [
  '<< /Type /Catalog /Pages 2 0 R /Outlines 8 0 R >>',
  '<< /Type /Pages /Kids [4 0 R 7 0 R] /Count 2 >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R /Annots [6 0 R 10 0 R] >>',
  `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  '<< /Type /Annot /Subtype /Link /Rect [50 680 240 730] /Border [0 0 0] /A << /S /URI /URI (https://example.com) >> >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Rotate 90 /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>',
  '<< /Type /Outlines /First 9 0 R /Last 9 0 R /Count 1 >>',
  '<< /Title (Second page) /Parent 8 0 R /Dest [7 0 R /Fit] >>',
  '<< /Type /Annot /Subtype /Link /Rect [50 600 240 640] /Border [0 0 0] /Dest [7 0 R /Fit] >>',
];
let pdf = '%PDF-1.7\n';
const offsets = [0];
objects.forEach((object, index) => {
  offsets.push(pdf.length);
  pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
});
const xref = pdf.length;
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
pdf += offsets
  .slice(1)
  .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
  .join('');
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;

const directory = resolve('.test-artifacts/reader-ui');
await mkdir(directory, { recursive: true });
const browser = await launchUiBrowser();
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
page.setDefaultTimeout(15_000);
const errors = [];
const checks = [];
const check = (value, label) => {
  assert.ok(value, label);
  checks.push(label);
};
page.on('pageerror', (error) => errors.push(error.message));
const fixtureName = `reader-fixture-${process.pid}.html`;
const fixturePath = join(directory, fixtureName);
try {
  await writeFile(
    fixturePath,
    `<!doctype html><html><body><div id="root" style="width:1000px;height:800px;display:flex"></div><script type="module">
import React from 'react';
import {createRoot} from 'react-dom/client';
import '/src/styles.css';
import '/src/components/layout/layout.css';
const {default:PdfReader}=await import('/src/reader/PdfReader.tsx');
const {AssistantPanel}=await import('/src/features/assistant/AssistantPanel.tsx');
const {emptyWorkspace}=await import('/src/domain/workspace.ts');
const {createWorkspaceStore}=await import('/src/stores/workspace.ts');
const backend={readPdf:async()=>new Uint8Array(${JSON.stringify([...Buffer.from(pdf)])})};
window.externalLinks=[];
window.open=url=>{window.externalLinks.push(url);return null;};
window.fixtureAlerts=[];
const observer=new MutationObserver(()=>{
  for(const alert of document.querySelectorAll('[role=alert]')){
    if(!window.fixtureAlerts.includes(alert.textContent))window.fixtureAlerts.push(alert.textContent);
  }
});
observer.observe(document.getElementById('root'),{subtree:true,childList:true});
const data=emptyWorkspace();
data.settings.model={provider:'ollama',endpoint:'http://127.0.0.1:11434',model:'fixture'};
const store=createWorkspaceStore({load:async()=>({workspace:data,directory:'fixture',legacyAvailable:false}),save:async value=>value});
await store.getState().load();
window.chatRequests=[];
const chatBackend={askAI:async request=>{window.chatRequests.push(request);return 'Fixture answer';}};
createRoot(document.getElementById('root')).render(React.createElement(React.Fragment,null,
  React.createElement('div',{id:'reader',style:{width:355,height:'100%',flexShrink:0}},React.createElement(PdfReader,{assetId:'fixture',title:'PDF Fixture',projectId:'fixture',paperId:'fixture',backend,onContext:()=>{},onTool:()=>{},compact:true})),
  React.createElement('div',{style:{width:340,height:'100%'}},React.createElement(AssistantPanel,{store,backend:chatBackend,scope:'fixture',context:{workspace:'literature',title:'PDF fixture'}}))
));
</script></body></html>`,
  );
  const url = process.env.SCIENTIFY_UI_URL || 'http://127.0.0.1:1420';
  await page.goto(`${url}/.test-artifacts/reader-ui/${fixtureName}`, { waitUntil: 'commit' });
  await page
    .locator('.textLayer')
    .filter({ hasText: 'PDF rendering fixture' })
    .waitFor({ timeout: 60_000 });
  check(
    await page.locator('.pdf-page canvas').evaluate((canvas) => {
      const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      return pixels.some((value, index) => index % 4 !== 3 && value < 200);
    }),
    'PDF canvas contains rendered content',
  );
  await page.getByRole('link', { name: 'https://example.com/' }).click();
  check(
    (await page.evaluate(() => window.externalLinks)).includes('https://example.com/'),
    'Web links open externally',
  );
  await page.getByRole('link', { name: '跳转至文档位置' }).click();
  await page.waitForFunction(
    () => document.querySelector('input[aria-label="页码"]').value === '2',
  );
  await page
    .locator('[data-pdf-page="2"] .textLayer')
    .filter({ hasText: 'PDF rendering fixture' })
    .waitFor();
  check(true, 'Internal links navigate to a rotated page');
  await page.getByRole('button', { name: '上一页', exact: true }).click();
  await page.getByRole('button', { name: '打开标题目录' }).hover();
  await page.getByRole('button', { name: 'Second page', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('input[aria-label="页码"]').value === '2',
  );
  check(true, 'Outline navigates to its PDF destination');
  await page.getByRole('button', { name: '上一页', exact: true }).click();
  for (const width of [280, 355, 480, 820]) {
    await page.locator('#reader').evaluate((node, width) => {
      node.style.width = `${width}px`;
    }, width);
    await page.waitForTimeout(140);
    await page.waitForFunction(() => {
      const host = document.querySelector('.pdf-scroll');
      const canvas = host.querySelector('canvas');
      const style = getComputedStyle(host);
      const available =
        host.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      return Math.abs(parseFloat(canvas.style.width) - available) < 2;
    });
    check(true, `PDF fits the actual content width at ${width}px`);
    const reader = await page.locator('#reader').boundingBox();
    const toolbar = await page.getByLabel('PDF 阅读工具').boundingBox();
    check(
      toolbar.x >= reader.x && toolbar.x + toolbar.width <= reader.x + reader.width + 1,
      `Toolbar stays inside a ${width}px reader`,
    );
    for (const button of await page.getByLabel('PDF 阅读工具').locator('button').all()) {
      const box = await button.boundingBox();
      check(
        box.x >= toolbar.x && box.x + box.width <= toolbar.x + toolbar.width + 1,
        `Toolbar control remains reachable at ${width}px`,
      );
    }
    check(
      await page.locator('.pdf-page-input').evaluate((node) => node.scrollHeight < 40),
      `Page count stays on one line at ${width}px`,
    );
    await page.screenshot({ path: join(directory, `reader-${width}.png`) });
  }
  await page.locator('.pdf-scroll').hover({ position: { x: 160, y: 180 } });
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -100);
  await page.keyboard.up('Control');
  await page.getByText('122%', { exact: true }).waitFor();
  check(true, 'Ctrl + mouse wheel zooms the PDF');
  await page.evaluate(async () => {
    for (let i = 0; i < 60; i++) {
      document.getElementById('reader').style.width = `${280 + (i % 20) * 20}px`;
      if (i % 3 === 0) document.querySelector('.pdf-mode-toggle').click();
      if (i % 4 === 0) document.querySelector('button[aria-label="放大 PDF"]').click();
      await new Promise(requestAnimationFrame);
    }
  });
  await page.waitForTimeout(250);
  check(
    (await page.evaluate(() => window.fixtureAlerts)).length === 0,
    'Rapid resizing, zooming and mode switches produce no render errors',
  );
  const input = page.getByRole('textbox', { name: '向 AI 提问' });
  check(
    (await page.getByRole('button', { name: '添加图片', exact: true }).count()) === 0,
    'Image button removed',
  );
  check(
    (await page.getByRole('button', { name: '查看当前材料', exact: true }).count()) === 0,
    'Attachment button removed',
  );
  await input.evaluate((node) => {
    const data = new DataTransfer();
    data.items.add(
      new File(
        [
          Uint8Array.from(
            atob(
              'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=',
            ),
            (c) => c.charCodeAt(0),
          ),
        ],
        'pasted.png',
        { type: 'image/png' },
      ),
    );
    node.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  });
  await page.getByText('pasted.png', { exact: true }).waitFor();
  check(
    await page
      .locator('.sf-ai-attachment img')
      .evaluate((img) => img.complete && img.naturalWidth > 0),
    'Pasted image has a decoded preview',
  );
  await page.getByRole('button', { name: '移除图片' }).click();
  await input.evaluate((node) => {
    const data = new DataTransfer();
    data.items.add(new File(['fixture-image'], 'dropped.png', { type: 'image/png' }));
    node
      .closest('form')
      .dispatchEvent(
        new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }),
      );
  });
  await page.getByText('dropped.png', { exact: true }).waitFor();
  await input.fill('Describe this image');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.getByText('Fixture answer', { exact: true }).waitFor();
  check(
    await page.evaluate(() =>
      window.chatRequests[0].messages
        .at(-1)
        .content.some((part) => part.type === 'image' && part.mimeType === 'image/png'),
    ),
    'Dropped image reaches the multimodal request',
  );
  await input.evaluate(
    (node, bytes) => {
      const data = new DataTransfer();
      data.items.add(
        new File([new Uint8Array(bytes)], 'attached.pdf', { type: 'application/pdf' }),
      );
      data.items.add(
        new File(['# Read-only note\nattachment-note-fixture'], 'attached.md', {
          type: 'text/markdown',
        }),
      );
      node
        .closest('form')
        .dispatchEvent(
          new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }),
        );
    },
    [...Buffer.from(pdf)],
  );
  await page.getByText('attached.pdf', { exact: true }).waitFor();
  await page.getByText('attached.md', { exact: true }).waitFor();
  await input.fill('Read both attachments');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.waitForFunction(() => window.chatRequests.length === 2);
  check(
    await page.evaluate(() => {
      const parts = window.chatRequests[1].messages.at(-1).content;
      return (
        parts.every((part) => part.type === 'text') &&
        parts[0].text.includes('[p. 1]') &&
        parts[0].text.includes('PDF rendering fixture') &&
        parts[0].text.includes('attachment-note-fixture')
      );
    }),
    'PDF text and page citations plus Markdown reach the request as read-only text',
  );
  const paperChecks = await page.evaluate(async () => {
    const { PaperService } = await import('/src/platform/paper-service.ts');
    // Build a valid long document in memory; never use papers from disk.
    function generatedPdf(marker) {
      const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        `<< /Type /Pages /Kids [${Array.from({ length: 36 }, (_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count 36 >>`,
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      ];
      for (let number = 1; number <= 36; number++) {
        const content = `BT /F1 12 Tf 50 700 Td (${marker} page ${number}${number === 31 ? ' FIND-LATE-TEXT' : ''}) Tj ET`;
        objects.push(
          `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + (number - 1) * 2} 0 R >>`,
          `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
        );
      }
      let pdf = '%PDF-1.7\n';
      const offsets = [];
      objects.forEach((object, i) => {
        offsets.push(pdf.length);
        pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
      });
      const xref = pdf.length;
      pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
      pdf += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
      pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
      return new TextEncoder().encode(pdf).buffer;
    }
    const requests = new Map();
    const callbacks = new Map();
    const service = new PaperService({
      source: async (id) => generatedPdf(requests.get(id).projectId),
      complete: async (id, result, error) => {
        if (error) callbacks.get(id).reject(new Error(error));
        else callbacks.get(id).resolve(result);
      },
    });
    let sequence = 0;
    const base = {
      projectId: 'one',
      root: 'papers-one',
      path: 'same.pdf',
      version: 'v1',
      operation: 'read',
      page: 1,
      offset: 0,
      pageCount: 8,
      query: '',
    };
    function request(overrides) {
      const job = { ...base, ...overrides, id: `paper-${++sequence}` };
      requests.set(job.id, job);
      return new Promise((resolve, reject) => {
        callbacks.set(job.id, { resolve, reject });
        service.enqueue(job);
      });
    }
    let heartbeats = 0;
    const heartbeat = setInterval(() => heartbeats++, 10);
    const passed = [];
    const assert = (condition, message) => {
      if (!condition) throw new Error(message);
      passed.push(message);
    };
    try {
      const [one, two] = await Promise.all([
        request({}),
        request({ projectId: 'two', root: 'papers-two' }),
      ]);
      assert(
        one.pages[0].text.includes('one page 1') && two.pages[0].text.includes('two page 1'),
        'Real PDF workers isolate identical names across roots',
      );
      assert(
        one.pages.length === 8 && one.nextCursor.page === 9,
        'Real parser returns bounded pages and continuation',
      );
      const first = await request({ operation: 'search', query: 'find-late-text', pageCount: 20 });
      assert(
        first.matches.length === 0 && first.nextCursor.page > 1 && first.nextCursor.page <= 21,
        'Partial search reports actual continuation',
      );
      let next = first;
      while (next.nextCursor) {
        next = await request({
          operation: 'search',
          query: 'find-late-text',
          pageCount: 20,
          ...next.nextCursor,
        });
        if (next.matches.length) break;
      }
      assert(
        next.matches[0]?.page === 31,
        'Real parser finds a marker beyond the attachment page limit',
      );
      const last = await request({ page: 31, pageCount: 1 });
      assert(
        last.pages[0].text.includes('FIND-LATE-TEXT'),
        'Unopened late pages are readable without reader DOM',
      );
      assert(heartbeats > 0, 'Browser event loop remains responsive during worker extraction');
      return passed;
    } finally {
      clearInterval(heartbeat);
      service.dispose();
    }
  });
  for (const label of paperChecks) check(true, label);
  check(errors.length === 0, `No browser runtime errors: ${errors.join('; ')}`);
  await writeFile(
    join(directory, 'report.json'),
    JSON.stringify({ date: new Date().toISOString(), fixtureOnly: true, checks, errors }, null, 2),
  );
  console.log(`Reader and composer UI checks passed: ${checks.length}`);
} catch (error) {
  await writeFile(
    join(directory, 'failure.json'),
    JSON.stringify({ error: String(error), errors }, null, 2),
  );
  await page.screenshot({ path: join(directory, 'failure.png') });
  throw error;
} finally {
  await browser.close();
  await rm(fixturePath, { force: true });
}
