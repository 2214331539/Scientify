import { t, translateError } from '../i18n';
import { Button, Input } from '../components/primitives';
import { useCallback, useEffect, useRef, useState } from 'react';
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
} from 'lucide-react';
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import 'pdfjs-dist/web/pdf_viewer.css';
import type { ResearchBackend } from '../platform/research';
import type { WorkContext } from '../domain/context';
import { PdfPageSurface } from './PdfPageSurface';
import './reader.css';

GlobalWorkerOptions.workerSrc = workerUrl;
type ReadingMode = 'paged' | 'continuous';
// top is the offset inside the current page, not the whole continuous document.
type ReadingPosition = { page: number; zoom: number; top: number; left: number; mode: ReadingMode };
const readingPositions = new WeakMap<ResearchBackend, Map<string, ReadingPosition>>();
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
  backend: ResearchBackend;
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
  function navigate(number: number) {
    if (!document || number < 1 || number > document.numPages || !Number.isInteger(number)) return;
    pendingScroll.current = { ...position.current, page: number, top: 0, left: 0 };
    position.current = { ...pendingScroll.current };
    setPage(number);
    requestAnimationFrame(() => restore(true));
  }
  function toggleMode() {
    const next: ReadingMode = mode === 'paged' ? 'continuous' : 'paged';
    pendingScroll.current = { ...position.current, mode: next };
    setMode(next);
    try {
      localStorage.setItem('scientify.reader.mode', next);
    } catch {
      /* Optional preference. */
    }
  }
  function changeZoom(next: number) {
    if (next === zoom) return;
    pendingScroll.current = { ...position.current };
    setZoom(next);
  }
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
    const observer = new ResizeObserver((entries) => {
      const next = Math.max(240, entries[0].contentRect.width - 48);
      setWidth((previous) => {
        if (previous !== next) pendingScroll.current ??= { ...position.current };
        return next;
      });
    });
    observer.observe(host);
    return () => observer.disconnect();
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
        setPage(firstPage);
        setLoading(false);
      })
      .catch((error) => {
        if (!stale) {
          setError(error instanceof Error ? error.message : String(error));
          setLoading(false);
        }
      });
    return () => {
      stale = true;
      void task?.destroy();
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
        {mode === 'continuous' ? t('连续滚动') : t('分页阅览')}
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
