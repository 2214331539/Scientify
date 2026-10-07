import { StrictMode, useEffect, useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ViewTransition, useActiveView } from './ViewTransition';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('retains a single editor and its selection across views without leaving hidden shortcuts active', () => {
  const unmount = vi.fn();
  const shortcut = vi.fn();
  function Editor() {
    const active = useActiveView();
    const [draft, setDraft] = useState('draft');
    useEffect(
      () => () => {
        unmount();
      },
      [],
    );
    useEffect(() => {
      if (!active) return;
      const listener = () => shortcut();
      window.addEventListener('keydown', listener);
      return () => window.removeEventListener('keydown', listener);
    }, [active]);
    return (
      <textarea
        aria-label="draft"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
    );
  }
  const view = render(
    <ViewTransition viewKey="editor">
      <Editor />
    </ViewTransition>,
  );
  const editor = screen.getByRole('textbox', { name: 'draft' }) as HTMLTextAreaElement;
  fireEvent.change(editor, { target: { value: 'unsaved text' } });
  editor.setSelectionRange(2, 8);
  editor.scrollTop = 40;
  fireEvent.keyDown(window, { key: 's' });
  expect(shortcut).toHaveBeenCalledOnce();
  view.rerender(
    <ViewTransition viewKey="other">
      <button>Other</button>
    </ViewTransition>,
  );
  expect(editor.isConnected).toBe(true);
  expect(screen.queryByRole('textbox')).toBeNull();
  fireEvent.keyDown(window, { key: 's' });
  expect(shortcut).toHaveBeenCalledOnce();
  view.rerender(
    <ViewTransition viewKey="editor">
      <Editor />
    </ViewTransition>,
  );
  expect(screen.getByRole('textbox')).toBe(editor);
  expect(editor.value).toBe('unsaved text');
  expect([editor.selectionStart, editor.selectionEnd, editor.scrollTop]).toEqual([2, 8, 40]);
  expect(unmount).not.toHaveBeenCalled();
  view.unmount();
  expect(unmount).toHaveBeenCalledOnce();
});

it('preserves nested visibility and settles correctly through StrictMode setup replay', () => {
  function Nested() {
    const active = useActiveView();
    return <output aria-label="nested active">{String(active)}</output>;
  }
  function NestedView() {
    return (
      <ViewTransition viewKey="child">
        <Nested />
      </ViewTransition>
    );
  }
  const view = render(
    <StrictMode>
      <ViewTransition viewKey="parent">
        <NestedView />
      </ViewTransition>
    </StrictMode>,
  );
  expect(screen.getByLabelText('nested active').textContent).toBe('true');
  view.rerender(
    <StrictMode>
      <ViewTransition viewKey="other">Other</ViewTransition>
    </StrictMode>,
  );
  expect(screen.getByLabelText('nested active').textContent).toBe('false');
  view.rerender(
    <StrictMode>
      <ViewTransition viewKey="parent">
        <NestedView />
      </ViewTransition>
    </StrictMode>,
  );
  expect(screen.getByLabelText('nested active').textContent).toBe('true');
});
