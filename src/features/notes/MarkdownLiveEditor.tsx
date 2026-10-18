import { useEffect, useRef } from 'react';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { Compartment, EditorState, RangeSetBuilder } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  keymap,
  WidgetType,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view';
import { tags } from '@lezer/highlight';
import katex from 'katex';
import './math.css';

interface Props {
  value: string;
  onChange: (value: string) => void;
  onSave?: () => void;
  onPage?: (page: number) => void;
  disabled?: boolean;
  ariaLabel: string;
  className?: string;
}

const proseTheme = EditorView.theme({
  '&': {
    height: '100%',
    minHeight: '0',
    backgroundColor: 'var(--sf-surface-canvas)',
    color: 'var(--sf-text-primary)',
    fontSize: '13px',
  },
  '.cm-scroller': {
    overflow: 'auto',
    fontFamily: 'var(--sf-font-body, system-ui, sans-serif)',
    lineHeight: '1.8',
  },
  '.cm-content': {
    minHeight: '100%',
    padding: '14px 18px 28px',
    caretColor: 'var(--sf-accent)',
  },
  '.cm-line': { padding: '0 0 2px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: 'var(--sf-surface-selected) !important',
  },
  '.cm-cursor': { borderLeftColor: 'var(--sf-accent)' },
});

const proseHighlighting = HighlightStyle.define([
  { tag: tags.heading, color: 'var(--sf-text-primary)', fontWeight: '650' },
  { tag: tags.strong, fontWeight: '650' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.link, color: 'var(--sf-accent)', textDecoration: 'underline' },
  { tag: tags.url, color: 'var(--sf-accent)' },
  { tag: tags.monospace, fontFamily: 'var(--sf-font-mono)' },
  { tag: tags.comment, color: 'var(--sf-text-muted)' },
]);

class FormulaWidget extends WidgetType {
  constructor(
    private readonly expression: string,
    private readonly display: boolean,
  ) {
    super();
  }

  toDOM() {
    const element = document.createElement(this.display ? 'div' : 'span');
    element.className = this.display ? 'sf-md-formula sf-md-formula-display' : 'sf-md-formula';
    try {
      element.innerHTML = katex.renderToString(this.expression, {
        displayMode: this.display,
        throwOnError: false,
        trust: false,
        strict: 'ignore',
        maxExpand: 1000,
        maxSize: 20,
      });
    } catch {
      element.textContent = this.expression;
    }
    return element;
  }

  eq(other: FormulaWidget) {
    return this.expression === other.expression && this.display === other.display;
  }

  ignoreEvent() {
    return false;
  }
}

function buildDecorations(view: EditorView) {
  const activeLine = view.state.doc.lineAt(view.state.selection.main.head).number;
  const ranges = [] as ReturnType<Decoration['range']>[];
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    let line = view.state.doc.lineAt(from);
    while (line.from <= to) {
      const text = line.text;
      const isActive = line.number === activeLine;
      const heading = /^(#{1,6})\s+/.exec(text);
      const list = /^(\s*)([-*+]|\d+[.)])\s+/.exec(text);
      const task = /^(\s*)([-*+])\s+\[([ xX])\]\s+/.exec(text);
      const quote = /^(\s*)>\s?/.exec(text);
      const lineClass = [
        heading ? `sf-md-heading sf-md-heading-${heading[1].length}` : '',
        list ? 'sf-md-list-item' : '',
        task ? `sf-md-task-${task[3].trim() ? 'done' : 'open'}` : '',
        quote ? 'sf-md-blockquote' : '',
      ]
        .filter(Boolean)
        .join(' ');
      if (lineClass) {
        ranges.push(Decoration.line({ attributes: { class: lineClass } }).range(line.from));
      }
      if (heading) {
        if (!isActive) {
          ranges.push(Decoration.replace({}).range(line.from, line.from + heading[0].length));
        }
      }
      if (!isActive && !/^\s*(```|~~~)/.test(text)) {
        const formula = /(\$([^$\n]+)\$|\\\(([^\n]+?)\\\)|\\\[([^\n]+?)\\\])/g;
        let hasFormula = false;
        for (const match of text.matchAll(formula)) {
          const raw = match[0];
          const expression = match[2] ?? match[3] ?? match[4] ?? '';
          if (!expression || ((match.index ?? 0) > 0 && text[(match.index ?? 0) - 1] === '\\'))
            continue;
          hasFormula = true;
          const display = raw.startsWith('\\[');
          ranges.push(
            Decoration.replace({ widget: new FormulaWidget(expression, display) }).range(
              line.from + (match.index ?? 0),
              line.from + (match.index ?? 0) + raw.length,
            ),
          );
        }
        if (list) {
          const prefix = task ? task[0] : list[0];
          ranges.push(Decoration.replace({}).range(line.from, line.from + prefix.length));
        } else if (quote) {
          ranges.push(Decoration.replace({}).range(line.from, line.from + quote[0].length));
        }
        if (!hasFormula) {
          const formats = [
            /(`+)([^`\n]+)\1/g,
            /(\*\*|__)(?=\S)([^\n]*?\S)\1/g,
            /(?<!\w)(\*|_)(?=\S)([^\n]*?\S)\1(?!\w)/g,
            /(\[)([^\]\n]+)(\]\([^\)\n]+\))/g,
          ];
          for (const format of formats) {
            for (const match of text.matchAll(format)) {
              const start = match.index ?? 0;
              const marker = match[1];
              const end = start + match[0].length;
              ranges.push(
                Decoration.replace({}).range(line.from + start, line.from + start + marker.length),
              );
              if (format.source.startsWith('(\\[')) {
                const closing = start + marker.length + match[2].length;
                ranges.push(Decoration.replace({}).range(line.from + closing, line.from + end));
              } else {
                const closing = end - marker.length;
                ranges.push(Decoration.replace({}).range(line.from + closing, line.from + end));
              }
            }
          }
        }
      }
      if (line.to >= to) break;
      line = view.state.doc.line(line.number + 1);
    }
  }
  ranges.sort((a, b) => a.from - b.from);
  for (const range of ranges) builder.add(range.from, range.to, range.value);
  return builder.finish();
}

class LivePreviewPlugin {
  decorations;

  constructor(view: EditorView) {
    this.decorations = buildDecorations(view);
  }

  update(update: ViewUpdate) {
    if (update.docChanged || update.selectionSet || update.viewportChanged)
      this.decorations = buildDecorations(update.view);
  }
}

const livePreview = ViewPlugin.fromClass(LivePreviewPlugin, {
  decorations: (value) => value.decorations,
});

export function MarkdownLiveEditor({
  value,
  onChange,
  onSave,
  onPage,
  disabled = false,
  ariaLabel,
  className,
}: Props) {
  const useFallback =
    typeof window === 'undefined' ||
    typeof ResizeObserver === 'undefined' ||
    typeof Range === 'undefined' ||
    typeof Range.prototype.getClientRects !== 'function';
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const callbacks = useRef({ onChange, onSave, onPage });
  callbacks.current = { onChange, onSave, onPage };
  const editable = useRef(new Compartment());
  const synchronizing = useRef(false);

  useEffect(() => {
    if (useFallback) return;
    if (!host.current) return;
    const extensions = [
      markdown(),
      history(),
      syntaxHighlighting(proseHighlighting),
      proseTheme,
      livePreview,
      EditorView.lineWrapping,
      editable.current.of(EditorView.editable.of(!disabled)),
      EditorView.contentAttributes.of({
        role: 'textbox',
        'aria-label': ariaLabel,
        spellcheck: 'false',
      }),
      EditorView.domEventHandlers({
        click: (event, view) => {
          const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
          if (position === null) return false;
          const line = view.state.doc.lineAt(position);
          const link = /\[[^\]]+\]\(scientify-page:(\d+)\)/g;
          for (const match of line.text.matchAll(link)) {
            const from = line.from + (match.index ?? 0);
            if (position >= from && position <= from + match[0].length) {
              callbacks.current.onPage?.(Number(match[1]));
              return true;
            }
          }
          return false;
        },
      }),
      keymap.of([
        {
          key: 'Mod-s',
          run: () => {
            callbacks.current.onSave?.();
            return true;
          },
        },
        ...defaultKeymap,
        ...historyKeymap,
        indentWithTab,
      ]),
      EditorView.updateListener.of((update) => {
        const content = update.state.doc.toString();
        (update.view.contentDOM as HTMLDivElement & { value?: string }).value = content;
        if (update.docChanged && !synchronizing.current) callbacks.current.onChange(content);
      }),
    ];
    const view = new EditorView({
      state: EditorState.create({ doc: value, extensions }),
      parent: host.current,
    });
    viewRef.current = view;
    (view.contentDOM as HTMLDivElement & { value?: string }).value = value;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [ariaLabel, useFallback]);

  useEffect(() => {
    if (useFallback) return;
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === value) return;
    synchronizing.current = true;
    try {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
    } finally {
      synchronizing.current = false;
    }
    (view.contentDOM as HTMLDivElement & { value?: string }).value = value;
  }, [useFallback, value]);

  useEffect(() => {
    if (useFallback) return;
    viewRef.current?.dispatch({
      effects: editable.current.reconfigure(EditorView.editable.of(!disabled)),
    });
  }, [disabled, useFallback]);

  if (useFallback)
    return (
      <textarea
        className={`sf-markdown-live-fallback ${className ?? ''}`}
        aria-label={ariaLabel}
        value={value}
        disabled={disabled}
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
            event.preventDefault();
            onSave?.();
          }
        }}
      />
    );

  return <div ref={host} className={`sf-markdown-live-editor ${className ?? ''}`} />;
}
