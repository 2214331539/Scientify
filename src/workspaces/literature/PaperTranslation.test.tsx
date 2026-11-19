import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PaperTranslation } from './PaperTranslation';
import type { TranslationEvent, TranslationStatus, Translator } from '../../platform/translator';

vi.mock('../../reader/PdfReader', () => ({
  default: ({ title }: { title: string }) => <div aria-label="Translated PDF">{title}</div>,
}));

const paper = { id: 'a', path: 'a.pdf', notePath: 'a.notes.md', fingerprint: 'f'.repeat(64) };

function fakeEngine(initial: TranslationStatus) {
  let emit: ((event: TranslationEvent) => void) | undefined;
  const engine = {
    status: vi.fn(async () => initial),
    open: vi.fn(async () => initial),
    pdf: vi.fn(async () => new Uint8Array()),
    events: vi.fn(async (callback: (event: TranslationEvent) => void) => {
      emit = callback;
      return () => {};
    }),
  };
  const send = (status: TranslationStatus) =>
    act(() => emit?.({ projectId: 'p', fingerprint: paper.fingerprint, status }));
  return { engine: engine as Translator & typeof engine, send };
}

afterEach(() => cleanup());

it('opening the pane asks for the paper, shows progress quietly, then the translation', async () => {
  const { engine, send } = fakeEngine({ state: 'waiting', progress: 0 });
  render(<PaperTranslation projectId="p" paper={paper} title="Paper" engine={engine} />);
  expect(await screen.findByText('正在翻译…')).toBeTruthy();
  expect(engine.open).toHaveBeenCalledWith('p', 'a');
  // Nothing to press: no start, stop, retry or settings.
  expect(screen.queryByRole('button')).toBeNull();
  send({ state: 'translating', progress: 42.4 });
  expect(screen.getByText('正在翻译 42%')).toBeTruthy();
  send({ state: 'done', progress: 100 });
  expect(await screen.findByLabelText('Translated PDF')).toBeTruthy();
  expect(screen.getByText('Paper（译文）')).toBeTruthy();
});

it('shows a translation that is already there', async () => {
  const { engine } = fakeEngine({ state: 'done', progress: 100 });
  render(<PaperTranslation projectId="p" paper={paper} title="Paper" engine={engine} />);
  expect(await screen.findByLabelText('Translated PDF')).toBeTruthy();
});
