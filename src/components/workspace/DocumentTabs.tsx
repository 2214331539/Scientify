import { useEffect, useRef } from 'react';
import { FileText, Plus, X } from 'lucide-react';
import { Button } from '../primitives';
import { t } from '../../i18n';
import './document-tabs.css';

export function DocumentTabs({
  tabs,
  activeId,
  panelId,
  onSelect,
  onClose,
  onNew,
  label,
  newLabel,
  onContextMenu,
}: {
  tabs: { id: string; title: string }[];
  activeId: string | null;
  panelId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew?: () => void;
  label?: string;
  newLabel?: string;
  onContextMenu?: (id: string, position: { x: number; y: number }) => void;
}) {
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const focusPending = useRef(false);
  const add = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const selected = activeId ? refs.current.get(activeId) : undefined;
    selected?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    if (focusPending.current) {
      (selected ?? add.current)?.focus({ preventScroll: true });
      focusPending.current = false;
    }
  }, [activeId, tabs.length]);
  return (
    <div className="document-tabs">
      <div className="document-tab-list" role="tablist" aria-label={label ?? t('文献标签页')}>
        {tabs.map((tab, index) => (
          <div className={`document-tab ${tab.id === activeId ? 'is-active' : ''}`} key={tab.id}>
            <Button
              variant="ghost"
              role="tab"
              title={tab.title}
              aria-selected={tab.id === activeId}
              aria-controls={panelId}
              tabIndex={tab.id === activeId ? 0 : -1}
              ref={(node) => {
                if (node) refs.current.set(tab.id, node);
                else refs.current.delete(tab.id);
              }}
              onClick={() => onSelect(tab.id)}
              onContextMenu={
                onContextMenu
                  ? (event) => {
                      event.preventDefault();
                      onContextMenu(tab.id, { x: event.clientX, y: event.clientY });
                    }
                  : undefined
              }
              onKeyDown={(event) => {
                if (
                  onContextMenu &&
                  (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))
                ) {
                  event.preventDefault();
                  const bounds = event.currentTarget.getBoundingClientRect();
                  onContextMenu(tab.id, { x: bounds.left, y: bounds.bottom });
                  return;
                }
                let target: string | undefined;
                if (event.key === 'ArrowRight') target = tabs[(index + 1) % tabs.length]?.id;
                else if (event.key === 'ArrowLeft')
                  target = tabs[(index + tabs.length - 1) % tabs.length]?.id;
                else if (event.key === 'Home') target = tabs[0]?.id;
                else if (event.key === 'End') target = tabs.at(-1)?.id;
                else if (event.key === 'Delete') {
                  event.preventDefault();
                  focusPending.current = true;
                  onClose(tab.id);
                  return;
                }
                if (target) {
                  event.preventDefault();
                  refs.current.get(target)?.focus();
                  onSelect(target);
                }
              }}
            >
              <FileText size={14} />
              <span>{tab.title}</span>
            </Button>
            <Button
              variant="ghost"
              iconOnly
              tabIndex={-1}
              aria-label={t('关闭 {name}', { name: tab.title })}
              onClick={() => {
                focusPending.current = true;
                onClose(tab.id);
              }}
            >
              <X size={12} />
            </Button>
          </div>
        ))}
      </div>
      {onNew && (
        <Button
          variant="ghost"
          iconOnly
          className="document-tab-add"
          ref={add}
          aria-label={newLabel ?? t('新建文献标签页')}
          onClick={() => {
            focusPending.current = true;
            onNew();
          }}
        >
          <Plus size={15} />
        </Button>
      )}
    </div>
  );
}
