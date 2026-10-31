import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';
import {
  extractPaper,
  loadTextPdf,
  pdfPageText,
  type PaperJob,
  type PaperResult,
} from '../reader/pdf-text';
import { errorMessage } from '../domain/errors';

interface PaperBridge {
  source(id: string): Promise<ArrayBuffer>;
  complete(id: string, result: PaperResult | null, error: string | null): Promise<void>;
}
interface DocumentEntry {
  task?: PDFDocumentLoadingTask;
  pdf: Promise<PDFDocumentProxy>;
  users: Set<string>;
  idle: ReturnType<typeof setTimeout> | null;
  failed: boolean;
}
type Pending = {
  job: PaperJob;
  controller: AbortController;
  timeout: ReturnType<typeof setTimeout>;
  reportError: boolean;
};

/** Owned by the workspace window, independently of reader tabs and chat panels. */
export class PaperService {
  private documents = new Map<string, DocumentEntry>();
  private texts = new Map<string, string>();
  private pageReads = new Map<string, Promise<string>>();
  private textSize = 0;
  private requests = new Map<string, Pending>();
  private queue: Pending[] = [];
  private running = 0;
  private disposed = false;
  constructor(
    private bridge: PaperBridge,
    private load = loadTextPdf,
  ) {}

  enqueue(job: PaperJob) {
    if (this.disposed || this.requests.has(job.id)) return;
    if (this.requests.size >= 8) {
      void this.bridge.complete(job.id, null, '论文读取繁忙，请稍后重试。').catch(console.error);
      return;
    }
    const controller = new AbortController();
    const pending: Pending = {
      job,
      controller,
      reportError: true,
      timeout: setTimeout(() => {
        controller.abort(new Error('论文读取超时，请缩小页段后重试。'));
        this.drain();
      }, 30000),
    };
    this.requests.set(job.id, pending);
    this.queue.push(pending);
    this.drain();
  }

  cancel(id: string) {
    const pending = this.requests.get(id);
    if (pending) {
      pending.reportError = false;
      pending.controller.abort(new Error('论文读取已中止。'));
    }
    this.drain();
  }

  dispose() {
    this.disposed = true;
    for (const { controller, timeout } of this.requests.values()) {
      clearTimeout(timeout);
      controller.abort(new Error('论文服务已关闭。'));
    }
    this.requests.clear();
    this.queue = [];
    for (const [key, entry] of this.documents) void this.removeDocument(key, entry);
    this.texts.clear();
    this.textSize = 0;
  }

  private drain() {
    while (!this.disposed && this.running < 2 && this.queue.length) {
      const pending = this.queue.shift()!;
      if (pending.controller.signal.aborted) {
        clearTimeout(pending.timeout);
        this.requests.delete(pending.job.id);
        if (pending.reportError)
          void this.bridge
            .complete(pending.job.id, null, String(pending.controller.signal.reason))
            .catch(console.error);
        continue;
      }
      this.running++;
      void this.run(pending).finally(() => {
        this.running--;
        clearTimeout(pending.timeout);
        this.requests.delete(pending.job.id);
        this.drain();
      });
    }
  }

  private async removeDocument(key: string, entry: DocumentEntry) {
    if (entry.idle) clearTimeout(entry.idle);
    if (this.documents.get(key) !== entry) return;
    this.documents.delete(key);
    for (const [pageKey, text] of this.texts) {
      if (pageKey.startsWith(`${key}:`)) {
        this.textSize -= text.length * 2;
        this.texts.delete(pageKey);
      }
    }
    for (const pageKey of this.pageReads.keys()) {
      if (pageKey.startsWith(`${key}:`)) this.pageReads.delete(pageKey);
    }
    await entry.task?.destroy().catch(console.error);
  }

  private page(key: string, entry: DocumentEntry, pdf: PDFDocumentProxy, number: number) {
    const pageKey = `${key}:${number}`;
    const cached = this.texts.get(pageKey);
    if (cached !== undefined) {
      this.texts.delete(pageKey);
      this.texts.set(pageKey, cached);
      return Promise.resolve(cached);
    }
    let reading = this.pageReads.get(pageKey);
    if (!reading) {
      reading = pdfPageText(pdf, number)
        .then((text) => {
          if (this.disposed || this.documents.get(key) !== entry) return text;
          if (text.length * 2 <= 16 * 1024 * 1024) {
            this.texts.set(pageKey, text);
            this.textSize += text.length * 2;
            while (this.textSize > 16 * 1024 * 1024) {
              const oldest = this.texts.keys().next().value!;
              this.textSize -= this.texts.get(oldest)!.length * 2;
              this.texts.delete(oldest);
            }
          }
          return text;
        })
        .finally(() => {
          if (this.pageReads.get(pageKey) === reading) this.pageReads.delete(pageKey);
        });
      this.pageReads.set(pageKey, reading);
    }
    return reading;
  }

  private async open(key: string, entry: DocumentEntry, id: string) {
    try {
      for (const [oldKey, old] of this.documents) {
        if (!old.users.size) await this.removeDocument(oldKey, old);
      }
      let bytes: ArrayBuffer;
      const attempted = new Set<string>();
      let sourceId = id;
      while (true) {
        attempted.add(sourceId);
        try {
          bytes = await this.bridge.source(sourceId);
          break;
        } catch (error) {
          const other = [...entry.users].find((user) => !attempted.has(user));
          if (!other) throw error;
          sourceId = other;
        }
      }
      if (this.disposed || this.documents.get(key) !== entry) throw new Error('论文请求已中止。');
      const task = await this.load(bytes);
      // Consume loading failures even when cancellation occurs during module import.
      void task.promise.catch(() => {});
      if (this.disposed || this.documents.get(key) !== entry) {
        await task.destroy();
        throw new Error('论文请求已中止。');
      }
      entry.task = task;
      return await task.promise;
    } catch (error) {
      entry.failed = true;
      throw error;
    }
  }

  private async run(pending: Pending) {
    const { job, controller } = pending;
    const { signal } = controller;
    const key = JSON.stringify([job.projectId, job.root, job.path, job.version, 1]);
    let entry = this.documents.get(key);
    let abort: (() => void) | undefined;
    try {
      if (!entry) {
        entry = { pdf: undefined!, users: new Set([job.id]), idle: null, failed: false };
        this.documents.set(key, entry);
        entry.pdf = this.open(key, entry, job.id);
      }
      if (entry.idle) clearTimeout(entry.idle);
      entry.idle = null;
      entry.users.add(job.id);
      const document = entry;
      const cancelled = new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
      const operation = document.pdf.then((pdf) =>
        extractPaper(pdf, job, (number) => this.page(key, document, pdf, number), signal),
      );
      const result = await Promise.race([operation, cancelled]);
      signal.throwIfAborted();
      await this.bridge.complete(job.id, result, null);
    } catch (reason) {
      if (!this.disposed && pending.reportError)
        await this.bridge.complete(job.id, null, errorMessage(reason)).catch(console.error);
    } finally {
      if (abort) signal.removeEventListener('abort', abort);
      if (entry) {
        entry.users.delete(job.id);
        if (!entry.users.size) {
          if (signal.aborted || this.disposed || entry.failed)
            await this.removeDocument(key, entry);
          else {
            const idleEntry = entry;
            entry.idle = setTimeout(() => {
              void this.removeDocument(key, idleEntry);
            }, 30000);
          }
        }
      }
    }
  }
}

export function installPaperService(onError: (error: unknown) => void) {
  if (!isTauri()) return () => {};
  const service = new PaperService({
    source: (requestId) => invoke('agent_paper_source', { requestId }),
    complete: (requestId, result, error) =>
      invoke('agent_paper_complete', { requestId, result, error }),
  });
  let disposed = false;
  const registration = listen<PaperJob | { id: string; cancel: true }>(
    'agent-paper-request',
    (event) => {
      if ('cancel' in event.payload) service.cancel(event.payload.id);
      else service.enqueue(event.payload);
    },
  ).then(async (unlisten) => {
    if (disposed) {
      unlisten();
      return null;
    }
    try {
      const serviceId = await invoke<string>('agent_paper_ready');
      return { unlisten, serviceId };
    } catch (error) {
      unlisten();
      throw error;
    }
  });
  void registration.catch(onError);
  return () => {
    disposed = true;
    service.dispose();
    void registration
      .then(async (registered) => {
        if (!registered) return;
        registered.unlisten();
        await invoke('agent_paper_stop', { serviceId: registered.serviceId });
      })
      .catch(onError);
  };
}
