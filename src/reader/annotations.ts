import type { PageViewport } from 'pdfjs-dist';
import type { PaperAnnotation } from '../platform/library';

/** Zotero's palette, so highlights brought over from Zotero keep their meaning. */
export const HIGHLIGHT_COLORS = [
  { color: '#ffd400', name: '黄色' },
  { color: '#ff6666', name: '红色' },
  { color: '#5fb236', name: '绿色' },
  { color: '#2ea8e5', name: '蓝色' },
  { color: '#a28ae5', name: '紫色' },
] as const;

export type PdfRect = [number, number, number, number];

const round = (n: number) => Math.round(n * 100) / 100;

/** Joins the many small boxes of a text selection into one box per line. */
export function mergeLines(rects: PdfRect[]): PdfRect[] {
  const sorted = [...rects].sort((a, b) => b[3] - a[3] || a[0] - b[0]);
  const lines: PdfRect[] = [];
  for (const rect of sorted) {
    const line = lines.find((l) => {
      const overlap = Math.min(l[3], rect[3]) - Math.max(l[1], rect[1]);
      const height = Math.min(l[3] - l[1], rect[3] - rect[1]);
      return overlap > height * 0.5 && rect[0] - l[2] < height * 1.5 && rect[2] > l[0] - height;
    });
    if (line) {
      line[0] = Math.min(line[0], rect[0]);
      line[1] = Math.min(line[1], rect[1]);
      line[2] = Math.max(line[2], rect[2]);
      line[3] = Math.max(line[3], rect[3]);
    } else lines.push([...rect]);
  }
  return lines.map((l) => l.map(round) as PdfRect);
}

/**
 * PDF rectangles (points, origin bottom left) for client rectangles on a page.
 * `layer` is where the page's text layer is on screen; `unit` its viewport at scale 1.
 */
export function toPdfRects(rects: Iterable<DOMRect>, layer: DOMRect, unit: PageViewport) {
  const scale = layer.width / unit.width;
  const out: PdfRect[] = [];
  for (const r of rects) {
    if (r.width < 0.5 || r.height < 0.5) continue;
    const [ax, ay] = unit.convertToPdfPoint(
      (r.left - layer.left) / scale,
      (r.top - layer.top) / scale,
    );
    const [bx, by] = unit.convertToPdfPoint(
      (r.right - layer.left) / scale,
      (r.bottom - layer.top) / scale,
    );
    out.push([Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)]);
  }
  return mergeLines(out);
}

/** Where a PDF rectangle sits on the page at `scale`, in CSS pixels. */
export function toBox(rect: PdfRect, unit: PageViewport, scale: number) {
  const [x1, y1] = unit.convertToViewportPoint(rect[0], rect[1]);
  const [x2, y2] = unit.convertToViewportPoint(rect[2], rect[3]);
  return {
    left: Math.min(x1, x2) * scale,
    top: Math.min(y1, y2) * scale,
    width: Math.abs(x2 - x1) * scale,
    height: Math.abs(y2 - y1) * scale,
  };
}

/** The annotation under a point of the page (PDF points), the smallest first. */
export function annotationAt(list: PaperAnnotation[], page: number, x: number, y: number) {
  const pad = 1.5;
  const hits = list.filter(
    (a) =>
      a.page === page &&
      a.rects.some((r) => x >= r[0] - pad && x <= r[2] + pad && y >= r[1] - pad && y <= r[3] + pad),
  );
  const area = (a: PaperAnnotation) =>
    a.rects.reduce((sum, r) => sum + (r[2] - r[0]) * (r[3] - r[1]), 0);
  return hits.sort((a, b) => area(a) - area(b))[0];
}

/** Annotations in reading order: by page, then top to bottom, then left to right. */
export function readingOrder(list: PaperAnnotation[]) {
  const top = (a: PaperAnnotation) => Math.max(...a.rects.map((r) => r[3]), 0);
  const left = (a: PaperAnnotation) => Math.min(...a.rects.map((r) => r[0]), 0);
  return [...list].sort((a, b) => a.page - b.page || top(b) - top(a) || left(a) - left(b));
}

export function newAnnotation(
  kind: PaperAnnotation['kind'],
  page: number,
  rects: PdfRect[],
  text: string,
  color: string,
): PaperAnnotation {
  return {
    id: crypto.randomUUID(),
    kind,
    page,
    rects,
    text,
    comment: '',
    color,
    createdAt: new Date().toISOString(),
  };
}
