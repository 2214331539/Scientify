import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatMessageView } from './ChatMessageView';
import { setPreferences } from '../../i18n/preferences';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setPreferences({ language: 'zh-CN' });
});

it('updates localized controls on a memoized message without rewriting its content', () => {
  render(<ChatMessageView role="assistant" text="**科研内容保留**" />);
  act(() => setPreferences({ language: 'en' }));
  expect(screen.getByRole('article', { name: 'Assistant message' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Copy message' })).toBeTruthy();
  expect(screen.getByText('科研内容保留').tagName).toBe('STRONG');
});

it('renders Markdown during streaming and keeps its layout when the turn completes', () => {
  const view = render(
    <ChatMessageView role="assistant" text="**结论**\n\n```python\nscore = 1\n```" streaming />,
  );
  const strong = screen.getByText('结论');
  expect(strong.tagName).toBe('STRONG');
  view.rerender(<ChatMessageView role="assistant" text="**结论**\n\n```python\nscore = 1\n```" />);
  expect(screen.getByText('结论')).toBe(strong);
});

it('copies the original Markdown including code via keyboard and reports success', async () => {
  const user = userEvent.setup();
  const copy = vi.spyOn(navigator.clipboard, 'writeText');
  const text = '**结论**\n\n```python\nscore = 1\n```';
  render(<ChatMessageView role="assistant" text={text} />);
  const message = screen.getByRole('article', { name: '助手消息' });
  expect(within(message).getByText('结论').tagName).toBe('STRONG');
  // The code block has its own copy button and a language label.
  expect(within(message).getByText('python')).toBeTruthy();
  await user.tab();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: '复制代码' }));
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

it('offers regenerate on the last answer and edit on the last question', async () => {
  const user = userEvent.setup();
  const onRegenerate = vi.fn();
  const onEdit = vi.fn();
  const { unmount } = render(
    <ChatMessageView role="assistant" text="答案" onRegenerate={onRegenerate} />,
  );
  await user.click(screen.getByRole('button', { name: '重新生成' }));
  expect(onRegenerate).toHaveBeenCalledOnce();
  unmount();
  render(<ChatMessageView role="user" text="问题" onEdit={onEdit} />);
  await user.click(screen.getByRole('button', { name: '编辑问题' }));
  expect(onEdit).toHaveBeenCalledOnce();
  expect(screen.queryByRole('button', { name: '重新生成' })).toBeNull();
});
