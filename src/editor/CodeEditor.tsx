import { useEffect, useRef } from 'react';
import { t } from '../i18n';
import { usePreferences } from '../i18n/preferences';
import { Compartment, EditorState, StateEffect } from '@codemirror/state';
import { openSearchPanel, search, searchKeymap } from '@codemirror/search';
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  undo,
  redo,
} from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { markdown } from '@codemirror/lang-markdown';
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import type { FileSession } from './sessions';

const theme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'var(--sf-surface-canvas)',
    color: 'var(--sf-text-primary)',
    fontSize: '14px',
  },
  '.cm-scroller': {
    fontFamily: 'var(--sf-font-mono, Consolas, monospace)',
    lineHeight: '1.8',
    overflow: 'auto',
  },
  '.cm-content': { padding: '18px 0', caretColor: 'var(--sf-accent)' },
  '.cm-line': { paddingLeft: '12px', paddingRight: '16px' },
  '.cm-gutters': {
    color: 'var(--sf-text-muted)',
    backgroundColor: 'var(--sf-surface-canvas)',
    border: 'none',
    paddingRight: '8px',
  },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--sf-editor-line)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: 'var(--sf-surface-selected) !important',
  },
  '&.cm-focused': { outline: 'none' },
});
const highlighting = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--sf-syntax-keyword)' },
  { tag: [tags.string, tags.regexp], color: 'var(--sf-syntax-string)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--sf-syntax-number)' },
  { tag: [tags.function(tags.variableName), tags.typeName], color: 'var(--sf-syntax-function)' },
  { tag: tags.comment, color: 'var(--sf-syntax-comment)', fontStyle: 'italic' },
  { tag: tags.heading, color: 'var(--sf-accent)', fontWeight: '600' },
  { tag: tags.strong, fontWeight: '600' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: [tags.link, tags.url], color: 'var(--sf-syntax-function)', textDecoration: 'underline' },
]);

export function CodeEditor({
  session,
  onSelection,
  onCursor,
}: {
  session: FileSession;
  onSelection: (text: string) => void;
  onCursor?: (line: number, column: number) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const phrases = useRef(new Compartment());
  const { language: displayLanguage } = usePreferences();
  const selectionCallback = useRef(onSelection);
  selectionCallback.current = onSelection;
  const cursorCallback = useRef(onCursor);
  cursorCallback.current = onCursor;
  useEffect(() => {
    if (!host.current) return;
    const path = session.path.toLowerCase();
    const language = /\.py$/.test(path)
      ? python()
      : /\.[cm]?[jt]sx?$/.test(path)
        ? javascript({ typescript: /\.tsx?$/.test(path), jsx: /\.jsx$|\.tsx$/.test(path) })
        : /\.md(?:own)?$/.test(path)
          ? markdown()
          : [];
    const wrap = new Compartment();
    let synchronizing = false;
    const extensions = [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      drawSelection(),
      history(),
      syntaxHighlighting(highlighting),
      language,
      theme,
      search({ top: true }),
      wrap.of(session.editorWrap ? EditorView.lineWrapping : []),
      phrases.current.of(EditorState.phrases.of(searchPhrases())),
      EditorView.contentAttributes.of({
        'aria-label': t('编辑 {path}', { path: session.path }),
        spellcheck: 'false',
      }),
      keymap.of([
        {
          key: 'Mod-s',
          run: () => {
            void session.save();
            return true;
          },
        },
        {
          key: 'Mod-h',
          run: (view) => {
            openSearchPanel(view);
            view.dom.querySelector<HTMLInputElement>('[name="replace"]')?.focus();
            return true;
          },
        },
        {
          key: 'Alt-z',
          run: () => {
            session.requestEditorCommand({ type: 'toggleWrap' });
            return true;
          },
        },
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        indentWithTab,
      ]),
      EditorView.updateListener.of((update) => {
        session.editorState = update.state;
        if (update.docChanged && !synchronizing) session.edit(update.state.doc.toString());
        if (update.selectionSet || update.docChanged) {
          const { from, to } = update.state.selection.main;
          selectionCallback.current(update.state.sliceDoc(from, Math.min(to, from + 12000)));
          const line = update.state.doc.lineAt(update.state.selection.main.head);
          cursorCallback.current?.(line.number, update.state.selection.main.head - line.from + 1);
        }
      }),
    ];
    let state =
      session.editorState ?? EditorState.create({ doc: session.getSnapshot().content, extensions });
    if (session.editorState)
      state = state.update({ effects: StateEffect.reconfigure.of(extensions) }).state;
    const view = new EditorView({ state, parent: host.current });
    viewRef.current = view;
    const line = view.state.doc.lineAt(view.state.selection.main.head);
    cursorCallback.current?.(line.number, view.state.selection.main.head - line.from + 1);
    selectionCallback.current(
      view.state.sliceDoc(
        view.state.selection.main.from,
        Math.min(view.state.selection.main.to, view.state.selection.main.from + 12000),
      ),
    );
    const synchronize = () => {
      const content = view.state.toText(session.getSnapshot().content);
      if (!content.eq(view.state.doc)) {
        synchronizing = true;
        try {
          view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } });
        } finally {
          synchronizing = false;
        }
      }
      const command = session.takeEditorCommand();
      if (command?.type === 'reveal') {
        const from = Math.max(0, Math.min(command.from, view.state.doc.length));
        const to = Math.max(from, Math.min(command.to, view.state.doc.length));
        view.dispatch({
          selection: { anchor: from, head: to },
          effects: EditorView.scrollIntoView(from, { y: 'center' }),
        });
        view.focus();
      } else if (command?.type === 'toggleWrap') {
        session.editorWrap = !session.editorWrap;
        view.dispatch({
          effects: wrap.reconfigure(session.editorWrap ? EditorView.lineWrapping : []),
        });
      } else if (command?.type === 'undo' || command?.type === 'redo') {
        (command.type === 'undo' ? undo : redo)(view);
        view.focus();
      } else if (command) {
        openSearchPanel(view);
        if (command.type === 'replace')
          view.dom.querySelector<HTMLInputElement>('[name="replace"]')?.focus();
      }
    };
    const rememberScroll = () => {
      if (view.dom.getClientRects().length)
        session.editorScroll = { top: view.scrollDOM.scrollTop, left: view.scrollDOM.scrollLeft };
    };
    const restoration = requestAnimationFrame(() => {
      view.scrollDOM.scrollTop = session.editorScroll.top;
      view.scrollDOM.scrollLeft = session.editorScroll.left;
      synchronize();
    });
    view.scrollDOM.addEventListener('scroll', rememberScroll, { passive: true });
    const unsubscribe = session.subscribe(synchronize);
    return () => {
      cancelAnimationFrame(restoration);
      rememberScroll();
      view.scrollDOM.removeEventListener('scroll', rememberScroll);
      unsubscribe();
      session.editorState = view.state;
      view.destroy();
      viewRef.current = null;
    };
  }, [session]);
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: phrases.current.reconfigure(EditorState.phrases.of(searchPhrases())),
    });
    viewRef.current?.contentDOM.setAttribute(
      'aria-label',
      t('编辑 {path}', { path: session.path }),
    );
  }, [displayLanguage, session.path]);
  return <div ref={host} className="sf-code-editor" />;
}
function searchPhrases() {
  return Object.fromEntries(
    [
      ['Find', '查找'],
      ['Replace', '替换'],
      ['next', '下一个'],
      ['previous', '上一个'],
      ['all', '全部'],
      ['match case', '区分大小写'],
      ['regexp', '正则表达式'],
      ['by word', '全字匹配'],
      ['replace', '替换'],
      ['replace all', '全部替换'],
      ['close', '关闭'],
    ].map(([key, label]) => [key, t(label)]),
  );
}
