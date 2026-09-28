import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatMessageView } from './ChatMessageView';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('copies the original Markdown including code via keyboard and reports success', async () => {
  const user = userEvent.setup();
  const copy = vi.spyOn(navigator.clipboard, 'writeText');
  const text = '**结论**\n\n```python\nscore = 1\n```';
  render(<ChatMessageView role="assistant" text={text} />);
  const message = screen.getByRole('article', { name: '助手消息' });
  expect(within(message).getByText('结论').tagName).toBe('STRONG');
  await user.tab();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: '复制消息' }));
  await user.keyboard('{Enter}');
  expect(copy).toHaveBeenCalledExactlyOnceWith(text);
  expect(screen.getByRole('status').textContent).toBe('已复制');
});

it('reports clipboard failure locally and allows retry without changing the message', async () => {
  const user = userEvent.setup();
  const copy = vi
    .spyOn(navigator.clipboard, 'writeText')
    .mockRejectedValueOnce(new Error('Permission denied'))
    .mockResolvedValueOnce();
  render(<ChatMessageView role="user" text="请保留这段问题" />);
  const button = screen.getByRole('button', { name: '复制消息' });
  await user.click(button);
  expect(screen.getByRole('status').textContent).toBe('复制失败，请重试');
  expect(screen.getByText('请保留这段问题')).toBeTruthy();
  await user.click(button);
  expect(copy).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('status').textContent).toBe('已复制');
});
