import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import type { ResearchBackend } from '../platform/research';
import PdfReader from './PdfReader';

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: 2,
      getPage: async () => ({
        getViewport: ({ scale }: { scale: number }) => ({
          width: 600 * scale,
          height: 800 * scale,
        }),
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
}));
beforeAll(() => {
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

function setup() {
  const backend: ResearchBackend = {
    listFiles: async () => [],
    readFile: vi.fn(),
    writeFile: vi.fn(),
    importPdf: async () => null,
    readPdf: async () => new Uint8Array([1]),
    gitStatus: async () => [],
    askAI: async () => '',
    fetchArxiv: async () => '',
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
