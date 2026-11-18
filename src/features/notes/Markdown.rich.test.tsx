import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { Markdown, localPath } from './Markdown';

it('reads local paths from links and image sources', () => {
  expect(localPath('C:\\work\\a.png')).toBe('C:\\work\\a.png');
  expect(localPath('file:///C:/work/my%20chart.png')).toBe('C:/work/my chart.png');
  expect(localPath('file:///home/me/a.csv')).toBe('/home/me/a.csv');
  expect(localPath('/Users/me/out.html')).toBe('/Users/me/out.html');
  expect(localPath('https://example.com/a.png')).toBeNull();
  expect(localPath('//cdn.example.com/a.png')).toBeNull();
});

it('opens a project document linked in an answer', async () => {
  const user = userEvent.setup();
  const opened = vi.fn();
  const listener = (event: Event) => opened((event as CustomEvent).detail);
  window.addEventListener('scientify-open-source', listener);
  render(<Markdown rich>{'见[组会纪要](scientify://docs/p1/page9#b2)。'}</Markdown>);
  await user.click(screen.getByRole('link', { name: '组会纪要' }));
  window.removeEventListener('scientify-open-source', listener);
  expect(opened).toHaveBeenCalledWith(
    expect.objectContaining({ projectId: 'p1', workspace: 'notes', resourceId: 'page9' }),
  );
});

it('opens local files from answers and shows the pictures the AI made', async () => {
  const user = userEvent.setup();
  const onOpenFile = vi.fn();
  const loadImage = vi.fn(async () => new Blob(['png'], { type: 'image/png' }));
  globalThis.URL.createObjectURL ??= () => 'blob:test';
  globalThis.URL.revokeObjectURL ??= () => {};
  render(
    <Markdown rich onOpenFile={onOpenFile} loadImage={loadImage}>
      {[
        '[结果表](</data/ai/results.csv>)',
        '',
        '代码在 `/data/code/train.py`。',
        '',
        '![精度曲线](</data/ai/curve.png>)',
        '',
        '![远程](https://example.com/x.png)',
      ].join('\n')}
    </Markdown>,
  );
  await user.click(screen.getByText('结果表'));
  expect(onOpenFile).toHaveBeenLastCalledWith('/data/ai/results.csv');
  // Paths show as the file's name, with the full path on hover.
  const chip = screen.getByRole('button', { name: 'train.py' });
  expect(chip.getAttribute('title')).toBe('/data/code/train.py');
  await user.click(chip);
  expect(onOpenFile).toHaveBeenLastCalledWith('/data/code/train.py');
  await waitFor(() => expect(screen.getByAltText('精度曲线')).toBeTruthy());
  expect(loadImage).toHaveBeenCalledWith('/data/ai/curve.png');
  // Remote pictures are still never loaded.
  expect(screen.queryByAltText('远程')).toBeNull();
  expect(screen.getByText('[图片：远程]')).toBeTruthy();
});
