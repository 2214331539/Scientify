/** The "/" menu that inserts any block, and "@" / "[[" for members and pages. */
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Extension, type Editor, type Range } from '@tiptap/core';
import { ReactRenderer } from '@tiptap/react';
import Suggestion, { type SuggestionOptions, type SuggestionProps } from '@tiptap/suggestion';
import {
  BookOpen,
  ChevronRight,
  Code,
  FileText,
  FilePlus2,
  Heading1,
  Heading2,
  Heading3,
  ImageIcon,
  Lightbulb,
  Link2,
  List,
  ListChecks,
  ListOrdered,
  Minus,
  NotebookPen,
  Paperclip,
  Quote,
  Sigma,
  Table,
  Type,
} from 'lucide-react';
import { t } from '../../../i18n';
import { requestText } from '../../../components/prompts';
import type { DocEnv } from './env';

export type MenuEntry = {
  id: string;
  label: string;
  group?: string;
  hint?: string;
  icon?: ReactNode;
};
type ListProps = { items: MenuEntry[]; command(item: MenuEntry): void; empty: string };
type ListHandle = { onKeyDown(event: KeyboardEvent): boolean };

export const SuggestionList = forwardRef<ListHandle, ListProps>(function SuggestionList(
  { items, command, empty },
  ref,
) {
  const [index, setIndex] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => setIndex(0), [items]);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [index]);
  useImperativeHandle(ref, () => ({
    onKeyDown(event) {
      if (!items.length) return false;
      if (event.key === 'ArrowDown') setIndex((index + 1) % items.length);
      else if (event.key === 'ArrowUp') setIndex((index - 1 + items.length) % items.length);
      else if (event.key === 'Enter' || event.key === 'Tab') command(items[index]);
      else return false;
      return true;
    },
  }));
  return (
    <div className="doc-suggest" role="listbox" ref={list}>
      {items.length ? null : <div className="doc-suggest-empty">{empty}</div>}
      {items.map((item, i) => (
        <div key={item.id} role="presentation">
          {item.group && item.group !== items[i - 1]?.group ? (
            <div className="doc-suggest-group">{item.group}</div>
          ) : null}
          <button
            type="button"
            role="option"
            aria-selected={i === index}
            onMouseEnter={() => setIndex(i)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => command(item)}
          >
            {item.icon}
            <span>{item.label}</span>
            {item.hint ? <kbd>{item.hint}</kbd> : null}
          </button>
        </div>
      ))}
    </div>
  );
});

/** Shows a suggestion list at the cursor. */
function popup(empty: string): NonNullable<SuggestionOptions<MenuEntry>['render']> {
  return () => {
    let component: ReactRenderer<ListHandle, ListProps> | null = null;
    let unmount: (() => void) | null = null;
    const props = (p: SuggestionProps<MenuEntry>): ListProps => ({
      items: p.items,
      command: p.command,
      empty,
    });
    return {
      onStart: (p) => {
        component = new ReactRenderer(SuggestionList, { props: props(p), editor: p.editor });
        unmount = p.mount(component.element);
      },
      onUpdate: (p) => component?.updateProps(props(p)),
      onKeyDown: ({ event }) =>
        event.key === 'Escape' ? false : (component?.ref?.onKeyDown(event) ?? false),
      onExit: () => {
        unmount?.();
        component?.destroy();
        component = null;
      },
    };
  };
}

// ---------- "/" ----------
type Slash = MenuEntry & {
  keys: string;
  run(editor: Editor, range: Range, env: DocEnv): void | Promise<void>;
};
const icon = (Icon: typeof Type) => <Icon size={15} />;
const start = (editor: Editor, range: Range) => editor.chain().focus().deleteRange(range);

function insertPicked(kind: 'paper' | 'paperNote' | 'file') {
  return async (editor: Editor, range: Range, env: DocEnv) => {
    start(editor, range).run();
    const picked = await env.pick(kind);
    if (!picked) return;
    const type = kind === 'paper' ? 'paperBlock' : kind === 'paperNote' ? 'paperNote' : 'fileBlock';
    editor
      .chain()
      .focus()
      .insertContent({ type, attrs: { path: picked.path, title: picked.title } })
      .run();
  };
}
/** Attaches files chosen with the system dialog, as cards. */
async function attachFiles(editor: Editor, range: Range, env: DocEnv) {
  start(editor, range).run();
  const attached = await env.pickAttachments();
  const nodes = attached.map((item) => ({
    type: 'attachmentBlock',
    attrs: { asset: item.asset, name: item.name, size: String(item.size) },
  }));
  if (nodes.length) editor.chain().focus().insertContent(nodes).run();
}
function chooseImage(editor: Editor, range: Range, env: DocEnv) {
  start(editor, range).run();
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/png,image/jpeg,image/webp,image/gif';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    const asset = await env.saveImage(file);
    editor
      .chain()
      .focus()
      .insertContent({ type: 'docImage', attrs: { asset, width: 1 } })
      .run();
  };
  input.click();
}

export const SLASH: Slash[] = [
  {
    id: 'paper',
    group: '研究',
    label: '论文',
    keys: 'lw paper lunwen',
    icon: icon(BookOpen),
    run: insertPicked('paper'),
  },
  {
    id: 'paperNote',
    group: '研究',
    label: '论文笔记',
    keys: 'lwbj note biji',
    icon: icon(NotebookPen),
    run: insertPicked('paperNote'),
  },
  {
    id: 'attachment',
    group: '研究',
    label: '文件',
    keys: 'wj fj fujian file attachment upload',
    icon: icon(Paperclip),
    run: attachFiles,
  },
  {
    id: 'file',
    group: '研究',
    label: '项目文件',
    keys: 'xmwj wj file wenjian',
    icon: icon(FileText),
    run: insertPicked('file'),
  },
  {
    id: 'text',
    group: '基础',
    label: '正文',
    keys: 'zw text paragraph',
    icon: icon(Type),
    run: (e, r) => void start(e, r).setParagraph().run(),
  },
  {
    id: 'h1',
    group: '基础',
    label: '标题 1',
    hint: '#',
    keys: 'bt1 h1 heading',
    icon: icon(Heading1),
    run: (e, r) => void start(e, r).setHeading({ level: 1 }).run(),
  },
  {
    id: 'h2',
    group: '基础',
    label: '标题 2',
    hint: '##',
    keys: 'bt2 h2 heading',
    icon: icon(Heading2),
    run: (e, r) => void start(e, r).setHeading({ level: 2 }).run(),
  },
  {
    id: 'h3',
    group: '基础',
    label: '标题 3',
    hint: '###',
    keys: 'bt3 h3 heading',
    icon: icon(Heading3),
    run: (e, r) => void start(e, r).setHeading({ level: 3 }).run(),
  },
  {
    id: 'bullet',
    group: '基础',
    label: '无序列表',
    hint: '-',
    keys: 'wxlb lb bullet list',
    icon: icon(List),
    run: (e, r) => void start(e, r).toggleBulletList().run(),
  },
  {
    id: 'numbered',
    group: '基础',
    label: '有序列表',
    hint: '1.',
    keys: 'yxlb lb number list',
    icon: icon(ListOrdered),
    run: (e, r) => void start(e, r).toggleOrderedList().run(),
  },
  {
    id: 'todo',
    group: '基础',
    label: '待办',
    hint: '[]',
    keys: 'db todo task',
    icon: icon(ListChecks),
    run: (e, r) => void start(e, r).toggleTaskList().run(),
  },
  {
    id: 'quote',
    group: '基础',
    label: '引用',
    hint: '>',
    keys: 'yy quote',
    icon: icon(Quote),
    run: (e, r) => void start(e, r).toggleBlockquote().run(),
  },
  {
    id: 'callout',
    group: '基础',
    label: '高亮块',
    keys: 'glk gl callout',
    icon: icon(Lightbulb),
    run: (e, r) => void start(e, r).setNode('callout').run(),
  },
  {
    id: 'divider',
    group: '基础',
    label: '分割线',
    hint: '---',
    keys: 'fgx divider line',
    icon: icon(Minus),
    run: (e, r) => void start(e, r).setHorizontalRule().run(),
  },
  {
    id: 'toggle',
    group: '更多',
    label: '折叠块',
    keys: 'zdk zd toggle details',
    icon: icon(ChevronRight),
    run: (e, r) => void start(e, r).setDetails().run(),
  },
  {
    id: 'table',
    group: '更多',
    label: '表格',
    keys: 'bg table biaoge',
    icon: icon(Table),
    run: (e, r) => void start(e, r).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
  },
  {
    id: 'code',
    group: '更多',
    label: '代码块',
    hint: '```',
    keys: 'dmk dm code',
    icon: icon(Code),
    run: (e, r) => void start(e, r).setCodeBlock().run(),
  },
  {
    id: 'math',
    group: '更多',
    label: '公式',
    hint: '$$',
    keys: 'gs math formula gongshi',
    icon: icon(Sigma),
    run: async (e, r) => {
      start(e, r).run();
      const latex = await requestText(t('输入 LaTeX 公式'), '');
      if (latex?.trim()) e.chain().focus().insertBlockMath({ latex: latex.trim() }).run();
    },
  },
  {
    id: 'image',
    group: '更多',
    label: '图片',
    keys: 'tp image tupian',
    icon: icon(ImageIcon),
    run: chooseImage,
  },
  {
    id: 'link',
    group: '更多',
    label: '链接到页面',
    hint: '[[',
    keys: 'ljdym lj link page',
    icon: icon(Link2),
    run: (e, r) => void start(e, r).insertContent('[[').run(),
  },
  {
    id: 'subpage',
    group: '更多',
    label: '子页面',
    keys: 'zym subpage page',
    icon: icon(FilePlus2),
    run: async (e, r, env) => {
      start(e, r).run();
      const page = await env.createSubpage();
      if (page)
        e.chain()
          .focus()
          .insertContent({ type: 'mention', attrs: { id: `page:${page.id}`, label: page.title } })
          .run();
    },
  },
];

export function slashItems(query: string) {
  const q = query.trim().toLowerCase();
  return SLASH.filter(
    (item) =>
      !q ||
      t(item.label).toLowerCase().includes(q) ||
      item.label.includes(q) ||
      item.keys.split(' ').some((key) => key.startsWith(q)),
  ).map((item) => ({ ...item, label: t(item.label), group: t(item.group!) }));
}

export function slashCommand(env: () => DocEnv) {
  return Extension.create({
    name: 'slashCommand',
    addProseMirrorPlugins() {
      return [
        Suggestion<Slash, Slash>({
          editor: this.editor,
          char: '/',
          items: ({ query }) => slashItems(query),
          command: ({ editor, range, props }) => void props.run(editor, range, env()),
          render: popup(t('没有匹配的块')) as SuggestionOptions<Slash, Slash>['render'],
        }),
      ];
    },
  });
}

// ---------- "@" and "[[" ----------
export function mentionSuggestions(env: () => DocEnv) {
  const pages = (query: string): MenuEntry[] =>
    env()
      .pages.filter(
        (page) =>
          !page.deletedAt &&
          page.id !== env().pageId &&
          (page.title || t('无标题')).toLowerCase().includes(query.toLowerCase()),
      )
      .slice(0, 8)
      .map((page) => ({
        id: `page:${page.id}`,
        label: page.title || t('无标题'),
        group: t('页面'),
        icon: <span className="doc-suggest-emoji">{page.icon || '📄'}</span>,
      }));
  return [
    {
      char: '@',
      items: ({ query }: { query: string }) => [
        ...env()
          .members()
          .filter((member) => member.label.includes(query))
          .map((member) => ({ id: `user:${member.id}`, label: member.label, group: t('成员') })),
        ...pages(query),
      ],
      render: popup(t('没有找到成员或页面')),
    },
    {
      char: '[[',
      allowedPrefixes: null,
      items: ({ query }: { query: string }) => pages(query),
      render: popup(t('没有找到页面')),
    },
  ];
}
