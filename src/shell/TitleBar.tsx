import { ArrowLeft, ArrowRight, NotebookPen, PanelLeft, Search, Sparkles } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '../components/primitives';
import { BrandMark } from '../components/layout/BrandMark';
import { WindowControls } from '../components/layout/WindowControls';
import { t } from '../i18n';
import { isMacOS } from '../platform/os';
import './titlebar.css';

export type Crumb = { label: string; onClick?: () => void };

/** Where the user is, how to move, and the few entries every page shares. */
export function TitleBar({
  crumbs,
  ready,
  canBack,
  canForward,
  sidebarOpen,
  searchPlaceholder,
  share,
  notifications,
  dock,
  onHome,
  onBack,
  onForward,
  onToggleSidebar,
  onSearch,
}: {
  crumbs: Crumb[];
  ready: boolean;
  canBack: boolean;
  canForward: boolean;
  sidebarOpen: boolean;
  searchPlaceholder: string;
  share?: ReactNode;
  notifications?: ReactNode;
  dock?: {
    tool: 'assistant' | 'notes';
    open: boolean;
    notesAvailable: boolean;
    onTool(tool: 'assistant' | 'notes'): void;
  };
  onHome(): void;
  onBack(): void;
  onForward(): void;
  onToggleSidebar(): void;
  onSearch(): void;
}) {
  const mod = isMacOS() ? '⌘' : 'Ctrl ';
  return (
    <header className="sf-titlebar" data-tauri-drag-region>
      <div className="sf-titlebar-left" data-tauri-drag-region>
        <Button
          variant="ghost"
          iconOnly
          className="sf-titlebar-brand"
          aria-label={t('回到项目中心')}
          onClick={onHome}
        >
          <BrandMark />
        </Button>
        <Button
          variant="ghost"
          iconOnly
          aria-label={sidebarOpen ? t('隐藏侧边栏') : t('显示侧边栏')}
          aria-pressed={sidebarOpen}
          onClick={onToggleSidebar}
        >
          <PanelLeft />
        </Button>
        <Button
          variant="ghost"
          iconOnly
          aria-label={t('后退')}
          disabled={!canBack}
          onClick={onBack}
        >
          <ArrowLeft />
        </Button>
        <Button
          variant="ghost"
          iconOnly
          aria-label={t('前进')}
          disabled={!canForward}
          onClick={onForward}
        >
          <ArrowRight />
        </Button>
        <nav className="sf-crumbs" aria-label={t('当前位置')} data-tauri-drag-region>
          {crumbs.map((crumb, index) => {
            const last = index === crumbs.length - 1;
            return (
              <span key={`${index}:${crumb.label}`} className="sf-crumb-part">
                {index > 0 ? <span className="sf-crumb-sep">/</span> : null}
                {last || !crumb.onClick ? (
                  <span
                    className={last ? 'sf-crumb-here' : 'sf-crumb'}
                    aria-current={last ? 'location' : undefined}
                  >
                    {crumb.label}
                  </span>
                ) : (
                  <button type="button" className="sf-crumb" onClick={crumb.onClick}>
                    {crumb.label}
                  </button>
                )}
              </span>
            );
          })}
        </nav>
      </div>
      <button type="button" className="sf-searchbox" disabled={!ready} onClick={onSearch}>
        <Search />
        <span>{searchPlaceholder}</span>
        <kbd>{`${mod}K`}</kbd>
      </button>
      <div className="sf-titlebar-right" data-tauri-drag-region>
        {share}
        {share ? <span className="sf-titlebar-sep" /> : null}
        {notifications}
        {dock ? (
          <>
            {dock.notesAvailable ? (
              <Button
                id="notes-toggle"
                variant="ghost"
                className="sf-titlebar-tool"
                aria-label={t('研究笔记')}
                aria-pressed={dock.open && dock.tool === 'notes'}
                disabled={!ready}
                onClick={() => dock.onTool('notes')}
              >
                <NotebookPen />
                <span>{t('笔记')}</span>
              </Button>
            ) : null}
            <Button
              id="assistant-toggle"
              variant="ghost"
              className="sf-titlebar-tool"
              aria-label={t('AI 助手')}
              aria-pressed={dock.open && dock.tool === 'assistant'}
              disabled={!ready}
              onClick={() => dock.onTool('assistant')}
            >
              <Sparkles />
              <span>AI</span>
            </Button>
          </>
        ) : null}
        <WindowControls />
      </div>
    </header>
  );
}
