import { t, translateError } from '../i18n';
import { Button, Input } from '../components/primitives';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Maximize,
  MessageSquare,
  NotebookPen,
  ZoomIn,
  ZoomOut,
  Rows3,
  PanelTop,
  ListTree,
} from 'lucide-react';
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import 'pdfjs-dist/web/pdf_viewer.css';
import type { PdfBackend } from '../platform/research';
import type { WorkContext } from '../domain/context';
import { PdfPageSurface } from './PdfPageSurface';
import { destinationOffset, ReaderLinkService, type PdfLinkTarget } from './pdf-links';
import { errorMessage } from '../domain/errors';
import './reader.css';

GlobalWorkerOptions.workerSrc = workerUrl;
type ReadingMode = 'paged' | 'continuous';
// top is the offset inside the current page, not the whole continuous document.
type ReadingPosition = { page: number; zoom: number; top: number; left: number; mode: ReadingMode };
type PdfOutlineItem = { title: string; dest?: unknown; items?: PdfOutlineItem[] };
const readingPositions = new WeakMap<PdfBackend, Map<string, ReadingPosition>>();
export default function PdfReader({
  assetId,
  title,
  projectId,
  paperId,
  backend,
  onContext,
  onTool,
  compact = false,
}: {
  assetId: string;
  title: string;
  projectId: string;
  paperId: string;
  backend: PdfBackend;
  onContext: (context: WorkContext) => void;
  onTool: (tool: 'assistant' | 'notes') => void;
  compact?: boolean;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const onContextRef = useRef(onContext);
  onContextRef.current = onContext;
  const positionKey = JSON.stringify([projectId, assetId]);
  const [initial] = useState<ReadingPosition>(() => {
    const cached = readingPositions.get(backend)?.get(positionKey);
    let page = cached?.page ?? 1,
      mode: ReadingMode = cached?.mode ?? 'paged';
    try {
      page = Math.max(
        1,
        Math.trunc(Number(localStorage.getItem(`scientify.reader.${assetId}`)) || page),
      );
      if (!cached && localStorage.getItem('scientify.reader.mode') === 'continuous')
        mode = 'continuous';
    } catch {
      /* Optional reading preferences. */
    }
    return {
      page,
      zoom: cached?.zoom ?? 1,
      top: cached?.page === page ? cached.top : 0,
      left: cached?.page === page ? cached.left : 0,
      mode,
    };
  });
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [outline, setOutline] = useState<PdfOutlineItem[]>([]);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [page, setPage] = useState(initial.page),
    [mode, setMode] = useState(initial.mode);
  const [width, setWidth] = useState(600),
    [zoom, setZoom] = useState(initial.zoom);
  const [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [selection, setSelection] = useState('');
  const [visible, setVisible] = useState<Set<number>>(new Set([initial.page]));
  const [pageText, setPageText] = useState('');
  const texts = useRef(new Map<number, string>());
  const position = useRef(initial),
    pendingScroll = useRef<ReadingPosition | null>(initial);
  const navigationTicket = useRef(0);
  const current = useRef({ page, mode });
  current.current = { page, mode };
  position.current = { ...position.current, page, zoom, mode };
  const pageOffset = useCallback((number: number) => {
    if (current.current.mode === 'paged') return 0;
    return (
      scroll.current?.querySelector<HTMLElement>(`[data-pdf-page="${number}"]`)?.offsetTop ?? 0
    );
  }, []);
  const restore = useCallback(
    (complete: boolean) => {
      const target = pendingScroll.current,
        host = scroll.current;
      if (!target || !host) return;
      host.scrollTop = pageOffset(target.page) + target.top;
      host.scrollLeft = target.left;
      if (complete) pendingScroll.current = null;
    },
    [pageOffset],
  );
  useLayoutEffect(() => {
    // Apply the zoom anchor with the preview geometry, without waiting for
    // PDF.js to finish rasterizing the new resolution.
    restore(texts.current.has(current.current.page));
  }, [zoom, width, restore]);
  function navigate(number: number) {
    ++navigationTicket.current;
    if (!document || number < 1 || number > document.numPages || !Number.isInteger(number)) return;
    pendingScroll.current = { ...position.current, page: number, top: 0, left: 0 };
    position.current = { ...pendingScroll.current };
    setPage(number);
    requestAnimationFrame(() => restore(true));
  }
  async function followLink({ pageNumber, destArray }: PdfLinkTarget) {
    const ticket = ++navigationTicket.current;
    if (
      !document ||
      !Number.isInteger(pageNumber) ||
      pageNumber < 1 ||
      pageNumber > document.numPages
    )
      return;
    try {
      const pdfPage = await document.getPage(pageNumber);
      if (ticket !== navigationTicket.current) return;
      const original = pdfPage.getViewport({ scale: 1 });
      const scale = Math.max(0.25, Math.min(3, width / original.width)) * zoom;
      const offset = destinationOffset(pdfPage.getViewport({ scale }), destArray);
      pendingScroll.current = { ...position.current, page: pageNumber, ...offset };
      position.current = { ...pendingScroll.current };
      setPage(pageNumber);
      requestAnimationFrame(() => restore(texts.current.has(pageNumber)));
    } catch (reason) {
      if (ticket === navigationTicket.current) setError(errorMessage(reason));
    }
  }
  async function followOutline(item: PdfOutlineItem) {
    if (!document || item.dest == null) return;
    try {
      const destination =
        typeof item.dest === 'string' ? await document.getDestination(item.dest) : item.dest;
      if (!Array.isArray(destination) || destination.length === 0) return;
      const pageIndex =
        typeof destination[0] === 'number'
          ? destination[0]
          : await document.getPageIndex(destination[0] as never);
      await followLink({
        pageNumber: pageIndex + 1,
        destArray: destination as never,
      });
      setOutlineOpen(false);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }
  const linkCallbacks = useRef({ followLink });
  linkCallbacks.current = { followLink };
  const linkService = useMemo(
    () =>
      document
        ? new ReaderLinkService(document, {
            page: () => current.current.page,
            navigate: (target) => void linkCallbacks.current.followLink(target),
            error: setError,
          })
        : null,
    [document],
  );
  useEffect(() => () => linkService?.setDocument(null), [linkService]);
  function toggleMode() {
    ++navigationTicket.current;
    const next: ReadingMode = mode === 'paged' ? 'continuous' : 'paged';
    pendingScroll.current = { ...position.current, mode: next };
    setMode(next);
    try {
      localStorage.setItem('scientify.reader.mode', next);
    } catch {
      /* Optional preference. */
    }
  }
  const changeZoom = useCallback((value: number, anchor = { x: 0, y: 0 }) => {
    const source = pendingScroll.current ?? position.current;
    const next = Math.round(Math.max(0.5, Math.min(2, value)) * 1000) / 1000;
    if (next === source.zoom) return;
    ++navigationTicket.current;
    const ratio = next / source.zoom;
    pendingScroll.current = {
      ...source,
      zoom: next,
      top: Math.max(0, (source.top + anchor.y) * ratio - anchor.y),
      left: Math.max(0, (source.left + anchor.x) * ratio - anchor.x),
    };
    position.current = { ...pendingScroll.current };
    setZoom(next);
  }, []);
  useEffect(() => {
    const host = scroll.current;
    if (!host) return;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      if (!document || !event.deltaY) return;
      const rect = host.getBoundingClientRect();
      const delta =
        event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? host.clientHeight : 1);
      changeZoom(position.current.zoom * Math.exp(-Math.max(-100, Math.min(100, delta)) * 0.002), {
        x: Math.max(0, event.clientX - rect.left),
        y: Math.max(0, event.clientY - rect.top),
      });
    };
    host.addEventListener('wheel', wheel, { passive: false });
    return () => host.removeEventListener('wheel', wheel);
  }, [changeZoom, document]);
  useEffect(
    () => () => {
      let cache = readingPositions.get(backend);
      if (!cache) {
        cache = new Map();
        readingPositions.set(backend, cache);
      }
      cache.set(positionKey, { ...position.current });
    },
    [backend, positionKey],
  );
  useEffect(() => {
    const handler = (event: Event) => {
      const target = (event as CustomEvent<{ paperId: string; page: number }>).detail;
      if (target?.paperId === paperId) navigate(target.page);
    };
    window.addEventListener('scientify-pdf-page', handler);
    return () => window.removeEventListener('scientify-pdf-page', handler);
  }, [paperId, document]);
  useEffect(() => {
    const host = scroll.current;
    if (!host) return;
    let resizeTimer: ReturnType<typeof setTimeout>;
    const observer = new ResizeObserver((entries) => {
      // ResizeObserver reports the content box, already excluding padding
      // and the scrollbar gutter. Subtracting them again shrinks the page.
      const next = Math.max(1, Math.floor(entries[0].contentRect.width));
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        setWidth((previous) => {
          if (previous !== next) pendingScroll.current ??= { ...position.current };
          return next;
        });
      }, 80);
    });
    observer.observe(host);
    return () => {
      observer.disconnect();
      clearTimeout(resizeTimer);
    };
  }, []);
  useEffect(() => {
    let stale = false;
    let task: ReturnType<typeof getDocument> | undefined;
    setLoading(true);
    setError('');
    setDocument(null);
    texts.current.clear();
    void backend
      .readPdf(assetId)
      .then((bytes) => {
        if (stale) return;
        const base = import.meta.env.BASE_URL + 'pdfjs/';
        task = getDocument({
          data: bytes,
          useSystemFonts: true,
          cMapUrl: base + 'cmaps/',
          cMapPacked: true,
          standardFontDataUrl: base + 'standard_fonts/',
          wasmUrl: base + 'wasm/',
          iccUrl: base + 'iccs/',
        });
        return task.promise;
      })
      .then((pdf) => {
        if (!pdf || stale) return;
        const firstPage = Math.min(position.current.page, pdf.numPages);
        if (pendingScroll.current) pendingScroll.current.page = firstPage;
        setDocument(pdf);
        void pdf
          .getOutline()
          .then((items) => {
            if (!stale) setOutline((items ?? []) as PdfOutlineItem[]);
          })
          .catch(() => {
            if (!stale) setOutline([]);
          });
        setPage(firstPage);
        setLoading(false);
      })
      .catch((error) => {
        if (!stale) {
          setError(errorMessage(error));
          setLoading(false);
        }
      });
    return () => {
      stale = true;
      ++navigationTicket.current;
      void task?.destroy();
      setOutline([]);
    };
  }, [assetId, backend]);
  useEffect(() => {
    setSelection('');
    const text = texts.current.get(page) ?? '';
    setPageText(text);
    onContextRef.current({
      projectId,
      workspace: 'literature',
      title,
      resourceId: paperId,
      page,
      text: text || undefined,
    });
    try {
      localStorage.setItem(`scientify.reader.${assetId}`, String(page));
    } catch {
      /* Optional location. */
    }
  }, [page, projectId, paperId, title, assetId]);
  useEffect(() => {
    if (!document) return;
    restore(texts.current.has(current.current.page));
    if (mode !== 'continuous' || !scroll.current) return;
    // One observer for all placeholders; canvas memory is limited to nearby pages.
    const observer = new IntersectionObserver(
      (entries) => {
        setVisible((previous) => {
          const next = new Set(previous);
          for (const entry of entries) {
            const number = Number((entry.target as HTMLElement).dataset.pdfPage);
            if (entry.isIntersecting) next.add(number);
            else next.delete(number);
          }
          return next;
        });
      },
      { root: scroll.current, rootMargin: '700px 0px' },
    );
    scroll.current.querySelectorAll('[data-pdf-page]').forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, [document, mode, restore]);
  function ready(number: number, text: string) {
    texts.current.set(number, text);
    if (number !== current.current.page) return;
    setPageText(text);
    restore(true);
    onContextRef.current({
      projectId,
      workspace: 'literature',
      title,
      resourceId: paperId,
      page: number,
      text,
    });
  }
  const controls = (
    <div className="toolbar" aria-label={t('PDF 阅读工具')}>
      <Button
        variant="ghost"
        iconOnly
        aria-label={t('上一页')}
        disabled={page <= 1 || !document}
        onClick={() => navigate(page - 1)}
      >
        <ChevronLeft />
      </Button>
      <label className="pdf-page-input">
        <Input
          aria-label={t('页码')}
          type="number"
          min={1}
          max={document?.numPages ?? 1}
          value={page}
          onChange={(e) => navigate(Number(e.target.value))}
        />
        <span>/ {document?.numPages ?? '—'}</span>
      </label>
      <Button
        variant="ghost"
        iconOnly
        aria-label={t('下一页')}
        disabled={!document || page >= document.numPages}
        onClick={() => navigate(page + 1)}
      >
        <ChevronRight />
      </Button>
      <span className="toolbar-separator" />
      <Button
        variant="ghost"
        className="pdf-mode-toggle"
        aria-pressed={mode === 'continuous'}
        aria-label={mode === 'paged' ? t('切换为连续滚动') : t('切换为分页阅览')}
        onClick={toggleMode}
      >
        {mode === 'continuous' ? <Rows3 /> : <PanelTop />}
        <span className="pdf-mode-label">
          {mode === 'continuous' ? t('连续滚动') : t('分页阅览')}
        </span>
      </Button>
      <span className="toolbar-separator" />
      <Button
        variant="ghost"
        iconOnly
        aria-label={t('缩小 PDF')}
        onClick={() => {
          changeZoom(Math.max(0.5, zoom - 0.15));
        }}
      >
        <ZoomOut />
      </Button>
      <span className="muted">{Math.round(zoom * 100)}%</span>
      <Button
        variant="ghost"
        iconOnly
        aria-label={t('放大 PDF')}
        onClick={() => {
          changeZoom(Math.min(2, zoom + 0.15));
        }}
      >
        <ZoomIn />
      </Button>
      <Button
        variant="ghost"
        iconOnly
        aria-label={t('适应宽度')}
        onClick={() => {
          changeZoom(1);
        }}
      >
        <Maximize />
      </Button>
      {!compact && (
        <>
          <span className="spacer" />
          <Button variant="ghost" onClick={() => onTool('assistant')}>
            <MessageSquare />
            {t('提问')}
          </Button>
          <Button variant="ghost" onClick={() => onTool('notes')}>
            <NotebookPen />
            {t('记笔记')}
          </Button>
        </>
      )}
    </div>
  );
  return (
    <div className={`panel-stack pdf-reader${compact ? ' pdf-reader-compact' : ''}`}>
      {error && (
        <div role="alert" className="inline-error">
          {translateError(error)}
        </div>
      )}
      <div
        className={`pdf-scroll${mode === 'continuous' ? ' pdf-continuous' : ''}`}
        ref={scroll}
        aria-label={t('PDF 阅读区域')}
        onScroll={(event) => {
          if (pendingScroll.current) return;
          const host = event.currentTarget;
          let number = current.current.page;
          if (current.current.mode === 'continuous') {
            const line = host.scrollTop + Math.min(host.clientHeight * 0.3, 180);
            for (const node of host.querySelectorAll<HTMLElement>('[data-pdf-page]')) {
              if (node.offsetTop > line) break;
              number = Number(node.dataset.pdfPage);
            }
            setPage(number);
          }
          position.current = {
            ...position.current,
            page: number,
            top: Math.max(0, host.scrollTop - pageOffset(number)),
            left: host.scrollLeft,
          };
        }}
      >
        {document ? (
          <div
            className={`pdf-outline${outlineOpen ? ' is-open' : ''}`}
            onMouseEnter={() => setOutlineOpen(true)}
            onMouseLeave={() => setOutlineOpen(false)}
          >
            <Button
              variant="ghost"
              iconOnly
              className="pdf-outline-trigger"
              aria-label={t('打开标题目录')}
              aria-expanded={outlineOpen}
              onFocus={() => setOutlineOpen(true)}
              onClick={() => setOutlineOpen((open) => !open)}
            >
              <ListTree size={16} />
            </Button>
            {outlineOpen ? (
              <nav className="pdf-outline-panel" aria-label={t('PDF 标题目录')}>
                <div className="pdf-outline-heading">{t('标题目录')}</div>
                {outline.length ? (
                  <div className="pdf-outline-items">
                    {outline.map((item, index) => (
                      <OutlineItem
                        key={`${item.title}-${index}`}
                        item={item}
                        level={0}
                        onNavigate={(entry) => void followOutline(entry)}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="pdf-outline-empty">{t('此 PDF 没有可用的标题目录')}</div>
                )}
              </nav>
            ) : null}
          </div>
        ) : null}
        {loading && (
          <div className="pdf-loading" role="status">
            {t('正在读取 PDF…')}
          </div>
        )}
        {document &&
          (mode === 'paged'
            ? [page]
            : Array.from({ length: document.numPages }, (_, i) => i + 1)
          ).map((number) => (
            <PdfPageSurface
              key={number}
              document={document}
              page={number}
              width={width}
              zoom={zoom}
              title={title}
              linkService={linkService!}
              visible={mode === 'paged' || visible.has(number) || number === page}
              onReady={ready}
              onError={setError}
              onSelection={(page, text, value) => {
                setSelection(value);
                onContextRef.current({
                  projectId,
                  workspace: 'literature',
                  title,
                  resourceId: paperId,
                  page,
                  text,
                  selection: value || undefined,
                });
              }}
            />
          ))}
      </div>
      {controls}
      <div className="pdf-status">
        {selection
          ? t('已选择 {count} 字，可提问或关联到笔记', { count: selection.length })
          : loading
            ? ''
            : pageText
              ? t('选择原文可提问或记笔记')
              : t('本页没有可提取文本，可能为扫描页。')}
      </div>
    </div>
  );
}

function OutlineItem({
  item,
  level,
  onNavigate,
}: {
  item: PdfOutlineItem;
  level: number;
  onNavigate: (item: PdfOutlineItem) => void;
}) {
  return (
    <div className="pdf-outline-entry">
      <button
        type="button"
        className="pdf-outline-link"
        style={{ paddingInlineStart: `${10 + level * 14}px` }}
        onClick={() => onNavigate(item)}
        title={item.title}
      >
        {item.title}
      </button>
      {item.items?.map((child, index) => (
        <OutlineItem
          key={`${child.title}-${index}`}
          item={child}
          level={level + 1}
          onNavigate={onNavigate}
        />
      ))}
    </div>
  );
}
