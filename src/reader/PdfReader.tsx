import { t, translateError } from '../i18n';
import { Button, Input } from '../components/primitives';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Maximize,
  MessageSquare,
  NotebookPen,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { getDocument, GlobalWorkerOptions, TextLayer, type PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import 'pdfjs-dist/web/pdf_viewer.css';
import type { ResearchBackend } from '../platform/research';
import type { WorkContext } from '../domain/context';
import './reader.css';

GlobalWorkerOptions.workerSrc = workerUrl;
type ReadingPosition = { page: number; zoom: number; top: number; left: number };
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
  const scroll = useRef<HTMLDivElement>(null),
    canvas = useRef<HTMLCanvasElement>(null),
    textLayer = useRef<HTMLDivElement>(null);
  const onContextRef = useRef(onContext);
  onContextRef.current = onContext;
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const positionKey = JSON.stringify([projectId, assetId]);
  const [initialPosition] = useState<ReadingPosition>(() => {
    const cached = readingPositions.get(backend)?.get(positionKey);
    let page = cached?.page ?? 1;
    try {
      page = Math.max(
        1,
        Math.trunc(Number(localStorage.getItem(`scientify.reader.${assetId}`)) || page),
      );
    } catch {
      /* Reading location is optional. */
    }
    return {
      page,
      zoom: cached?.zoom ?? 1,
      top: cached?.page === page ? cached.top : 0,
      left: cached?.page === page ? cached.left : 0,
    };
  });
  const [page, setPage] = useState(initialPosition.page);
  const [width, setWidth] = useState(600),
    [zoom, setZoom] = useState(initialPosition.zoom),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [selection, setSelection] = useState('');
  const [size, setSize] = useState({ width: 1, height: 1, scale: 1 });
  const pageText = useRef('');
  const position = useRef(initialPosition);
  const restoreScroll = useRef<ReadingPosition | null>(initialPosition);
  if (position.current.page !== page) {
    position.current = { ...position.current, page, top: 0, left: 0 };
    restoreScroll.current = { ...position.current };
  }
  position.current.zoom = zoom;
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
    const navigate = (event: Event) => {
      const target = (event as CustomEvent<{ paperId: string; page: number }>).detail;
      if (
        target?.paperId === paperId &&
        document &&
        target.page >= 1 &&
        target.page <= document.numPages
      )
        setPage(target.page);
    };
    window.addEventListener('scientify-pdf-page', navigate);
    return () => window.removeEventListener('scientify-pdf-page', navigate);
  }, [paperId, document]);
  useEffect(() => {
    const host = scroll.current;
    if (!host) return;
    const observer = new ResizeObserver((entries) =>
      setWidth(Math.max(240, entries[0].contentRect.width - 48)),
    );
    observer.observe(host);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let stale = false;
    let task: ReturnType<typeof getDocument> | undefined;
    setLoading(true);
    setError('');
    setDocument(null);
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
        setDocument(pdf);
        setPage((p) => Math.min(p, pdf.numPages));
      })
      .catch((e) => {
        if (!stale) {
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      });
    return () => {
      stale = true;
      void task?.destroy();
    };
  }, [assetId, backend]);
  useEffect(() => {
    if (!document) return;
    let stale = false;
    let renderTask:
      ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']> | undefined;
    let layer: TextLayer | undefined;
    setLoading(true);
    setError('');
    setSelection('');
    pageText.current = '';
    onContextRef.current({ projectId, workspace: 'literature', title, resourceId: paperId, page });
    void document
      .getPage(page)
      .then(async (pdfPage) => {
        if (stale || !canvas.current || !textLayer.current) return;
        const base = pdfPage.getViewport({ scale: 1 });
        const scale = Math.max(0.25, Math.min(3, width / base.width)) * zoom;
        const viewport = pdfPage.getViewport({ scale });
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const node = canvas.current;
        node.width = Math.floor(viewport.width * dpr);
        node.height = Math.floor(viewport.height * dpr);
        node.style.width = `${viewport.width}px`;
        node.style.height = `${viewport.height}px`;
        setSize({ width: viewport.width, height: viewport.height, scale });
        textLayer.current.replaceChildren();
        renderTask = pdfPage.render({
          canvas: node,
          viewport,
          transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0],
        });
        // A workspace switch can cancel rendering while text extraction is pending.
        // Observe rejection immediately; the awaited Promise.all below still reports real errors.
        void renderTask.promise.catch(() => undefined);
        const content = await pdfPage.getTextContent();
        if (stale) return;
        pageText.current = content.items
          .map((item) => ('str' in item ? item.str : ''))
          .join(' ')
          .slice(0, 24000);
        layer = new TextLayer({
          textContentSource: content,
          container: textLayer.current!,
          viewport,
        });
        await Promise.all([renderTask.promise, layer.render()]);
        if (stale) return;
        const restore = restoreScroll.current;
        if (restore && scroll.current) {
          scroll.current.scrollTop = restore.page === page ? restore.top : 0;
          scroll.current.scrollLeft = restore.page === page ? restore.left : 0;
          restoreScroll.current = null;
        }
        setLoading(false);
        onContextRef.current({
          projectId,
          workspace: 'literature',
          title,
          resourceId: paperId,
          page,
          text: pageText.current,
        });
        try {
          localStorage.setItem(`scientify.reader.${assetId}`, String(page));
        } catch {
          /* Reading position is optional. */
        }
      })
      .catch((e) => {
        if (!stale && e?.name !== 'RenderingCancelledException') {
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      });
    return () => {
      stale = true;
      renderTask?.cancel();
      layer?.cancel();
    };
  }, [document, page, width, zoom, title, paperId, projectId, assetId]);
  function captureSelection() {
    const selected = window.getSelection();
    if (!selected || !textLayer.current?.contains(selected.anchorNode)) {
      setSelection('');
      return;
    }
    const value = selected.toString().trim().slice(0, 16000);
    setSelection(value);
    onContextRef.current({
      projectId,
      workspace: 'literature',
      title,
      resourceId: paperId,
      page,
      text: pageText.current,
      selection: value || undefined,
    });
  }
  return (
    <div className={`panel-stack pdf-reader${compact ? ' pdf-reader-compact' : ''}`}>
      <div className="toolbar" aria-label={t('PDF 阅读工具')}>
        <Button
          variant="ghost"
          iconOnly
          title={t('上一页')}
          aria-label={t('上一页')}
          disabled={page <= 1 || !document}
          onClick={() => setPage((p) => p - 1)}
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
            onChange={(e) => {
              const n = Number(e.target.value);
              if (document && Number.isInteger(n) && n >= 1 && n <= document.numPages) setPage(n);
            }}
          />
          <span>/ {document?.numPages ?? '—'}</span>
        </label>
        <Button
          variant="ghost"
          iconOnly
          title={t('下一页')}
          aria-label={t('下一页')}
          disabled={!document || page >= document.numPages}
          onClick={() => setPage((p) => p + 1)}
        >
          <ChevronRight />
        </Button>
        <span className="toolbar-separator" />
        <Button
          variant="ghost"
          iconOnly
          title={t('缩小')}
          aria-label={t('缩小 PDF')}
          onClick={() => setZoom((z) => Math.max(0.5, z - 0.15))}
        >
          <ZoomOut />
        </Button>
        <span className="muted">{Math.round(zoom * 100)}%</span>
        <Button
          variant="ghost"
          iconOnly
          title={t('放大')}
          aria-label={t('放大 PDF')}
          onClick={() => setZoom((z) => Math.min(2, z + 0.15))}
        >
          <ZoomIn />
        </Button>
        <Button
          variant="ghost"
          iconOnly
          title={t('适应宽度')}
          aria-label={t('适应宽度')}
          onClick={() => setZoom(1)}
        >
          <Maximize />
        </Button>
        {!compact && (
          <>
            <span className="spacer" />
            <Button
              variant="ghost"
              title={selection ? t('询问选中内容') : t('询问当前页')}
              onClick={() => onTool('assistant')}
            >
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
      {error ? (
        <div role="alert" className="inline-error">
          {translateError(error)}
        </div>
      ) : null}
      <div
        className="pdf-scroll"
        ref={scroll}
        onScroll={(event) => {
          if (!restoreScroll.current) {
            position.current.top = event.currentTarget.scrollTop;
            position.current.left = event.currentTarget.scrollLeft;
          }
        }}
      >
        {loading ? (
          <div className="pdf-loading" role="status">
            {t('正在读取 PDF…')}
          </div>
        ) : null}
        <div
          className="pdf-page"
          style={
            {
              width: size.width,
              height: size.height,
              '--scale-factor': size.scale,
              '--total-scale-factor': size.scale,
            } as CSSProperties
          }
        >
          <canvas ref={canvas} aria-label={t('{title} 第 {page} 页', { title, page })} />
          <div
            className="textLayer"
            ref={textLayer}
            onMouseUp={captureSelection}
            onKeyUp={captureSelection}
          />
        </div>
      </div>
      <div className="pdf-status">
        {selection
          ? t('已选择 {count} 字，可提问或关联到笔记', { count: selection.length })
          : loading
            ? ''
            : pageText.current
              ? t('选择原文可提问或记笔记')
              : t('本页没有可提取文本，可能为扫描页。')}
      </div>
    </div>
  );
}
