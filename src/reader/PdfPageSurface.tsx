import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import {
  AnnotationLayer,
  AnnotationType,
  TextLayer,
  type PageViewport,
  type PDFDocumentProxy,
} from 'pdfjs-dist';
import { pdfLinkLabel, type ReaderLinkService } from './pdf-links';
import { t } from '../i18n';
import type { PaperAnnotation } from '../platform/library';
import { annotationAt, toBox, toPdfRects, type PdfRect } from './annotations';

/** A selection on one page: its text, where it is in PDF points and on screen. */
export type PageSelection = { rects: PdfRect[]; box: DOMRect | null };

/** Keep geometry while releasing canvases and text layers far from the viewport. */
export function PdfPageSurface({
  document,
  page,
  width,
  zoom,
  visible,
  title,
  linkService,
  onReady,
  onError,
  onSelection,
  annotations,
  activeAnnotation,
  onAnnotation,
}: {
  document: PDFDocumentProxy;
  page: number;
  width: number;
  zoom: number;
  visible: boolean;
  title: string;
  linkService: ReaderLinkService;
  onReady(page: number, text: string): void;
  onError(message: string): void;
  onSelection(page: number, text: string, selection: string, where?: PageSelection): void;
  /** This page's highlights and notes. */
  annotations?: PaperAnnotation[];
  activeAnnotation?: string | null;
  /** A highlight or note on this page was clicked. */
  onAnnotation?(id: string, at: DOMRect): void;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const [base, setBase] = useState({ width: 600, height: 800 });
  const [loading, setLoading] = useState(true);
  // The page at scale 1: PDF points to CSS pixels and back, rotation included.
  const [unit, setUnit] = useState<PageViewport | null>(null);
  const unitRef = useRef<PageViewport | null>(null);
  useEffect(() => {
    // A drag may end anywhere; the page stops covering itself when it does.
    const stop = () =>
      surface.current?.querySelector('.textLayer.selecting')?.classList.remove('selecting');
    window.addEventListener('mouseup', stop);
    return () => window.removeEventListener('mouseup', stop);
  }, []);
  const callbacks = useRef({ onReady, onError, onSelection });
  callbacks.current = { onReady, onError, onSelection };
  const text = useRef('');
  const painted = useRef<{ node: HTMLDivElement; scale: number; dispose(): void } | null>(null);
  const scale = Math.max(0.25, Math.min(3, width / base.width)) * zoom;
  useLayoutEffect(() => {
    return () => {
      painted.current?.dispose();
      painted.current = null;
      surface.current?.replaceChildren();
    };
  }, [document, page, visible]);
  useLayoutEffect(() => {
    // Resize the complete painted frame before the next paint, including its
    // selection and link hit areas. A sharper replacement is prepared below.
    if (painted.current)
      painted.current.node.style.transform = `scale(${scale / painted.current.scale})`;
  }, [scale]);
  useEffect(() => {
    const host = surface.current;
    if (!visible || !host) return;
    // A render owns its nodes. A cancelled render must never clear or write
    // into the nodes created by a later zoom, resize or page switch.
    const dom = host.ownerDocument;
    const frame = dom.createElement('div');
    frame.className = 'pdf-page-frame';
    const node = dom.createElement('canvas');
    node.setAttribute('aria-label', t('{title} 第 {page} 页', { title, page }));
    const textNode = dom.createElement('div');
    textNode.className = 'textLayer';
    textNode.tabIndex = -1;
    const annotationNode = dom.createElement('div');
    annotationNode.className = 'annotationLayer';
    frame.append(node, textNode, annotationNode);
    let stale = false;
    let renderTask:
      ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']> | undefined;
    let layer: TextLayer | undefined;
    let links: AnnotationLayer | undefined;
    const disposeLinks = () => {
      const current = links;
      links = undefined;
      try {
        current?.destroy();
      } catch (error) {
        console.warn('PDF annotation layer cleanup failed:', error);
      }
    };
    setLoading(!painted.current);
    // Coalesce wheel/resize bursts without ever removing the visible frame.
    let rendering: Promise<void> | undefined;
    const timer = setTimeout(
      () => {
        rendering = document
          .getPage(page)
          .then(async (pdfPage) => {
            if (stale) return;
            const original = pdfPage.getViewport({ scale: 1 });
            setBase({ width: original.width, height: original.height });
            unitRef.current = original;
            setUnit(original);
            const scale = Math.max(0.25, Math.min(3, width / original.width)) * zoom;
            const viewport = pdfPage.getViewport({ scale });
            frame.style.width = `${viewport.width}px`;
            frame.style.height = `${viewport.height}px`;
            frame.style.setProperty('--scale-factor', String(scale));
            frame.style.setProperty('--total-scale-factor', String(scale));
            const dpr = Math.min(window.devicePixelRatio || 1, 2);
            node.width = Math.floor(viewport.width * dpr);
            node.height = Math.floor(viewport.height * dpr);
            node.style.width = `${viewport.width}px`;
            node.style.height = `${viewport.height}px`;
            renderTask = pdfPage.render({
              canvas: node,
              viewport,
              transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0],
            });
            // Text and annotations improve the page but must not prevent its
            // canvas from appearing if one of those PDF.js layers fails.
            const textTask = pdfPage.getTextContent().then(
              (value) => ({ value, error: null }),
              (error: unknown) => ({ value: null, error }),
            );
            const annotationTask = pdfPage.getAnnotations({ intent: 'display' }).then(
              (value) => ({ value, error: null }),
              (error: unknown) => ({ value: null, error }),
            );
            await renderTask.promise;
            if (stale) return;
            painted.current?.dispose();
            host.replaceChildren(frame);
            painted.current = { node: frame, scale, dispose: disposeLinks };
            setLoading(false);

            const [textResult, annotationResult] = await Promise.all([textTask, annotationTask]);
            if (stale) return;
            if (textResult.error) console.warn('PDF text content failed:', textResult.error);
            if (annotationResult.error)
              console.warn('PDF annotations failed:', annotationResult.error);
            const content = textResult.value;
            const annotations = annotationResult.value ?? [];
            const pageText = (content?.items ?? [])
              .map((item) => ('str' in item ? item.str : ''))
              .join(' ')
              .slice(0, 24000);
            if (content) {
              layer = new TextLayer({
                textContentSource: content,
                container: textNode,
                viewport,
              });
              try {
                await layer.render();
              } catch (error) {
                console.warn('PDF text layer failed:', error);
              }
              // As pdf.js's own viewer does: while a drag is selecting, this block covers
              // the page, so leaving a column does not select the rest of the page.
              const end = dom.createElement('div');
              end.className = 'endOfContent';
              textNode.append(end);
              textNode.addEventListener('mousedown', () => textNode.classList.add('selecting'));
            }
            if (annotations.length) {
              const linkViewport = viewport.clone({ dontFlip: true });
              links = new AnnotationLayer({
                div: annotationNode,
                page: pdfPage,
                viewport: linkViewport,
                linkService,
                accessibilityManager: null,
                annotationCanvasMap: null,
                annotationEditorUIManager: null,
                structTreeLayer: null,
                commentManager: null,
                annotationStorage: null,
              });
              try {
                await links.render({
                  viewport: linkViewport,
                  div: annotationNode,
                  page: pdfPage,
                  linkService,
                  annotations: annotations.filter(
                    (annotation) =>
                      annotation.annotationType === AnnotationType.LINK &&
                      (annotation.url ||
                        annotation.dest ||
                        ['NextPage', 'PrevPage', 'FirstPage', 'LastPage'].includes(
                          annotation.action,
                        )),
                  ),
                  renderForms: false,
                  enableScripting: false,
                });
              } catch (error) {
                console.warn('PDF annotation layer failed:', error);
                disposeLinks();
              }
            }
            if (!stale) {
              for (const link of annotationNode.querySelectorAll('a'))
                link.setAttribute('aria-label', pdfLinkLabel(link));
              text.current = pageText;
              callbacks.current.onReady(page, text.current);
              linkService.eventBus.dispatch('textlayerrendered', {
                pageNumber: page,
                source: {
                  textLayer: {
                    div: { focus: () => textNode.focus({ preventScroll: true }) },
                  },
                },
              });
            }
          })
          .catch((error) => {
            if (!stale && error?.name !== 'RenderingCancelledException') {
              console.error('PDF page render failed:', error);
              setLoading(false);
              callbacks.current.onError(t('PDF 页面渲染失败，请尝试重新打开该文献。'));
            }
          });
      },
      painted.current ? 100 : 0,
    );
    return () => {
      stale = true;
      clearTimeout(timer);
      renderTask?.cancel();
      layer?.cancel();
      // AnnotationLayer has no cancel API. Destroy it after its async work
      // settles. This also releases layers created after the canvas was shown.
      void rendering?.finally(() => {
        layer?.cancel();
        disposeLinks();
      });
    };
  }, [document, page, width, zoom, visible, linkService]);
  function select() {
    const selected = window.getSelection();
    const layer = surface.current?.querySelector<HTMLElement>('.textLayer');
    if (!selected || !layer?.contains(selected.anchorNode)) return;
    const value = selected.toString().trim().slice(0, 16000);
    const where: PageSelection = { rects: [], box: null };
    if (value && selected.rangeCount && unitRef.current) {
      const range = selected.getRangeAt(0);
      const bounds = layer.getBoundingClientRect();
      // Only this page's part of a selection that runs across pages, and not the
      // text layer's own end-of-content block.
      const parts = [...range.getClientRects()].filter(
        (r) =>
          r.height < bounds.height * 0.2 &&
          r.top + r.height / 2 > bounds.top &&
          r.top + r.height / 2 < bounds.bottom,
      );
      where.rects = toPdfRects(parts, bounds, unitRef.current);
      where.box = range.getBoundingClientRect();
    }
    callbacks.current.onSelection(page, text.current, value, where);
  }
  function open(event: ReactMouseEvent<HTMLDivElement>) {
    const layer = surface.current?.querySelector<HTMLElement>('.textLayer') ?? surface.current;
    if (!onAnnotation || !annotations?.length || !unitRef.current || !layer) return;
    if (window.getSelection()?.toString().trim()) return;
    const bounds = layer.getBoundingClientRect();
    const scaleNow = bounds.width / unitRef.current.width;
    const [x, y] = unitRef.current.convertToPdfPoint(
      (event.clientX - bounds.left) / scaleNow,
      (event.clientY - bounds.top) / scaleNow,
    );
    const hit = annotationAt(annotations, page - 1, x, y);
    if (hit) onAnnotation(hit.id, new DOMRect(event.clientX, event.clientY, 0, 0));
  }
  return (
    <div
      className="pdf-page"
      data-pdf-page={page}
      style={
        {
          width: base.width * scale,
          height: base.height * scale,
          '--scale-factor': scale,
          '--total-scale-factor': scale,
        } as CSSProperties
      }
    >
      {visible && (
        <>
          {loading && (
            <span className="pdf-loading" role="status">
              {t('正在读取 PDF…')}
            </span>
          )}
          <div
            className="pdf-page-surface"
            ref={surface}
            onMouseUp={select}
            onKeyUp={select}
            onClick={open}
          />
          {unit && annotations?.length ? (
            <div className="pdf-highlights">
              {annotations.map((annotation) =>
                annotation.kind === 'note' ? (
                  <button
                    key={annotation.id}
                    type="button"
                    className={`pdf-note-pin${annotation.id === activeAnnotation ? ' is-active' : ''}`}
                    aria-label={t('便签：{text}', { text: annotation.comment || annotation.text })}
                    style={
                      {
                        ...toBox(annotation.rects[0] ?? [0, 0, 0, 0], unit, scale),
                        '--highlight': annotation.color,
                      } as CSSProperties
                    }
                    onClick={(event) =>
                      onAnnotation?.(annotation.id, event.currentTarget.getBoundingClientRect())
                    }
                  />
                ) : (
                  // One group per highlight: its line boxes blend as one, so where
                  // they touch the color does not darken.
                  <span
                    key={annotation.id}
                    className={`pdf-highlight-group is-${annotation.kind}${
                      annotation.id === activeAnnotation ? ' is-active' : ''
                    }`}
                    style={{ '--highlight': annotation.color } as CSSProperties}
                  >
                    {annotation.rects.map((rect, index) => (
                      <span
                        key={index}
                        className="pdf-highlight"
                        data-annotation={index === 0 ? annotation.id : undefined}
                        style={toBox(rect, unit, scale)}
                      />
                    ))}
                  </span>
                ),
              )}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
