import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';
import { afterEach, expect, it, vi } from 'vitest';
import { PaperService } from './paper-service';
import type { PaperJob } from '../reader/pdf-text';

const job: PaperJob = {
  id: 'one',
  projectId: 'p1',
  root: 'papers',
  path: 'a.pdf',
  version: 'v1',
  operation: 'read',
  page: 1,
  offset: 0,
  pageCount: 1,
  query: '',
};
const services: PaperService[] = [];
afterEach(() => {
  services.forEach((service) => service.dispose());
  services.length = 0;
  vi.useRealTimers();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture(text: string | (() => Promise<string>) = 'paper text') {
  const cleanup = vi.fn();
  const getTextContent = vi.fn(async () => ({
    items: [{ str: typeof text === 'string' ? text : await text(), hasEOL: true }],
  }));
  const getPage = vi.fn(async () => ({ getTextContent, cleanup }));
  const task = {
    promise: Promise.resolve({ numPages: 1, getPage } as unknown as PDFDocumentProxy),
    destroy: vi.fn(async () => {}),
  };
  const source = vi.fn(async (_id: string) => new ArrayBuffer(8));
  const complete = vi.fn(async (_id: string, _result: unknown, _error: unknown) => {});
  const load = vi.fn(
    async (_data: ArrayBuffer | Uint8Array) => task as unknown as PDFDocumentLoadingTask,
  );
  const service = new PaperService({ source, complete }, load);
  services.push(service);
  return { service, source, complete, load, task, getPage, getTextContent, cleanup };
}

it('shares concurrent PDF/page reads and cancelling one caller preserves the other', async () => {
  const text = deferred<string>();
  const f = fixture(() => text.promise);
  f.service.enqueue(job);
  f.service.enqueue({ ...job, id: 'two' });
  await vi.waitFor(() => expect(f.getTextContent).toHaveBeenCalledTimes(1));
  f.service.cancel('one');
  text.resolve('shared text');
  await vi.waitFor(() =>
    expect(f.complete).toHaveBeenCalledWith(
      'two',
      expect.objectContaining({ pages: [expect.objectContaining({ text: 'shared text\n' })] }),
      null,
    ),
  );
  expect(f.complete.mock.calls.some((call) => call[0] === 'one')).toBe(false);
  expect(f.source).toHaveBeenCalledTimes(1);
  expect(f.task.destroy).not.toHaveBeenCalled();
});

it('uses another active request when the first byte request is cancelled', async () => {
  const f = fixture();
  const source = deferred<ArrayBuffer>();
  f.source.mockImplementationOnce(() => source.promise);
  f.service.enqueue(job);
  f.service.enqueue({ ...job, id: 'two' });
  f.service.cancel('one');
  await Promise.resolve();
  source.reject(new Error('native request cancelled'));
  await vi.waitFor(() => expect(f.complete).toHaveBeenCalledWith('two', expect.anything(), null));
  expect(f.source).toHaveBeenLastCalledWith('two');
});

it('separates identical file names by project, root and version', async () => {
  const f = fixture();
  for (const next of [
    job,
    { ...job, id: 'two', projectId: 'p2', root: 'other' },
    { ...job, id: 'three', version: 'v2' },
  ])
    f.service.enqueue(next);
  await vi.waitFor(() => expect(f.complete).toHaveBeenCalledTimes(3));
  expect(f.source).toHaveBeenCalledTimes(3);
  expect(f.load).toHaveBeenCalledTimes(3);
  expect(f.task.destroy).toHaveBeenCalled();
});

it('discards failed loading tasks so a new request can retry', async () => {
  const f = fixture();
  f.load.mockImplementationOnce(
    async () =>
      ({
        promise: Promise.reject(new Error('broken')),
        destroy: vi.fn(async () => {}),
      }) as unknown as PDFDocumentLoadingTask,
  );
  f.service.enqueue(job);
  await vi.waitFor(() => expect(f.complete).toHaveBeenCalledWith('one', null, 'broken'));
  f.service.enqueue({ ...job, id: 'retry' });
  await vi.waitFor(() => expect(f.complete).toHaveBeenCalledWith('retry', expect.anything(), null));
  expect(f.load).toHaveBeenCalledTimes(2);
});

it('bounds pending work, times out stuck requests, and disposes workers', async () => {
  vi.useFakeTimers();
  const f = fixture(() => new Promise(() => {}));
  for (let index = 0; index < 9; index++) f.service.enqueue({ ...job, id: String(index) });
  await vi.advanceTimersByTimeAsync(1);
  expect(f.complete).toHaveBeenCalledWith('8', null, expect.stringContaining('繁忙'));
  await vi.advanceTimersByTimeAsync(30000);
  expect(f.complete).toHaveBeenCalledTimes(9);
  expect(f.task.destroy).toHaveBeenCalled();
  f.service.dispose();
  expect(vi.getTimerCount()).toBe(0);
});
