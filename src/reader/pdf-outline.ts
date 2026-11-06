import type { PDFDocumentProxy } from 'pdfjs-dist';

export interface PdfHeading {
  id: string;
  title: string;
  level: number;
  page: number;
  destination?: unknown[];
  hidden?: boolean;
}
export interface PdfOutline {
  version: 1;
  source: 'bookmarks' | 'detected' | 'manual';
  customized: boolean;
  entries: PdfHeading[];
}
interface TextLine {
  title: string;
  x: number;
  y: number;
  size: number;
  /** All capitals. pdf.js text items carry no font weight, so bold is not visible here. */
  emphasis: boolean;
  page: number;
  height: number;
}

const MAX_TITLE = 300;
const MAX_LEVEL = 5;
const MAX_ENTRIES = 10000;

/** Keep every stored outline inside the limits the app data layer accepts. */
export function normalizeOutline(outline: PdfOutline): PdfOutline {
  const entries: PdfHeading[] = [];
  for (const entry of outline.entries) {
    const title = entry.title.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);
    if (!title) continue;
    entries.push({
      ...entry,
      id: entry.id.length <= 256 ? entry.id : `entry-${entries.length}`,
      title,
      level: Math.min(MAX_LEVEL, Math.max(0, Math.trunc(entry.level) || 0)),
      page: Math.max(1, Math.trunc(entry.page) || 1),
    });
    if (entries.length === MAX_ENTRIES) break;
  }
  return { ...outline, entries };
}

function allCapitals(text: string) {
  const letters = text.replace(/[^\p{L}]/gu, '');
  return (
    letters.length >= 3 && letters === letters.toUpperCase() && letters !== letters.toLowerCase()
  );
}

const numbered = /^(\d{1,2}(?:\.\d{1,2}){0,4})[.)]?\s+\S/;
const named =
  /^(?:abstract|introduction|background|related work|method(?:s|ology)?|experiments?|results?|discussion|conclusions?|limitations?|acknowledg(?:e)?ments?|references|bibliography|appendix(?:\s+[A-Z])?|摘要|引言|绪论|相关工作|方法|实验|结果|讨论|结论|参考文献|附录)(?:\s*[:：.]?\s*)$/i;
const caption = /^(?:fig(?:ure)?\.?|table|algorithm|图|表|算法)\s*\d/i;

/** Keep coordinates in PDF space; zoom and rotation are applied only when navigating. */
export function detectHeadings(lines: TextLine[], pageCount: number): PdfHeading[] {
  const sizes = new Map<number, number>();
  const margins = new Map<string, Set<number>>();
  for (const line of lines) {
    const size = Math.round(line.size * 2) / 2;
    sizes.set(size, (sizes.get(size) ?? 0) + line.title.length);
    if (line.y < line.height * 0.09 || line.y > line.height * 0.93) {
      const key = line.title.toLowerCase().replace(/\d+/g, '#');
      const pages = margins.get(key) ?? new Set<number>();
      pages.add(line.page);
      margins.set(key, pages);
    }
  }
  const bodySize = [...sizes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 10;
  const candidates = lines.filter((line) => {
    const text = line.title;
    if (text.length < 2 || text.length > 160 || caption.test(text) || /^\W*\d+\W*$/.test(text))
      return false;
    if (
      (line.y < line.height * 0.09 || line.y > line.height * 0.93) &&
      (margins.get(text.toLowerCase().replace(/\d+/g, '#'))?.size ?? 0) >=
        Math.max(2, pageCount * 0.35)
    )
      return false;
    if (line.page === 1 && line.y > line.height * 0.8 && line.size > bodySize * 1.5) return false;
    if (named.test(text)) return true;
    const numberedTitle =
      numbered.test(text) ||
      /^(?:[IVX]{1,5}[.)]|[A-Z][.)]|第[一二三四五六七八九十百\d]+[章节])\s*\S/.test(text);
    if (numberedTitle) return line.emphasis || line.size >= bodySize * 1.08;
    return (
      line.size >= bodySize * 1.18 &&
      (line.emphasis || line.size >= bodySize * 1.35) &&
      text.length <= 100 &&
      !/[。；;!?]$/.test(text)
    );
  });
  const headingSizes = [...new Set(candidates.map((line) => Math.round(line.size * 2) / 2))].sort(
    (a, b) => b - a,
  );
  return candidates.map((line, index) => {
    const numbering = line.title.match(numbered);
    const level = numbering
      ? numbering[1].split('.').length - 1
      : named.test(line.title)
        ? 0
        : Math.min(2, headingSizes.indexOf(Math.round(line.size * 2) / 2));
    return {
      id: `text-${line.page}-${index}`,
      title: line.title,
      level,
      page: line.page,
      destination: [
        line.page - 1,
        { name: 'XYZ' },
        Math.max(0, line.x - 8),
        line.y + line.size * 1.5,
        null,
      ],
    };
  });
}

export async function readPdfOutline(
  pdf: PDFDocumentProxy,
  signal: AbortSignal,
  progress: (page: number) => void,
): Promise<PdfOutline> {
  // A damaged outline falls back to reading the headings from the text.
  const bookmarks = await pdf.getOutline().catch(() => null);
  signal.throwIfAborted();
  if (bookmarks?.length) {
    const entries: PdfHeading[] = [];
    async function visit(items: NonNullable<typeof bookmarks>, level: number, prefix: string) {
      for (const [index, item] of items.entries()) {
        signal.throwIfAborted();
        const id = `${prefix}-${index}`;
        try {
          const destination =
            typeof item.dest === 'string' ? await pdf.getDestination(item.dest) : item.dest;
          if (destination?.length) {
            const pageIndex =
              typeof destination[0] === 'number'
                ? destination[0]
                : await pdf.getPageIndex(destination[0]);
            if (pageIndex >= 0 && pageIndex < pdf.numPages)
              entries.push({ id, title: item.title, level, page: pageIndex + 1, destination });
          }
        } catch {
          // One broken bookmark must not hide the rest of the outline.
        }
        if (item.items?.length) await visit(item.items, level + 1, id);
      }
    }
    await visit(bookmarks, 0, 'bookmark');
    signal.throwIfAborted();
    const outline = normalizeOutline({
      version: 1,
      source: 'bookmarks',
      customized: false,
      entries,
    });
    if (outline.entries.length) return outline;
  }
  const lines: TextLine[] = [];
  for (let number = 1; number <= pdf.numPages; number++) {
    signal.throwIfAborted();
    const page = await pdf.getPage(number);
    const content = await page.getTextContent();
    signal.throwIfAborted();
    const segments = content.items
      .filter((item) => 'str' in item && item.str.trim())
      .map((item) => {
        if (!('str' in item)) throw new Error('Invalid PDF text item');
        return {
          title: item.str.trim(),
          x: item.transform[4] as number,
          y: item.transform[5] as number,
          size: Math.hypot(item.transform[2], item.transform[3]) || item.height,
          width: item.width,
        };
      })
      .sort((a, b) => (Math.abs(a.y - b.y) > 2 ? b.y - a.y : a.x - b.x));
    const pageLines: (TextLine & { end: number })[] = [];
    let previous: (TextLine & { end: number }) | undefined;
    for (const segment of segments) {
      if (
        previous &&
        Math.abs(previous.y - segment.y) <= 2 &&
        segment.x >= previous.x &&
        segment.x - previous.end < Math.max(12, segment.size * 2) &&
        Math.abs(previous.size - segment.size) < 1
      ) {
        previous.title +=
          (segment.x - previous.end > segment.size * 0.15 ? ' ' : '') + segment.title;
        previous.end = segment.x + segment.width;
      } else {
        previous = {
          ...segment,
          emphasis: false,
          page: number,
          height: page.view[3] - page.view[1],
          end: segment.x + segment.width,
        };
        pageLines.push(previous);
      }
    }
    for (const line of pageLines) line.emphasis = allCapitals(line.title);
    const mid = (page.view[0] + page.view[2]) / 2;
    const columns =
      pageLines.filter((line) => line.x < mid && line.end < mid + 8).length >= 5 &&
      pageLines.filter((line) => line.x > mid).length >= 5;
    if (columns) {
      // A spanning heading starts a new band. Within a band read the left
      // column before the right, rather than interleaving equal-height lines.
      let band: typeof pageLines = [];
      const flush = () => {
        lines.push(...band.sort((a, b) => Number(a.x > mid) - Number(b.x > mid) || b.y - a.y));
        band = [];
      };
      for (const line of pageLines) {
        if (line.x < mid && line.end > mid + 24) {
          flush();
          lines.push(line);
        } else band.push(line);
      }
      flush();
    } else lines.push(...pageLines);
    progress(number);
    // Yield between pages so scanning never occupies a long synchronous render task.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  signal.throwIfAborted();
  return normalizeOutline({
    version: 1,
    source: 'detected',
    customized: false,
    entries: detectHeadings(lines, pdf.numPages),
  });
}

export function visibleHeadings(entries: PdfHeading[], collapsed: Set<string>, query: string) {
  const text = query.trim().toLocaleLowerCase();
  let foldedLevel = Infinity;
  return entries.filter((entry) => {
    if (entry.hidden) return false;
    if (text) return entry.title.toLocaleLowerCase().includes(text);
    if (entry.level <= foldedLevel) foldedLevel = Infinity;
    if (entry.level > foldedLevel) return false;
    if (collapsed.has(entry.id)) foldedLevel = entry.level;
    return true;
  });
}

/** A chapter moves as a subtree, so correcting its depth never strands its children. */
export function changeHeadingLevel(entries: PdfHeading[], id: string, delta: number) {
  const index = entries.findIndex((entry) => entry.id === id);
  if (index < 0) return entries;
  const level = entries[index].level;
  if (delta > 0 && (index === 0 || entries[index - 1].level < level)) return entries;
  let end = index + 1;
  while (end < entries.length && entries[end].level > level) end++;
  if (level + delta < 0 || entries.slice(index, end).some((entry) => entry.level + delta > 5))
    return entries;
  return entries.map((entry, i) =>
    i >= index && i < end ? { ...entry, level: entry.level + delta } : entry,
  );
}
