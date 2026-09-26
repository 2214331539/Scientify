import { useEffect, useRef } from 'react';
import { t } from '../i18n';
import { usePreferences } from '../i18n/preferences';
import { EditorState, StateEffect } from '@codemirror/state';
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
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
}: {
  session: FileSession;
  onSelection: (text: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const { language: displayLanguage } = usePreferences();
  const selectionCallback = useRef(onSelection);
  selectionCallback.current = onSelection;
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
    const extensions = [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      drawSelection(),
      history(),
      syntaxHighlighting(highlighting),
      language,
      theme,
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
        ...defaultKeymap,
        ...historyKeymap,
        indentWithTab,
      ]),
      EditorView.updateListener.of((update) => {
        session.editorState = update.state;
        if (update.docChanged) session.edit(update.state.doc.toString());
        if (update.selectionSet || update.docChanged) {
          const { from, to } = update.state.selection.main;
          selectionCallback.current(update.state.sliceDoc(from, Math.min(to, from + 12000)));
        }
      }),
    ];
    let state =
      session.editorState ?? EditorState.create({ doc: session.getSnapshot().content, extensions });
    if (session.editorState)
      state = state.update({ effects: StateEffect.reconfigure.of(extensions) }).state;
    const view = new EditorView({ state, parent: host.current });
    viewRef.current = view;
    const unsubscribe = session.subscribe(() => {
      const content = session.getSnapshot().content;
      if (content !== view.state.doc.toString()) {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } });
      }
    });
    return () => {
      unsubscribe();
      session.editorState = view.state;
      view.destroy();
      viewRef.current = null;
    };
  }, [session]);
  useEffect(() => {
    viewRef.current?.contentDOM.setAttribute(
      'aria-label',
      t('编辑 {path}', { path: session.path }),
    );
  }, [displayLanguage, session.path]);
  return <div ref={host} className="sf-code-editor" />;
}
