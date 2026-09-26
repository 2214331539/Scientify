import { useState } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { TreeView, type TreeItem } from './TreeView';

afterEach(cleanup);

const items: TreeItem[] = [
  { id: 'paper', label: 'Paper', children: [{ id: 'paper/main.tex', label: 'main.tex' }] },
  { id: 'notes.md', label: 'notes.md' },
];

it('keeps a single tab stop and opens files only on explicit activation', async () => {
  const user = userEvent.setup();
  const open = vi.fn();
  function Example() {
    const [collapsed, setCollapsed] = useState(new Set(['paper']));
    return (
      <TreeView
        items={items}
        label="项目文件"
        collapsed={collapsed}
        onOpen={open}
        onToggle={(id) =>
          setCollapsed((current) => {
            const next = new Set(current);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
          })
        }
      />
    );
  }
  render(<Example />);
  await user.tab();
  expect(document.activeElement).toBe(screen.getByRole('treeitem', { name: 'Paper' }));
  await user.keyboard('{ArrowRight}{ArrowRight}');
  expect(document.activeElement).toBe(screen.getByRole('treeitem', { name: 'main.tex' }));
  expect(open).not.toHaveBeenCalled();
  expect(screen.getAllByRole('treeitem').filter((item) => item.tabIndex === 0)).toHaveLength(1);
  await user.keyboard('{Enter}');
  expect(open).toHaveBeenCalledWith('paper/main.tex');
  await user.keyboard('{ArrowLeft}{ArrowLeft}');
  expect(screen.queryByRole('treeitem', { name: 'main.tex' })).toBeNull();
  await user.keyboard('{End}');
  expect(document.activeElement).toBe(screen.getByRole('treeitem', { name: 'notes.md' }));
});
