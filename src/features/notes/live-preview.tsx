import { renderToStaticMarkup } from 'react-dom/server';
import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import { Markdown } from './Markdown';
import { parseMarkdown, type MarkdownBlock } from './markdown-document';
import type { NoteImages } from '../../platform/note-images';
import { errorMessage } from '../../domain/errors';

export const previewFocus = StateEffect.define<boolean>();
export const previewSource = StateEffect.define<boolean>();

export function livePreview(images?: NoteImages, onLink?: (url: string) => void) {
  const imageCache = new Map<string, Promise<string>>();
  class BlockWidget extends WidgetType {
    constructor(readonly block: MarkdownBlock) {
      super();
    }
    eq(other: BlockWidget) {
      return this.block.source === other.block.source && this.block.from === other.block.from;
    }
    toDOM(view: EditorView) {
      const host = document.createElement('div');
      host.className = 'sf-md-rendered';
      host.innerHTML = renderToStaticMarkup(<Markdown notePreview>{this.block.source}</Markdown>);
      for (const [index, checkbox] of [
        ...host.querySelectorAll<HTMLInputElement>('input[type=checkbox]'),
      ].entries()) {
        const position = this.block.tasks[index];
        if (position === undefined) continue;
        checkbox.disabled = view.state.readOnly;
        checkbox.addEventListener('change', () => {
          view.dispatch({
            changes: { from: position, to: position + 1, insert: checkbox.checked ? 'x' : ' ' },
            userEvent: 'input',
          });
        });
      }
      for (const placeholder of host.querySelectorAll<HTMLElement>('[data-note-image]')) {
        const path = placeholder.dataset.noteImage;
        if (!path || !images) continue;
        let loading = imageCache.get(path);
        if (!loading) {
          loading = images.read(path);
          imageCache.set(path, loading);
        }
        void loading
          .then((url) => {
            if (!/^data:image\/(png|jpeg|webp|gif);base64,/.test(url))
              throw new Error('图片格式无效。');
            const img = document.createElement('img');
            img.alt = placeholder.getAttribute('aria-label') ?? '';
            img.onload = () => view.requestMeasure();
            img.src = url;
            placeholder.replaceChildren(img);
            view.requestMeasure();
          })
          .catch((error) => {
            imageCache.delete(path);
            placeholder.title = errorMessage(error);
            placeholder.classList.add('sf-note-image-error');
          });
      }
      host.addEventListener('mousedown', (event) => {
        const target = event.target as HTMLElement;
        if (target.closest('a,input')) return;
        if (view.state.readOnly) return;
        event.preventDefault();
        // Reveal the original Markdown without serializing rendered HTML back to it.
        view.dispatch({ selection: { anchor: this.block.from }, effects: previewFocus.of(true) });
        view.focus();
      });
      host.addEventListener('click', (event) => {
        const link = (event.target as HTMLElement).closest('a');
        if (!link) return;
        event.preventDefault();
        onLink?.(link.getAttribute('href') ?? '');
      });
      return host;
    }
    ignoreEvent() {
      return true;
    }
  }
  return StateField.define<{
    document: ReturnType<typeof parseMarkdown>;
    decorations: DecorationSet;
    focused: boolean;
    source: boolean;
  }>({
    create(state) {
      const document = parseMarkdown(state.doc.toString());
      return {
        document,
        focused: false,
        source: false,
        decorations: Decoration.set(
          document.blocks.map((block) =>
            Decoration.replace({ widget: new BlockWidget(block), block: true }).range(
              block.from,
              block.to,
            ),
          ),
        ),
      };
    },
    update(value, transaction) {
      const document = transaction.docChanged
        ? parseMarkdown(transaction.newDoc.toString())
        : value.document;
      let focused = value.focused,
        source = value.source;
      for (const effect of transaction.effects) {
        if (effect.is(previewFocus)) focused = effect.value;
        if (effect.is(previewSource)) source = effect.value;
      }
      if (
        !transaction.docChanged &&
        !transaction.selection &&
        focused === value.focused &&
        source === value.source
      )
        return value;
      const selections = transaction.newSelection.ranges;
      const ranges = source
        ? []
        : document.blocks
            .filter(
              (block) =>
                !focused ||
                !selections.some((range) => range.from <= block.to && range.to >= block.from),
            )
            .map((block) =>
              Decoration.replace({ widget: new BlockWidget(block), block: true }).range(
                block.from,
                block.to,
              ),
            );
      return { document, focused, source, decorations: Decoration.set(ranges) };
    },
    provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
  });
}
