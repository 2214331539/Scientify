import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { TurnFiles } from './TurnDetails';

afterEach(cleanup);

const files = [{ path: 'F:/p/train.py', kind: 'update' as const }];

it('offers to undo the last turn, and says when it was', async () => {
  const onUndo = vi.fn(() => Promise.resolve());
  const { rerender } = render(<TurnFiles files={files} onUndo={onUndo} />);
  await userEvent.click(screen.getByRole('button', { name: '撤销修改' }));
  expect(onUndo).toHaveBeenCalledOnce();
  rerender(<TurnFiles files={files} onUndo={onUndo} undone />);
  expect(screen.queryByRole('button', { name: '撤销修改' })).toBeNull();
  expect(screen.getByText('已撤销')).toBeTruthy();
});
