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
  await user.click(screen.getByText('/data/code/train.py'));
  expect(onOpenFile).toHaveBeenLastCalledWith('/data/code/train.py');
  await waitFor(() => expect(screen.getByAltText('精度曲线')).toBeTruthy());
  expect(loadImage).toHaveBeenCalledWith('/data/ai/curve.png');
  // Remote pictures are still never loaded.
  expect(screen.queryByAltText('远程')).toBeNull();
  expect(screen.getByText('[图片：远程]')).toBeTruthy();
});
