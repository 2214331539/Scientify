import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as lucide from 'lucide-react';

const require = createRequire(import.meta.url);
const viteRequire = createRequire(require.resolve('vite'));
const { build } = viteRequire('esbuild');
const names = ['Orbit','ChevronDown','Search','Sun','House','BookOpen','NotebookPen','FlaskConical','PenLine','Settings2','PanelLeft','SlidersHorizontal','Save','Play','MessagesSquare','ListTodo','GitBranch','X','ArrowUp','Box','Check','CircleCheck','FolderOpen','RefreshCw','Circle','ChevronsDownUp','Folder','FileCode2','FileCog','FileText','Layers3','LoaderCircle','CircleStop','FileDiff','PanelBottom','ChevronsUpDown','Square','ArrowUpRight','FileJson','Table2','Columns3','Plus','RotateCcw','ArrowLeft','GitCommitHorizontal','Pencil','File'];
const icons = Object.fromEntries(names.map((name) => {
  if (!lucide[name]) throw new Error('Missing Lucide icon: ' + name);
  return [name, renderToStaticMarkup(createElement(lucide[name], { size: 16, strokeWidth: 1.65, 'aria-hidden': true }))];
}));
const result = await build({
  entryPoints: [fileURLToPath(new URL('./实验代码工作区.source.js', import.meta.url))],
  bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2022',
  minify: true, legalComments: 'inline', define: { __ICONS__: JSON.stringify(icons) },
});
const template = await readFile(new URL('./实验代码工作区.template.html', import.meta.url), 'utf8');
const script = result.outputFiles[0].text.replace(/<\/script/gi, () => '<' + String.fromCharCode(92) + '/script');
const html = template.replace('/*__PROTOTYPE_SCRIPT__*/', () => script);
const output = new URL('../实验代码页面示例.html', import.meta.url);
await writeFile(output, html, 'utf8');
console.log(fileURLToPath(output));
console.log('Standalone HTML: ' + Math.round(Buffer.byteLength(html) / 1024) + ' KiB');
