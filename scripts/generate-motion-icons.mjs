import { writeFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as lucide from 'lucide-react';

const names = [
  'BookOpen',
  'Code2',
  'NotebookPen',
  'PenLine',
  'UsersRound',
  'Bot',
  'ChevronDown',
  'ChevronRight',
  'Check',
  'Plus',
  'X',
  'ArrowUp',
  'Square',
  'Play',
  'RotateCcw',
  'Sun',
  'Moon',
  'Settings2',
  'Search',
  'FileText',
  'Folder',
  'Terminal',
  'GitBranch',
  'Copy',
  'MoreHorizontal',
  'PanelRightClose',
  'Construction',
  'ArrowRight',
  'Paperclip',
  'Save',
];
const icons = Object.fromEntries(
  names.map((name) => [
    name,
    renderToStaticMarkup(createElement(lucide[name], { size: 18, 'aria-hidden': true })),
  ]),
);
await writeFile(
  new URL('../docs/UI-UX/示例/lucide-icons.js', import.meta.url),
  `/* Generated from lucide-react by scripts/generate-motion-icons.mjs. */\nwindow.scientifyIcons = ${JSON.stringify(icons)};\n`,
);
