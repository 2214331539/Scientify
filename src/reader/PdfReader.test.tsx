import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { PdfBackend } from '../platform/research';
import PdfReader from './PdfReader';

const links = vi.hoisted(() => ({
  annotations: new Map<number, Record<string, unknown>[]>(),
  getDestination: vi.fn(async () => [{ num: 3, gen: 0 }, { name: 'XYZ' }, 120, 300, null]),
  getPageIndex: vi.fn(async () => 1),
}));

vi.mock('pdfjs-dist', async (importOriginal) => {
  vi.stubGlobal('DOMMatrix', class {});
  const actual = await importOriginal<typeof import('pdfjs-dist')>();
  function viewport(scale: number) {
    return {
      width: 600 * scale,
      height: 800 * scale,
      viewBox: [0, 0, 600, 800],
      rotation: 0,
      rawDims: { pageX: 0, pageY: 0, pageWidth: 600, pageHeight: 800 },
      clone: () => viewport(scale),
      convertToViewportPoint: (x: number, y: number) => [x * scale, (800 - y) * scale],
    };
  }
  return {
    ...actual,
    GlobalWorkerOptions: { workerSrc: '' },
    getDocument: () => ({
      promise: Promise.resolve({
        numPages: 2,
        pagesMapper: { pagesNumber: 2 },
        getDestination: links.getDestination,
        getOutline: async () => null,
        getPageIndex: links.getPageIndex,
        cachedPageNumber: () => null,
        getPage: async (page: number) => ({
          view: [0, 0, 600, 800],
          getViewport: ({ scale }: { scale: number }) => viewport(scale),
          getAnnotations: async () => links.annotations.get(page) ?? [],
          render: () => ({ promise: Promise.resolve(), cancel: () => {} }),
          getTextContent: async () => ({ items: [{ str: 'Research text' }] }),
        }),
      }),
      destroy: async () => {},
    }),
    TextLayer: class {
      render = async () => {};
      cancel = () => {};
    },
  };
});
beforeEach(() => {
  links.annotations.clear();
  links.getDestination.mockClear();
  links.getPageIndex.mockClear();
});
beforeAll(() => {
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});
afterAll(() => vi.unstubAllGlobals());

function annotation(id: string, target: Record<string, unknown>) {
  return {
    id,
    annotationType: 2,
    rotation: 0,
    rect: [20, 700, 160, 720],
    borderStyle: { width: 0, style: 1, dashArray: [] },
    ...target,
  };
}

function setup() {
  const backend: PdfBackend = {
    readPdf: vi.fn(async () => new Uint8Array([1])),
  };
  const context = vi.fn();
  return {
    backend,
    context,
    reader: (
      <PdfReader
        assetId="asset"
        title="Paper"
        projectId="p"
        paperId="paper"
        backend={backend}
        onContext={context}
        onTool={() => {}}
        compact
      />
    ),
  };
}

it('restores page, zoom and scroll when a document tab is remounted', async () => {
  const { reader, context } = setup();
  const user = userEvent.setup();
  const host = render(reader);
  await waitFor(() => expect(context.mock.lastCall?.[0].text).toBe('Research text'));
  await user.click(screen.getByRole('button', { name: '下一页' }));
  await user.click(screen.getByRole('button', { name: '放大 PDF' }));
  await waitFor(() =>
    expect(context.mock.lastCall?.[0]).toMatchObject({ page: 2, text: 'Research text' }),
  );
  const scroll = host.container.querySelector('.pdf-scroll')!;
  fireEvent.scroll(scroll, { target: { scrollTop: 124, scrollLeft: 31 } });
  host.unmount();
  context.mockClear();
  const next = render(reader);
  await waitFor(() =>
    expect(context.mock.lastCall?.[0]).toMatchObject({ page: 2, text: 'Research text' }),
  );
  expect((screen.getByRole('spinbutton', { name: '页码' }) as HTMLInputElement).value).toBe('2');
  expect(screen.getByText('115%')).toBeTruthy();
  expect(next.container.querySelector('.pdf-scroll')?.scrollTop).toBe(124);
  expect(next.container.querySelector('.pdf-scroll')?.scrollLeft).toBe(31);
});

it('honors a note-source page target instead of a cached tab position', async () => {
  const { reader, context } = setup();
  const user = userEvent.setup();
  const host = render(reader);
  await waitFor(() => expect(context.mock.lastCall?.[0].text).toBe('Research text'));
  await user.click(screen.getByRole('button', { name: '下一页' }));
  await waitFor(() => expect(context.mock.lastCall?.[0].page).toBe(2));
  host.unmount();
  localStorage.setItem('scientify.reader.asset', '1');
  context.mockClear();
  render(reader);
  await waitFor(() =>
    expect(context.mock.lastCall?.[0]).toMatchObject({ page: 1, text: 'Research text' }),
  );
  expect((screen.getByRole('spinbutton', { name: '页码' }) as HTMLInputElement).value).toBe('1');
});

it('scrolls across pages, switches mode at the current page and follows source links without rereading the PDF', async () => {
  const { reader, context, backend } = setup();
  const user = userEvent.setup();
  const host = render(reader);
  await waitFor(() => expect(context.mock.lastCall?.[0].text).toBe('Research text'));
  await user.click(screen.getByRole('button', { name: '切换为连续滚动' }));
  const pages = host.container.querySelectorAll<HTMLElement>('[data-pdf-page]');
  expect(pages).toHaveLength(2);
  Object.defineProperty(pages[0], 'offsetTop', { value: 24 });
  Object.defineProperty(pages[1], 'offsetTop', { value: 844 });
  const scroll = host.container.querySelector('.pdf-scroll')!;
  Object.defineProperty(scroll, 'clientHeight', { value: 600 });
  fireEvent.scroll(scroll, { target: { scrollTop: 900 } });
  await waitFor(() =>
    expect(context.mock.lastCall?.[0]).toMatchObject({ page: 2, text: 'Research text' }),
  );
  await user.click(screen.getByRole('button', { name: '切换为分页阅览' }));
  expect(host.container.querySelectorAll('[data-pdf-page]')).toHaveLength(1);
  expect((screen.getByRole('spinbutton', { name: '页码' }) as HTMLInputElement).value).toBe('2');
  expect(scroll.scrollTop).toBe(56);
  await user.click(screen.getByRole('button', { name: '切换为连续滚动' }));
  fireEvent(
    window,
    new CustomEvent('scientify-pdf-page', { detail: { paperId: 'paper', page: 1 } }),
  );
  await waitFor(() =>
    expect((screen.getByRole('spinbutton', { name: '页码' }) as HTMLInputElement).value).toBe('1'),
  );
  expect(backend.readPdf).toHaveBeenCalledTimes(1);
  expect(localStorage.getItem('scientify.reader.mode')).toBe('continuous');
});

it('renders web links with PDF.js and opens them without navigating the application', async () => {
  links.annotations.set(1, [annotation('web', { url: 'https://doi.org/10.1234/example' })]);
  const open = vi.spyOn(window, 'open').mockReturnValue(null);
  const { reader } = setup();
  render(reader);
  const link = await screen.findByRole('link', { name: 'https://doi.org/10.1234/example' });
  expect(link.closest('.annotationLayer')).not.toBeNull();
  expect(link.closest('section')?.style.left).toBe(`${(100 * 20) / 600}%`);
  const event = new MouseEvent('click', { bubbles: true, cancelable: true });
  fireEvent(link, event);
  expect(event.defaultPrevented).toBe(true);
  expect(open).toHaveBeenCalledWith(
    'https://doi.org/10.1234/example',
    '_blank',
    'noopener,noreferrer',
  );
  open.mockRestore();
});

it.each(['paged', 'continuous'])(
  'follows named document links to the referenced location in %s mode',
  async (mode) => {
    links.annotations.set(1, [annotation('internal', { dest: 'References' })]);
    const { reader, backend } = setup();
    const user = userEvent.setup();
    const host = render(reader);
    await screen.findByRole('link', { name: '跳转至文档位置' });
    if (mode === 'continuous') {
      await user.click(screen.getByRole('button', { name: '切换为连续滚动' }));
      Object.defineProperty(host.container.querySelector('[data-pdf-page="2"]'), 'offsetTop', {
        value: 844,
      });
    }
    await user.click(await screen.findByRole('link', { name: '跳转至文档位置' }));
    await waitFor(() =>
      expect((screen.getByRole('spinbutton', { name: '页码' }) as HTMLInputElement).value).toBe(
        '2',
      ),
    );
    await waitFor(() =>
      expect(host.container.querySelector('.pdf-scroll')?.scrollTop).toBe(
        mode === 'continuous' ? 1344 : 500,
      ),
    );
    expect(links.getDestination).toHaveBeenCalledWith('References');
    expect(links.getPageIndex).toHaveBeenCalledWith({ num: 3, gen: 0 });
    expect(backend.readPdf).toHaveBeenCalledTimes(1);
  },
);

it('follows same-page links and keeps subsequent manual scroll positions', async () => {
  links.annotations.set(1, [
    annotation('same-page', { dest: [0, { name: 'XYZ' }, null, 400, null] }),
  ]);
  const { reader, context } = setup();
  const user = userEvent.setup();
  const host = render(reader);
  await user.click(await screen.findByRole('link', { name: '跳转至文档位置' }));
  const scroll = host.container.querySelector('.pdf-scroll')!;
  await waitFor(() => expect(scroll.scrollTop).toBe(400));
  fireEvent.scroll(scroll, { target: { scrollTop: 123, scrollLeft: 0 } });
  host.unmount();
  context.mockClear();
  const next = render(reader);
  await waitFor(() => expect(context.mock.lastCall?.[0].text).toBe('Research text'));
  expect(next.container.querySelector('.pdf-scroll')?.scrollTop).toBe(123);
});

it('keeps unsupported URI and PDF script actions from leaving the reader', async () => {
  links.annotations.set(1, [
    annotation('script-url', { url: 'javascript:alert(1)' }),
    annotation('local-file', { url: 'file:///C:/test.exe' }),
    annotation('script-action', { actions: { Action: ['app.alert("test")'] } }),
  ]);
  const { reader, context } = setup();
  const open = vi.spyOn(window, 'open').mockReturnValue(null);
  const host = render(reader);
  await waitFor(() => expect(context.mock.lastCall?.[0].text).toBe('Research text'));
  expect(host.container.querySelectorAll('.annotationLayer a[href]')).toHaveLength(0);
  expect(open).not.toHaveBeenCalled();
  open.mockRestore();
});

it('zooms with Ctrl + wheel, preserves the reading anchor and leaves ordinary scrolling alone', async () => {
  const { reader, context } = setup();
  const host = render(reader);
  await waitFor(() => expect(context.mock.lastCall?.[0].text).toBe('Research text'));
  const scroll = host.container.querySelector('.pdf-scroll')!;
  fireEvent.scroll(scroll, { target: { scrollTop: 120, scrollLeft: 0 } });
  const normal = new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true });
  fireEvent(scroll, normal);
  expect(normal.defaultPrevented).toBe(false);
  expect(screen.getByText('100%')).toBeTruthy();
  const zoom = new WheelEvent('wheel', {
    ctrlKey: true,
    deltaY: -100,
    clientY: 100,
    bubbles: true,
    cancelable: true,
  });
  fireEvent(scroll, zoom);
  expect(zoom.defaultPrevented).toBe(true);
  await waitFor(() => expect(screen.getByText('122%')).toBeTruthy());
  await waitFor(() => expect(scroll.scrollTop).toBeCloseTo(168.62));
  await act(async () => {
    for (let i = 0; i < 20; i++) fireEvent.wheel(scroll, { ctrlKey: true, deltaY: -100 });
  });
  await waitFor(() => expect(screen.getByText('200%')).toBeTruthy());
  await act(async () => {
    for (let i = 0; i < 20; i++) fireEvent.wheel(scroll, { ctrlKey: true, deltaY: 100 });
  });
  await waitFor(() => expect(screen.getByText('50%')).toBeTruthy());
});
