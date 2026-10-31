import type { PDFDocumentProxy, PDFDocumentLoadingTask } from 'pdfjs-dist';

export async function loadTextPdf(data: ArrayBuffer | Uint8Array): Promise<PDFDocumentLoadingTask> {
  const { getDocument, GlobalWorkerOptions } = await import('pdfjs-dist');
  const { default: worker } = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  GlobalWorkerOptions.workerSrc = worker;
  const base = import.meta.env.BASE_URL + 'pdfjs/';
  return getDocument({
    data,
    useSystemFonts: true,
    cMapUrl: base + 'cmaps/',
    cMapPacked: true,
    standardFontDataUrl: base + 'standard_fonts/',
    wasmUrl: base + 'wasm/',
    iccUrl: base + 'iccs/',
  });
}

export async function pdfPageText(pdf: PDFDocumentProxy, number: number): Promise<string> {
  const page = await pdf.getPage(number);
  try {
    const content = await page.getTextContent();
    return content.items
      .map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : ''))
      .join('');
  } finally {
    page.cleanup();
  }
}

export interface PaperJob {
  id: string;
  projectId: string;
  root: string;
  path: string;
  version: string;
  operation: 'read' | 'search';
  page: number;
  offset: number;
  pageCount: number;
  query: string;
}
export interface PaperCursor {
  page: number;
  offset: number;
}
export interface PaperResult {
  totalPages: number;
  pages?: { page: number; startOffset: number; text: string; truncated: boolean }[];
  matches?: { page: number; offset: number; text: string }[];
  searchedPages?: number[];
  emptyPages?: number[];
  truncated: boolean;
  nextCursor: PaperCursor | null;
}

function textEnd(text: string, end: number) {
  if (
    end > 0 &&
    /[\uD800-\uDBFF]/.test(text.charAt(end - 1)) &&
    /[\uDC00-\uDFFF]/.test(text.charAt(end))
  )
    return end - 1;
  return end;
}

/** Page offsets use JavaScript string indices, including the continuation cursor. */
export async function extractPaper(
  pdf: Pick<PDFDocumentProxy, 'numPages'>,
  job: PaperJob,
  pageText: (page: number) => Promise<string>,
  signal: AbortSignal,
): Promise<PaperResult> {
  if (job.page > pdf.numPages) throw new Error('页码超出 PDF 范围。');
  const result: PaperResult = { totalPages: pdf.numPages, truncated: false, nextCursor: null };
  const end = Math.min(pdf.numPages, job.page + job.pageCount - 1);
  const started = Date.now();
  const emptyPages: number[] = [];
  let remaining = 24000;
  if (job.operation === 'read') result.pages = [];
  else {
    result.matches = [];
    result.searchedPages = [];
  }
  for (let number = job.page; number <= end; number++) {
    signal.throwIfAborted();
    if (job.operation === 'search' && number > job.page && Date.now() - started > 5000) {
      result.nextCursor = { page: number, offset: 0 };
      break;
    }
    const text = await pageText(number);
    signal.throwIfAborted();
    const offset = number === job.page ? job.offset : 0;
    if (offset > text.length) throw new Error('页内读取位置无效，请重新读取该页。');
    if (!text.trim()) emptyPages.push(number);
    if (job.operation === 'read') {
      const part = text.slice(offset, textEnd(text, offset + remaining));
      remaining -= part.length;
      const cut = offset + part.length < text.length;
      result.pages!.push({ page: number, startOffset: offset, text: part, truncated: cut });
      if (cut || !remaining) {
        result.nextCursor = cut
          ? { page: number, offset: offset + part.length }
          : number < pdf.numPages
            ? { page: number + 1, offset: 0 }
            : null;
        break;
      }
    } else {
      result.searchedPages!.push(number);
      const pattern = new RegExp(job.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
      pattern.lastIndex = offset;
      let match = pattern.exec(text);
      while (match) {
        const found = match.index;
        let excerptStart = Math.max(0, found - 150);
        excerptStart = textEnd(text, excerptStart);
        result.matches!.push({
          page: number,
          offset: found,
          text: text.slice(excerptStart, textEnd(text, excerptStart + 500)),
        });
        const next = pattern.lastIndex;
        if (result.matches!.length === 20) {
          result.nextCursor =
            next < text.length
              ? { page: number, offset: next }
              : number < pdf.numPages
                ? { page: number + 1, offset: 0 }
                : null;
          break;
        }
        match = pattern.exec(text);
      }
      if (result.matches!.length === 20) break;
    }
    if (number === end && end < pdf.numPages) result.nextCursor = { page: end + 1, offset: 0 };
  }
  result.truncated = result.nextCursor !== null;
  if (emptyPages.length) result.emptyPages = emptyPages;
  if (result.pages?.every((page) => !page.text.trim()))
    throw new Error('所读取页段没有可提取的文字。可能是扫描页，暂不支持 OCR。');
  return result;
}
