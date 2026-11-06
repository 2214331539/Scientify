import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { ChevronRight, ListTree, MoreHorizontal, Pin, Search, X } from 'lucide-react';
import { Button, Input } from '../components/primitives';
import { Menu, menuAnchor, type MenuAnchor } from '../components/primitives/Menu';
import { confirmAction, requestText } from '../components/prompts';
import { t, translateError } from '../i18n';
import { errorMessage } from '../domain/errors';
import { outlineMetadata } from '../platform/reader';
import {
  changeHeadingLevel,
  normalizeOutline,
  readPdfOutline,
  visibleHeadings,
  type PdfHeading,
  type PdfOutline,
} from './pdf-outline';
import { destinationOffset } from './pdf-links';

export function PdfOutlinePanel({
  pdf,
  page,
  scroll,
  scrollTop,
  width,
  zoom,
  selection,
  selectionPage,
  onNavigate,
}: {
  pdf: PDFDocumentProxy;
  page: number;
  /** The reading area; the panel follows its scrolling only while it is open. */
  scroll: RefObject<HTMLDivElement | null>;
  /** Offset of the reading position within the current page. */
  scrollTop(): number;
  width: number;
  zoom: number;
  selection: string;
  selectionPage: number;
  onNavigate(entry: PdfHeading): void;
}) {
  const [outline, setOutline] = useState<PdfOutline | null>(null);
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [top, setTop] = useState(0);
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const [progress, setProgress] = useState(0);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [menu, setMenu] = useState<{ anchor: MenuAnchor; entry?: PdfHeading } | null>(null);
  const [offsets, setOffsets] = useState(new Map<string, number>());
  const root = useRef<HTMLDivElement>(null);
  const revision = useRef<string | null>(null);
  const fingerprint = pdf.fingerprints?.[1] ?? pdf.fingerprints?.[0];
  const session = useRef(0);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const controller = new AbortController();
    const ticket = ++session.current;
    setOutline(null);
    setError('');
    setProgress(0);
    setCollapsed(new Set());
    setBusy(true);
    async function load() {
      revision.current = null;
      if (fingerprint) {
        const record = await outlineMetadata(fingerprint);
        if (controller.signal.aborted) return;
        revision.current = record.revision;
        if (record.outline) {
          setOutline(record.outline);
          return;
        }
      }
      const next = await readPdfOutline(pdf, controller.signal, setProgress);
      if (controller.signal.aborted) return;
      setOutline(next);
      if (fingerprint) {
        try {
          const saved = await outlineMetadata(fingerprint, next, revision.current);
          if (!controller.signal.aborted) revision.current = saved.revision;
        } catch {
          // Another window saved this PDF's outline first: adopt it.
          const record = await outlineMetadata(fingerprint);
          if (controller.signal.aborted) return;
          revision.current = record.revision;
          if (record.outline) setOutline(record.outline);
        }
      }
    }
    void load()
      .catch((reason) => {
        if (!controller.signal.aborted && ticket === session.current)
          setError(errorMessage(reason));
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => {
      controller.abort();
      ++session.current;
    };
  }, [pdf, fingerprint, reload]);

  useEffect(() => {
    let stale = false;
    void pdf
      .getPage(page)
      .then((pdfPage) => {
        const original = pdfPage.getViewport({ scale: 1 });
        const scale = Math.max(0.25, Math.min(3, width / original.width)) * zoom;
        const viewport = pdfPage.getViewport({ scale });
        if (!stale)
          setOffsets(
            new Map(
              (outline?.entries ?? [])
                .filter((entry) => entry.page === page)
                .map((entry) => [entry.id, destinationOffset(viewport, entry.destination).top]),
            ),
          );
      })
      .catch((reason) => {
        if (!stale) setError(errorMessage(reason));
      });
    return () => {
      stale = true;
    };
  }, [pdf, page, width, zoom, outline]);

  useEffect(() => {
    if (!open || pinned || menu) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', outside);
    return () => window.removeEventListener('pointerdown', outside);
  }, [open, pinned, menu]);
  useEffect(() => () => clearTimeout(hideTimer.current), []);
  useEffect(() => {
    const host = scroll.current;
    if (!open || !host) return;
    // Track the reading position only while the panel is visible, once per frame.
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setTop(scrollTop()));
    };
    update();
    host.addEventListener('scroll', update, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      host.removeEventListener('scroll', update);
    };
  }, [open, scroll, scrollTop, page]);

  async function save(value: PdfOutline) {
    const next = normalizeOutline(value);
    const ticket = session.current;
    setBusy(true);
    setError('');
    try {
      if (fingerprint) {
        const saved = await outlineMetadata(fingerprint, next, revision.current);
        if (ticket !== session.current) return;
        revision.current = saved.revision;
      }
      if (ticket === session.current) {
        setOutline(next);
        setOpen(true);
      }
    } catch (reason) {
      if (ticket === session.current) setError(errorMessage(reason));
    } finally {
      if (ticket === session.current) setBusy(false);
    }
  }
  async function rename(entry: PdfHeading) {
    const ticket = session.current;
    const title = await requestText(t('重命名标题'), entry.title);
    if (ticket === session.current && title?.trim() && outline)
      await save({
        ...outline,
        customized: true,
        entries: outline.entries.map((item) =>
          item.id === entry.id ? { ...item, title: title.trim() } : item,
        ),
      });
  }
  function edit(entry: PdfHeading, operation: 'up' | 'down' | 'hide') {
    if (!outline) return;
    const entries =
      operation === 'hide'
        ? outline.entries.map((item) => (item.id === entry.id ? { ...item, hidden: true } : item))
        : changeHeadingLevel(outline.entries, entry.id, operation === 'up' ? -1 : 1);
    void save({ ...outline, customized: true, entries });
  }
  async function rebuild() {
    const ticket = session.current;
    if (
      outline?.customized &&
      !(await confirmAction(t('重新识别会替换手动修正的目录，是否继续？')))
    )
      return;
    if (ticket !== session.current) return;
    setBusy(true);
    setError('');
    const controller = new AbortController();
    // A rebuild is also cancelled if this document is replaced or unmounted.
    rebuildController.current?.abort();
    rebuildController.current = controller;
    setProgress(0);
    setScanning(true);
    try {
      const next = await readPdfOutline(pdf, controller.signal, setProgress);
      if (ticket !== session.current) return;
      setScanning(false);
      await save(next);
    } catch (reason) {
      if (!controller.signal.aborted && ticket === session.current) setError(errorMessage(reason));
    } finally {
      if (ticket === session.current) {
        setScanning(false);
        setBusy(false);
      }
    }
  }
  const rebuildController = useRef<AbortController | null>(null);
  useEffect(() => () => rebuildController.current?.abort(), [pdf]);

  const entries = useMemo(() => outline?.entries ?? [], [outline]);
  const indexOf = useMemo(
    () => new Map(entries.map((entry, index) => [entry.id, index])),
    [entries],
  );
  const shown = visibleHeadings(entries, collapsed, query);
  const active = useMemo(() => {
    if (!open) return undefined;
    let id: string | undefined;
    for (const entry of entries)
      if (
        !entry.hidden &&
        (entry.page < page || (entry.page === page && (offsets.get(entry.id) ?? 0) <= top + 48))
      )
        id = entry.id;
    return id;
  }, [open, entries, page, offsets, top]);
  function hasChildren(entry: PdfHeading) {
    const index = indexOf.get(entry.id) ?? -1;
    for (let next = index + 1; next < entries.length; next++) {
      if (entries[next].level <= entry.level) return false;
      if (!entries[next].hidden) return true;
    }
    return false;
  }
  function close() {
    clearTimeout(hideTimer.current);
    // Commit first: a pinned panel hides its trigger, which cannot take focus until then.
    flushSync(() => {
      setOpen(false);
      setPinned(false);
    });
    root.current
      ?.querySelector<HTMLButtonElement>('.pdf-outline-trigger')
      ?.focus({ preventScroll: true });
  }
  function show() {
    clearTimeout(hideTimer.current);
    setOpen(true);
  }
  return (
    <div
      ref={root}
      className={`pdf-outline-dock${pinned ? ' is-pinned' : ''}`}
      data-open={open}
      onMouseEnter={() => {
        clearTimeout(hideTimer.current);
        hideTimer.current = setTimeout(show, 160);
      }}
      onMouseLeave={() => {
        clearTimeout(hideTimer.current);
        if (!pinned && !menu && !root.current?.contains(document.activeElement))
          hideTimer.current = setTimeout(() => setOpen(false), 250);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !menu) {
          event.stopPropagation();
          close();
        }
      }}
    >
      <Button
        variant="ghost"
        iconOnly
        className="pdf-outline-trigger"
        aria-label={t('打开标题目录')}
        aria-expanded={open}
        onClick={() => {
          clearTimeout(hideTimer.current);
          setOpen((value) => !value);
          setPinned(false);
        }}
      >
        <ListTree size={16} />
      </Button>
      <aside
        className="pdf-outline-panel"
        aria-label={t('PDF 标题目录')}
        data-open={open}
        inert={!open}
        aria-hidden={!open || undefined}
      >
        <div className="pdf-outline-heading">
          <strong>{t('标题目录')}</strong>
          <span className="spacer" />
          <Button
            variant="ghost"
            iconOnly
            title={t('固定目录')}
            aria-label={t('固定目录')}
            aria-pressed={pinned}
            onClick={() => setPinned((value) => !value)}
          >
            <Pin size={14} />
          </Button>
          <Button
            variant="ghost"
            iconOnly
            aria-label={t('目录选项')}
            onClick={(event) => setMenu({ anchor: menuAnchor(event) })}
          >
            <MoreHorizontal size={15} />
          </Button>
          <Button variant="ghost" iconOnly aria-label={t('关闭目录')} onClick={close}>
            <X size={15} />
          </Button>
        </div>
        <label className="pdf-outline-search">
          <Search size={14} />
          <Input
            aria-label={t('搜索标题')}
            placeholder={t('搜索标题')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        {error && (
          <div role="alert" className="pdf-outline-message">
            {translateError(error)}
            <Button variant="ghost" onClick={() => setReload((value) => value + 1)}>
              {t('重新载入')}
            </Button>
          </div>
        )}
        {!outline && !error ? (
          <div className="pdf-outline-message" role="status">
            {t('正在识别标题…')} {progress > 0 ? `${progress} / ${pdf.numPages}` : ''}
          </div>
        ) : null}
        <nav className="pdf-outline-items" aria-label={t('章节导航')}>
          {shown.map((entry) => {
            const folds = hasChildren(entry);
            return (
              <div
                key={entry.id}
                className={`pdf-outline-row${entry.id === active ? ' is-active' : ''}`}
                style={{ paddingInlineStart: Math.min(5, entry.level) * 12 + 4 }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setMenu({ anchor: menuAnchor(event), entry });
                }}
              >
                <button
                  type="button"
                  className="pdf-outline-fold"
                  aria-label={t('展开或收起 {title}', { title: entry.title })}
                  aria-expanded={folds ? !collapsed.has(entry.id) : undefined}
                  disabled={!folds || !!query}
                  onClick={() =>
                    setCollapsed((previous) => {
                      const next = new Set(previous);
                      if (next.has(entry.id)) next.delete(entry.id);
                      else next.add(entry.id);
                      return next;
                    })
                  }
                >
                  {folds ? (
                    <ChevronRight
                      size={12}
                      style={{ transform: collapsed.has(entry.id) ? undefined : 'rotate(90deg)' }}
                    />
                  ) : null}
                </button>
                <button
                  type="button"
                  className="pdf-outline-link"
                  aria-label={entry.title}
                  aria-current={entry.id === active ? 'location' : undefined}
                  onClick={() => {
                    onNavigate(entry);
                    if (!pinned) setOpen(false);
                  }}
                  title={entry.title}
                >
                  <span>{entry.title}</span>
                  <small>{entry.page}</small>
                </button>
                <Button
                  variant="ghost"
                  iconOnly
                  className="pdf-outline-more"
                  aria-label={t('管理标题 {title}', { title: entry.title })}
                  onClick={(event) => setMenu({ anchor: menuAnchor(event), entry })}
                >
                  <MoreHorizontal size={13} />
                </Button>
              </div>
            );
          })}
          {outline && !shown.length ? (
            <div className="pdf-outline-message">
              {query
                ? t('没有匹配的标题')
                : entries.length
                  ? t('标题都已隐藏，可在目录选项里恢复。')
                  : t('未识别到标题。可选中原文后手动加入目录；扫描件需要 OCR。')}
            </div>
          ) : null}
        </nav>
        <div className="pdf-outline-footer">
          {outline?.source === 'bookmarks' ? t('来自 PDF 书签') : t('本地标题识别')}
          {outline?.customized ? ` · ${t('已修正')}` : ''}
          {scanning
            ? ` · ${t('正在识别标题…')} ${progress ? `${progress} / ${pdf.numPages}` : ''}`
            : busy && outline
              ? ` · ${t('保存中…')}`
              : ''}
        </div>
      </aside>
      <Menu anchor={menu?.anchor ?? null} label={t('目录选项')} onClose={() => setMenu(null)}>
        {menu?.entry ? (
          <>
            <button role="menuitem" disabled={busy} onClick={() => void rename(menu.entry!)}>
              {t('重命名标题')}
            </button>
            <button
              role="menuitem"
              disabled={busy || menu.entry.level === 0}
              onClick={() => edit(menu.entry!, 'up')}
            >
              {t('提升层级')}
            </button>
            <button
              role="menuitem"
              disabled={
                busy ||
                menu.entry.level >= 5 ||
                indexOf.get(menu.entry.id) === 0 ||
                (entries[(indexOf.get(menu.entry.id) ?? 0) - 1]?.level ?? -1) < menu.entry.level
              }
              onClick={() => edit(menu.entry!, 'down')}
            >
              {t('降低层级')}
            </button>
            <button role="menuitem" disabled={busy} onClick={() => edit(menu.entry!, 'hide')}>
              {t('隐藏此标题')}
            </button>
          </>
        ) : (
          <>
            <button
              role="menuitem"
              disabled={busy || !outline}
              onClick={() => setCollapsed(new Set())}
            >
              {t('展开全部')}
            </button>
            <button
              role="menuitem"
              disabled={busy || !outline}
              onClick={() => setCollapsed(new Set(entries.map((entry) => entry.id)))}
            >
              {t('收起全部')}
            </button>
            <button
              role="menuitem"
              disabled={busy || !outline || !selection.trim()}
              onClick={() => {
                if (!outline) return;
                const entry: PdfHeading = {
                  id: crypto.randomUUID(),
                  title: selection,
                  level: 0,
                  page: selectionPage,
                };
                // Insert after the headings up to that page; never reorder the rest.
                const at = entries.findIndex((item) => item.page > selectionPage);
                const next = [...entries];
                next.splice(at < 0 ? next.length : at, 0, entry);
                void save({ ...outline, customized: true, entries: next });
              }}
            >
              {t('将选中文字加入目录')}
            </button>
            <button
              role="menuitem"
              disabled={busy || !outline?.entries.some((entry) => entry.hidden)}
              onClick={() =>
                outline &&
                void save({
                  ...outline,
                  customized: true,
                  entries: entries.map((entry) => ({ ...entry, hidden: false })),
                })
              }
            >
              {t('恢复隐藏标题')}
            </button>
            <button role="menuitem" disabled={busy} onClick={() => void rebuild()}>
              {t('重新识别标题')}
            </button>
          </>
        )}
      </Menu>
    </div>
  );
}
