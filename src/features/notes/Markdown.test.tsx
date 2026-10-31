import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Markdown } from './Markdown';
import MarkdownPreview from '../../workspaces/files/MarkdownPreview';

afterEach(cleanup);

it('renders inline, display and LaTeX-delimited formulas with accessible MathML', () => {
  const { container } = render(
    <Markdown>{String.raw`Inline $x^2$ and \(\frac{a}{b}\).

$$
\sum_{i=1}^{n} i
$$

\[
\begin{bmatrix}1 & 2 \\ 3 & 4\end{bmatrix}
\]`}</Markdown>,
  );
  expect(container.querySelectorAll('.katex')).toHaveLength(4);
  expect(container.querySelectorAll('.katex-display')).toHaveLength(2);
  expect(container.querySelectorAll('math')).toHaveLength(4);
  expect(container.querySelectorAll('.katex-error')).toHaveLength(0);
});

it('leaves code, escaped delimiters and ordinary links intact', () => {
  const code = String.raw`\(x\) and $y$`;
  const { container } = render(
    <Markdown>
      {'`' +
        code +
        '`\n\n```python\n' +
        code +
        '\n```\n\n' +
        String.raw`\\(literal\\) and [source](https://example.com)`}
    </Markdown>,
  );
  expect(container.querySelectorAll('.katex')).toHaveLength(0);
  expect(container.querySelector('pre code')?.textContent).toBe(code + '\n');
  expect(screen.getByRole('link', { name: 'source' }).getAttribute('href')).toBe(
    'https://example.com',
  );
});

it('routes clicked web sources to the application browser and keeps page links independent', () => {
  const onLink = vi.fn();
  const onPage = vi.fn();
  render(
    <Markdown onLink={onLink} onPage={onPage}>
      {'[source](https://example.com/paper) [page](scientify-page:2)'}
    </Markdown>,
  );
  screen.getByRole('link', { name: 'source' }).click();
  expect(onLink).toHaveBeenCalledExactlyOnceWith('https://example.com/paper');
  screen.getByRole('button', { name: 'page' }).click();
  expect(onPage).toHaveBeenCalledExactlyOnceWith(2);
  expect(onLink).toHaveBeenCalledTimes(1);
});

it('survives unfinished streamed math and renders the formula when its delimiter arrives', () => {
  const view = render(<Markdown>{String.raw`Answer \[\frac{1}{2}`}</Markdown>);
  expect(view.container.querySelector('.katex')).toBeNull();
  view.rerender(<Markdown>{String.raw`Answer \[\frac{1}{2}\]`}</Markdown>);
  expect(view.container.querySelector('.katex')).toBeTruthy();
  expect(view.container.querySelector('.katex-error')).toBeNull();
});

it('normalizes the small undelimited TeX fragments providers commonly return', () => {
  const { container } = render(<Markdown>{'The coefficient is {A_b}.'}</Markdown>);
  expect(container.querySelector('.katex')).toBeTruthy();
  expect(container.querySelector('.katex-error')).toBeNull();
});

it('keeps invalid formulas readable and blocks trusted HTML commands and remote images', () => {
  const { container } = render(
    <Markdown>{String.raw`$\frac{$ $\href{javascript:alert(1)}{unsafe}$

![external](https://example.com/tracker.png)
<script>alert(1)</script>`}</Markdown>,
  );
  expect(container.querySelector('.katex-error')?.textContent).toContain('frac');
  expect(container.querySelector('img, script, a[href^="javascript:"]')).toBeNull();
});

it('preserves paper page links beside math and shares formula rendering with file previews', () => {
  const onPage = vi.fn();
  const view = render(<Markdown onPage={onPage}>{'$x$ [page](scientify-page:3)'}</Markdown>);
  screen.getByRole('button', { name: 'page' }).click();
  expect(onPage).toHaveBeenCalledExactlyOnceWith(3);
  view.rerender(
    <MarkdownPreview
      content={String.raw`# Notes

\[E = mc^2\]`}
    />,
  );
  expect(view.container.querySelector('.katex-display')).toBeTruthy();
});
