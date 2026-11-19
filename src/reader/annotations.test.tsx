import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import type { PageViewport } from 'pdfjs-dist';
import type { PaperAnnotation } from '../platform/library';
import { annotationAt, mergeLines, readingOrder, toBox, toPdfRects } from './annotations';
import { AnnotationList, AnnotationPopover, SelectionToolbar } from './ReaderAnnotations';

afterEach(cleanup);

/** A US-letter page at scale 1: y grows down on screen and up in PDF points. */
const unit = {
  width: 612,
  height: 792,
  convertToPdfPoint: (x: number, y: number) => [x, 792 - y],
  convertToViewportPoint: (x: number, y: number) => [x, 792 - y],
} as unknown as PageViewport;

const highlight = (id: string, page: number, rect: [number, number, number, number]) =>
  ({
    id,
    kind: 'highlight',
    page,
    rects: [rect],
    text: id,
    comment: '',
    color: '#ffd400',
  }) satisfies PaperAnnotation;

it('turns a selection into one PDF rectangle per line and back onto the page', () => {
  // Two spans on the first line and one on the second, the page shown at twice its size.
  const layer = new DOMRect(100, 50, 1224, 1584);
  const rects = toPdfRects(
    [new DOMRect(120, 70, 100, 20), new DOMRect(222, 71, 80, 19), new DOMRect(120, 100, 150, 20)],
    layer,
    unit,
  );
  expect(rects).toEqual([
    [10, 772, 101, 782],
    [10, 757, 85, 767],
  ]);
  expect(toBox(rects[0], unit, 2)).toEqual({ left: 20, top: 20, width: 182, height: 20 });
  expect(
    mergeLines([
      [0, 0, 10, 10],
      [11, 0, 20, 10],
      [0, 20, 5, 30],
    ]),
  ).toHaveLength(2);
});

it('finds the highlight under a point and lists them in reading order', () => {
  const list = [
    highlight('lower', 0, [10, 100, 200, 112]),
    highlight('upper', 0, [10, 700, 200, 712]),
    highlight('wide', 1, [0, 0, 600, 700]),
    highlight('inside', 1, [100, 100, 120, 110]),
  ];
  expect(annotationAt(list, 0, 50, 105)?.id).toBe('lower');
  expect(annotationAt(list, 1, 110, 105)?.id).toBe('inside');
  expect(annotationAt(list, 0, 300, 300)).toBeUndefined();
  expect(readingOrder(list).map((a) => a.id)).toEqual(['upper', 'lower', 'wide', 'inside']);
});

it('offers highlight colors only where highlights can be kept', async () => {
  const user = userEvent.setup();
  const highlightWith = vi.fn();
  const ask = vi.fn();
  const view = render(
    <SelectionToolbar
      box={new DOMRect(300, 300, 100, 20)}
      canAnnotate
      onHighlight={highlightWith}
      onUnderline={vi.fn()}
      onComment={vi.fn()}
      onCopy={vi.fn()}
      onAsk={ask}
      onQuote={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  await user.click(screen.getByRole('button', { name: '绿色高亮' }));
  expect(highlightWith).toHaveBeenCalledWith('#5fb236');
  await user.click(screen.getByRole('button', { name: '问 AI' }));
  expect(ask).toHaveBeenCalled();
  view.rerender(
    <SelectionToolbar
      box={new DOMRect(300, 300, 100, 20)}
      canAnnotate={false}
      onHighlight={highlightWith}
      onUnderline={vi.fn()}
      onComment={vi.fn()}
      onCopy={vi.fn()}
      onAsk={ask}
      onClose={vi.fn()}
    />,
  );
  expect(screen.queryByRole('button', { name: '黄色高亮' })).toBeNull();
  expect(screen.queryByRole('button', { name: '摘录到笔记' })).toBeNull();
  expect(screen.getByRole('button', { name: '复制' })).toBeTruthy();
});

it('keeps a typed comment when the popover closes, recolors and deletes', async () => {
  const user = userEvent.setup();
  const change = vi.fn();
  const remove = vi.fn();
  const close = vi.fn();
  const annotation = highlight('a', 0, [0, 0, 1, 1]);
  const view = render(
    <AnnotationPopover
      annotation={annotation}
      at={new DOMRect(200, 200, 0, 0)}
      readOnly={false}
      focusComment
      onChange={change}
      onDelete={remove}
      onClose={close}
    />,
  );
  await user.type(screen.getByRole('textbox', { name: '批注内容' }), 'Key result');
  await user.click(screen.getByRole('button', { name: '蓝色高亮' }));
  expect(change).toHaveBeenLastCalledWith({
    ...annotation,
    comment: 'Key result',
    color: '#2ea8e5',
  });
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(close).toHaveBeenCalled();
  expect(change).toHaveBeenLastCalledWith({ ...annotation, comment: 'Key result' });
  view.unmount();
  render(
    <AnnotationPopover
      annotation={annotation}
      at={new DOMRect(200, 200, 0, 0)}
      readOnly={false}
      focusComment={false}
      onChange={change}
      onDelete={remove}
      onClose={close}
    />,
  );
  await user.click(screen.getByRole('button', { name: '删除批注' }));
  expect(remove).toHaveBeenCalled();
});

it('lists highlights with their page and comment', async () => {
  const user = userEvent.setup();
  const open = vi.fn();
  render(
    <AnnotationList
      annotations={[{ ...highlight('b', 4, [0, 0, 1, 1]), text: 'later', comment: 'why?' }]}
      active={null}
      onOpen={open}
    />,
  );
  expect(screen.getByText('why?')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: /later/ }));
  expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: 'b' }));
  expect(screen.getByText('第 5 页')).toBeTruthy();
});
