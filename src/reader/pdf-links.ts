import 'pdfjs-dist';
import type { PDFDocumentProxy, PageViewport } from 'pdfjs-dist';
import { EventBus, LinkTarget, PDFLinkService } from 'pdfjs-dist/web/pdf_viewer.mjs';
import { isTauri } from '@tauri-apps/api/core';
import { browserCommand } from '../platform/browser-pane';
import { t } from '../i18n';
import { errorMessage } from '../domain/errors';

export type PdfLinkTarget = { pageNumber: number; destArray?: unknown[] | null };

export function destinationOffset(viewport: PageViewport, destination?: unknown[] | null) {
  const [xMin, , , yMax] = viewport.viewBox;
  const kind = (destination?.[1] as { name?: string } | undefined)?.name;
  const coordinate = (value: unknown, fallback: number) =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  let x = xMin,
    y = yMax;
  if (kind === 'XYZ') {
    x = coordinate(destination?.[2], xMin);
    y = coordinate(destination?.[3], yMax);
  } else if (kind === 'FitH' || kind === 'FitBH') y = coordinate(destination?.[2], yMax);
  else if (kind === 'FitV' || kind === 'FitBV') x = coordinate(destination?.[2], xMin);
  else if (kind === 'FitR') {
    const first = viewport.convertToViewportPoint(
      coordinate(destination?.[2], xMin),
      coordinate(destination?.[3], yMax),
    );
    const second = viewport.convertToViewportPoint(
      coordinate(destination?.[4], xMin),
      coordinate(destination?.[5], yMax),
    );
    return {
      left: Math.max(0, Math.min(first[0], second[0])),
      top: Math.max(0, Math.min(first[1], second[1])),
    };
  } else return { left: 0, top: 0 };
  const [left, top] = viewport.convertToViewportPoint(x, y);
  return { left: Math.max(0, left), top: Math.max(0, top) };
}

async function openWebLink(url: string) {
  if (isTauri()) await browserCommand({ op: 'external', address: url });
  else window.open(url, '_blank', 'noopener,noreferrer');
}

/** PDF.js resolves named destinations and page references; the reader owns scrolling. */
export class ReaderLinkService extends PDFLinkService {
  constructor(
    document: PDFDocumentProxy,
    private readonly callbacks: {
      page(): number;
      navigate(target: PdfLinkTarget): void;
      error(message: string): void;
      openExternal?(url: string): Promise<void>;
    },
  ) {
    super({
      eventBus: new EventBus(),
      externalLinkTarget: LinkTarget.BLANK,
      ignoreDestinationZoom: true,
    });
    this.setDocument(document);
    this.setViewer({
      get currentPageNumber() {
        return callbacks.page();
      },
      set currentPageNumber(pageNumber: number) {
        callbacks.navigate({ pageNumber });
      },
      isInPresentationMode: false,
      pagesRotation: 0,
      pageLabelToPageNumber: () => null,
      scrollPageIntoView: (target: PdfLinkTarget) => callbacks.navigate(target),
      nextPage: () => callbacks.navigate({ pageNumber: callbacks.page() + 1 }),
      previousPage: () => callbacks.navigate({ pageNumber: callbacks.page() - 1 }),
    });
  }

  override async goToDestination(destination: string | unknown[]) {
    try {
      await super.goToDestination(destination);
    } catch (error) {
      if (this.pdfDocument) this.callbacks.error(errorMessage(error));
    }
  }

  override addLinkAttributes(link: HTMLAnchorElement, url: string, newWindow = false) {
    let target: URL;
    try {
      target = new URL(url);
      if (!['http:', 'https:'].includes(target.protocol)) return;
    } catch {
      return;
    }
    super.addLinkAttributes(link, target.href, newWindow);
    link.addEventListener('click', (event) => {
      event.preventDefault();
      void (this.callbacks.openExternal ?? openWebLink)(target.href).catch((error) => {
        if (this.pdfDocument) this.callbacks.error(errorMessage(error));
      });
    });
  }
}

export const pdfLinkLabel = (link: HTMLAnchorElement) => link.title || t('跳转至文档位置');
