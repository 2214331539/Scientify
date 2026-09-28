import { useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { ChevronRight, FileText, Folder } from 'lucide-react';
import { Button } from '../primitives';
import './tree-view.css';

export interface TreeItem {
  id: string;
  label: string;
  children?: TreeItem[];
  icon?: ReactNode;
  tooltip?: string;
  draggable?: boolean;
}

interface Props {
  items: TreeItem[];
  label: string;
  selectedId?: string | null;
  dropTargetId?: string | null;
  collapsed: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onOpen: (id: string) => void;
  onContextMenu?: (id: string, event: MouseEvent<HTMLButtonElement>) => void;
}

/** Selection opens a resource; focus and disclosure only navigate the hierarchy. */
export function TreeView({
  items,
  label,
  selectedId,
  dropTargetId,
  collapsed,
  onToggle,
  onOpen,
  onContextMenu,
}: Props) {
  const [focused, setFocused] = useState<string | null>(null);
  const elements = useRef(new Map<string, HTMLButtonElement>());
  const visible: {
    item: TreeItem;
    parent?: string;
    depth: number;
    position: number;
    size: number;
  }[] = [];
  function collect(nodes: TreeItem[], parent?: string, depth = 0) {
    nodes.forEach((item, position) => {
      visible.push({ item, parent, depth, position, size: nodes.length });
      if (item.children && !collapsed.has(item.id)) collect(item.children, item.id, depth + 1);
    });
  }
  collect(items);
  const tabStop =
    [focused, selectedId].find((id) => visible.some((row) => row.item.id === id)) ??
    visible[0]?.item.id;
  const focus = (id?: string) => {
    if (!id) return;
    setFocused(id);
    elements.current.get(id)?.focus();
  };
  return (
    <div role="tree" aria-label={label} className="sf-tree">
      {visible.map(({ item, depth, position, size }) => {
        const folder = item.children !== undefined;
        const expanded = folder && !collapsed.has(item.id);
        return (
          <Button
            key={item.id}
            type="button"
            variant="ghost"
            role="treeitem"
            data-tree-id={item.id}
            data-drop-target={item.id === dropTargetId ? 'true' : undefined}
            draggable={item.draggable}
            className="sf-tree-row"
            ref={(element) => {
              if (element) elements.current.set(item.id, element);
              else elements.current.delete(item.id);
            }}
            aria-label={item.label}
            tooltip={item.tooltip ?? item.id}
            aria-level={depth + 1}
            aria-posinset={position + 1}
            aria-setsize={size}
            aria-expanded={folder ? expanded : undefined}
            aria-selected={selectedId === item.id}
            tabIndex={item.id === tabStop ? 0 : -1}
            style={{ paddingLeft: 8 + depth * 16 }}
            onFocus={() => setFocused(item.id)}
            onClick={() => (folder ? onToggle(item.id) : onOpen(item.id))}
            onContextMenu={(event) => {
              if (!onContextMenu) return;
              event.preventDefault();
              event.stopPropagation();
              onContextMenu?.(item.id, event);
            }}
            onKeyDown={(event) => {
              const index = visible.findIndex((row) => row.item.id === item.id);
              if (event.key === 'ArrowDown') focus(visible[index + 1]?.item.id);
              else if (event.key === 'ArrowUp') focus(visible[index - 1]?.item.id);
              else if (event.key === 'Home') focus(visible[0]?.item.id);
              else if (event.key === 'End') focus(visible.at(-1)?.item.id);
              else if (event.key === 'ArrowRight') {
                if (folder && !expanded) onToggle(item.id);
                else if (folder) focus(item.children?.[0]?.id);
              } else if (event.key === 'ArrowLeft') {
                if (expanded) onToggle(item.id);
                else focus(visible[index]?.parent);
              } else return;
              event.preventDefault();
            }}
          >
            <span className="sf-tree-disclosure" aria-hidden="true">
              {folder ? <ChevronRight /> : null}
            </span>
            <span className="sf-tree-icon" aria-hidden="true">
              {item.icon ?? (folder ? <Folder /> : <FileText />)}
            </span>
            <span className="sf-tree-label">{item.label}</span>
          </Button>
        );
      })}
    </div>
  );
}
