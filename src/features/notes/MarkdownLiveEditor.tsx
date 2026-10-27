import { useEffect, useRef, useState } from 'react';
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  undo,
  redo,
} from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { Compartment, EditorState, Transaction } from '@codemirror/state';
import { EditorView, keymap, drawSelection } from '@codemirror/view';
import { search, searchKeymap, openSearchPanel } from '@codemirror/search';
import { Bold, Italic, ImagePlus, ListTree, Search, Code, Undo2, Redo2 } from 'lucide-react';
import { Button, Dropdown } from '../../components/primitives';
import { t, translateError } from '../../i18n';
import type { NoteImages } from '../../platform/note-images';
import type { Heading } from './markdown-document';
import { bindingFor, shortcutToCodeMirror, type ShortcutSettings } from '../../platform/shortcuts';
import { livePreview, previewFocus, previewSource } from './live-preview';
import { errorMessage } from '../../domain/errors';
import './markdown-editor.css';

interface Props {
  value: string;
  onChange(value: string): void;
  onSave?: () => void;
  onPage?: (page: number) => void;
  onLink?: (url: string) => Promise<void> | void;
  images?: NoteImages;
  onPendingChange?: (pending: boolean) => void;
  disabled?: boolean;
  ariaLabel: string;
  className?: string;
  shortcuts?: ShortcutSettings;
}

export function MarkdownLiveEditor({
  value,
  onChange,
  onSave,
  onPage,
  onLink,
  images,
  onPendingChange,
  disabled = false,
  ariaLabel,
  className,
  shortcuts,
}: Props) {
  const useFallback =
    typeof ResizeObserver === 'undefined' || typeof Range.prototype.getClientRects !== 'function';
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const callbacks = useRef({ onChange, onSave, onPage, onLink, onPendingChange });
  callbacks.current = { onChange, onSave, onPage, onLink, onPendingChange };
  const editable = useRef(new Compartment());
  const keymapCompartment = useRef(new Compartment());
  const [headings, setHeadings] = useState<Heading[]>([]);
  const [outline, setOutline] = useState(false);
  const [source, setSource] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(0);
  const uploads = useRef(new Set<{ from: number; to: number }>());
  const synchronizing = useRef(false);

  function wrap(before: string, after = '', fallback = '') {
    const view = viewRef.current;
    if (!view || view.state.readOnly) return;
    const { from, to } = view.state.selection.main;
    const text = view.state.sliceDoc(from, to) || fallback;
    view.dispatch({
      changes: { from, to, insert: before + text + after },
      selection: { anchor: from + before.length, head: from + before.length + text.length },
      userEvent: 'input',
    });
    view.focus();
  }
  function reveal(from: number) {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      selection: { anchor: from },
      effects: [previewFocus.of(true), EditorView.scrollIntoView(from, { y: 'start' })],
    });
    view.focus();
    setOutline(false);
  }
  async function insertImages(files: File[], position?: number) {
    const view = viewRef.current;
    if (!view || view.state.readOnly || !images || !files.length) return;
    const selection = view.state.selection.main;
    const marker = { from: position ?? selection.from, to: position ?? selection.to };
    uploads.current.add(marker);
    setPending(uploads.current.size);
    callbacks.current.onPendingChange?.(true);
    setError('');
    try {
      const paths = await Promise.all(files.map((file) => images.save(file)));
      if (viewRef.current !== view) return;
      const markdown = paths
        .map(
          (path, index) =>
            `![${files[index].name.replace(/[\[\]\\\n\r]/g, '_')}](${encodeURI(path).replace(/\(/g, '%28').replace(/\)/g, '%29')})`,
        )
        .join('\n\n');
      view.dispatch({
        changes: { from: marker.from, to: marker.to, insert: `\n\n${markdown}\n\n` },
        userEvent: 'input',
      });
    } catch (reason) {
      if (viewRef.current === view) setError(errorMessage(reason));
    } finally {
      uploads.current.delete(marker);
      if (viewRef.current === view) setPending(uploads.current.size);
      callbacks.current.onPendingChange?.(uploads.current.size > 0);
    }
  }
  const insertRef = useRef(insertImages);
  insertRef.current = insertImages;

  function editorKeymap() {
    const custom: { key: string; run: () => boolean }[] = [];
    const binding = (
      command: Parameters<typeof bindingFor>[1],
      fallback: string,
      run: () => boolean,
    ) => {
      const current = bindingFor(shortcuts, command);
      const keys = shortcutToCodeMirror(
        current?.enabled === false ? '' : (current?.keys ?? fallback),
      );
      if (keys) custom.push({ key: keys, run });
    };
    binding('editor.save', 'Mod+S', () => {
      callbacks.current.onSave?.();
      return true;
    });
    binding('editor.bold', 'Mod+B', () => {
      wrap('**', '**', t('文字'));
      return true;
    });
    binding('editor.italic', 'Mod+I', () => {
      wrap('*', '*', t('文字'));
      return true;
    });
    binding('editor.find', 'Mod+F', () => {
      const view = viewRef.current;
      if (view) openSearchPanel(view);
      return true;
    });
    return [...custom, ...searchKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab];
  }

  useEffect(() => {
    if (useFallback || !host.current) return;
    const preview = livePreview(images, (url) => {
      if (/^scientify-page:\d+$/.test(url)) callbacks.current.onPage?.(Number(url.split(':')[1]));
      else if (/^https?:\/\//i.test(url))
        void Promise.resolve(callbacks.current.onLink?.(url)).catch((reason) =>
          setError(String(reason)),
        );
      else if (url.startsWith('#')) {
        const heading = viewRef.current?.state
          .field(preview)
          .document.headings.find(
            (h) => encodeURIComponent(h.title.toLowerCase().replace(/\s+/g, '-')) === url.slice(1),
          );
        if (heading) reveal(heading.from);
      }
    });
    const view = new EditorView({
      state: EditorState.create({
        doc: value,
        extensions: [
          markdown({ base: markdownLanguage }),
          history(),
          drawSelection(),
          search({ top: true }),
          syntaxHighlighting(defaultHighlightStyle),
          preview,
          EditorView.lineWrapping,
          editable.current.of([
            EditorView.editable.of(!disabled),
            EditorState.readOnly.of(disabled),
          ]),
          EditorView.contentAttributes.of({
            role: 'textbox',
            'aria-label': ariaLabel,
            'aria-multiline': 'true',
            spellcheck: 'false',
          }),
          EditorView.domEventHandlers({
            focus: () => {
              queueMicrotask(() => {
                if (viewRef.current === view) view.dispatch({ effects: previewFocus.of(true) });
              });
            },
            blur: () => {
              queueMicrotask(() => {
                if (viewRef.current === view) view.dispatch({ effects: previewFocus.of(false) });
              });
            },
            paste: (event) => {
              const files = [...(event.clipboardData?.files ?? [])].filter((file) =>
                file.type.startsWith('image/'),
              );
              if (!files.length || !images || view.state.readOnly) return false;
              event.preventDefault();
              void insertRef.current(files);
              return true;
            },
            drop: (event) => {
              const files = [...(event.dataTransfer?.files ?? [])].filter((file) =>
                file.type.startsWith('image/'),
              );
              if (!files.length || !images || view.state.readOnly) return false;
              event.preventDefault();
              void insertRef.current(
                files,
                view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? undefined,
              );
              return true;
            },
          }),
          keymapCompartment.current.of(keymap.of(editorKeymap())),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            for (const marker of uploads.current) {
              marker.from = update.changes.mapPos(marker.from, 1);
              marker.to = Math.max(marker.from, update.changes.mapPos(marker.to, 1));
            }
            const content = update.state.doc.toString();
            (update.view.contentDOM as HTMLDivElement & { value?: string }).value = content;
            setHeadings(update.state.field(preview).document.headings);
            if (!synchronizing.current) callbacks.current.onChange(content);
          }),
        ],
      }),
      parent: host.current,
    });
    viewRef.current = view;
    setHeadings(view.state.field(preview).document.headings);
    (view.contentDOM as HTMLDivElement & { value?: string }).value = value;
    return () => {
      viewRef.current = null;
      view.destroy();
    };
  }, [useFallback, images]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: keymapCompartment.current.reconfigure(keymap.of(editorKeymap())),
    });
  }, [shortcuts]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === value) return;
    synchronizing.current = true;
    try {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
        annotations: Transaction.addToHistory.of(false),
      });
    } finally {
      synchronizing.current = false;
    }
  }, [value]);
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: editable.current.reconfigure([
        EditorView.editable.of(!disabled),
        EditorState.readOnly.of(disabled),
      ]),
    });
  }, [disabled]);
  useEffect(() => {
    viewRef.current?.contentDOM.setAttribute('aria-label', ariaLabel);
  }, [ariaLabel]);

  if (useFallback)
    return (
      <textarea
        className={`sf-markdown-live-fallback ${className ?? ''}`}
        aria-label={ariaLabel}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
            e.preventDefault();
            onSave?.();
          }
        }}
      />
    );
  const samples: Record<string, [string, string, string]> = {
    标题: ['\n## ', '\n', t('标题')],
    列表: ['\n- ', '\n', t('列表项')],
    任务列表: ['\n- [ ] ', '\n', t('待办事项')],
    引用: ['\n> ', '\n', t('引用')],
    链接: ['[', '](https://)', t('链接文字')],
    代码块: ['\n```python\n', '\n```\n', 'print("Hello")'],
    数学公式: ['\n$$\n', '\n$$\n', 'E = mc^2'],
    表格: ['\n| A | B |\n| --- | --- |\n| ', ' |  |\n', t('内容')],
    分割线: ['\n---\n', '', ''],
  };
  return (
    <div className={`sf-markdown-live-editor ${className ?? ''}`}>
      <div
        className="sf-md-toolbar"
        role="toolbar"
        aria-label={t('笔记格式工具')}
        onMouseDown={(e) => {
          if ((e.target as HTMLElement).closest('button')) e.preventDefault();
        }}
      >
        <Button
          variant="ghost"
          iconOnly
          aria-label={t('粗体')}
          disabled={disabled}
          onClick={() => wrap('**', '**', t('文字'))}
        >
          <Bold size={14} />
        </Button>
        <Button
          variant="ghost"
          iconOnly
          aria-label={t('斜体')}
          disabled={disabled}
          onClick={() => wrap('*', '*', t('文字'))}
        >
          <Italic size={14} />
        </Button>
        <Dropdown
          aria-label={t('插入 Markdown')}
          value=""
          disabled={disabled}
          onChange={(e) => {
            if (samples[e.target.value]) wrap(...samples[e.target.value]);
          }}
        >
          <option value="">{t('插入')}</option>
          {Object.keys(samples).map((label) => (
            <option key={label} value={label}>
              {t(label)}
            </option>
          ))}
        </Dropdown>
        <Button
          variant="ghost"
          iconOnly
          aria-label={t('插入图片')}
          disabled={disabled || !images}
          onClick={() => picker.current?.click()}
        >
          <ImagePlus size={14} />
        </Button>
        <Button
          variant="ghost"
          iconOnly
          aria-label={t('撤销')}
          disabled={disabled}
          onClick={() => {
            if (viewRef.current) undo(viewRef.current);
          }}
        >
          <Undo2 size={14} />
        </Button>
        <Button
          variant="ghost"
          iconOnly
          aria-label={t('重做')}
          disabled={disabled}
          onClick={() => {
            if (viewRef.current) redo(viewRef.current);
          }}
        >
          <Redo2 size={14} />
        </Button>
        <Button
          variant="ghost"
          iconOnly
          aria-label={t('查找与替换')}
          onClick={() => {
            if (viewRef.current) openSearchPanel(viewRef.current);
          }}
        >
          <Search size={14} />
        </Button>
        <Button
          variant="ghost"
          iconOnly
          aria-label={t('Markdown 源码')}
          aria-pressed={source}
          onClick={() => {
            setSource(!source);
            viewRef.current?.dispatch({ effects: previewSource.of(!source) });
          }}
        >
          <Code size={14} />
        </Button>
        <input
          ref={picker}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          multiple
          hidden
          onChange={(e) => {
            void insertImages([...(e.target.files ?? [])]);
            e.target.value = '';
          }}
        />
      </div>
      {pending > 0 && (
        <div className="sf-md-notice" role="status">
          {t('正在保存图片…')}
        </div>
      )}
      {error && (
        <div className="sf-md-notice inline-error" role="alert">
          {translateError(error)}
        </div>
      )}
      <div className="sf-md-body">
        <div ref={host} className="sf-md-host" />
        <aside
          className={`sf-note-outline${outline ? ' is-open' : ''}`}
          onMouseEnter={() => setOutline(true)}
          onMouseLeave={() => setOutline(false)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setOutline(false);
          }}
        >
          <Button
            variant="ghost"
            iconOnly
            className="sf-note-outline-trigger"
            aria-label={t('笔记标题目录')}
            aria-expanded={outline}
            onClick={() => setOutline(!outline)}
            onFocus={() => setOutline(true)}
          >
            <ListTree size={16} />
          </Button>
          {outline && (
            <nav className="sf-note-outline-panel" aria-label={t('笔记标题导航')}>
              <strong>{t('标题目录')}</strong>
              {headings.length ? (
                headings.map((heading) => (
                  <button
                    key={heading.from}
                    title={heading.title}
                    style={{ paddingInlineStart: 12 + (heading.level - 1) * 12 }}
                    onClick={() => reveal(heading.from)}
                  >
                    {heading.title || t('未命名标题')}
                  </button>
                ))
              ) : (
                <p>{t('输入 Markdown 标题后将在此显示')}</p>
              )}
            </nav>
          )}
        </aside>
      </div>
    </div>
  );
}
