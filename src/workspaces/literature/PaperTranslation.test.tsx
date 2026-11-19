import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PaperTranslation } from './PaperTranslation';
import {
  arrivedPdfs,
  setAutoTranslate,
  translateArrivals,
} from '../../features/translation/engine';
import type { TranslationEvent, TranslationStatus, Translator } from '../../platform/translator';
import type { WorkspaceStore } from '../../stores/workspace';

const model = {
  provider: 'openai',
  endpoint: 'https://api.example.com/v1',
  model: 'gpt-6-luna',
  apiKey: 'k',
};
vi.mock('../../features/assistant/connections', () => ({
  loadConnectionKey: vi.fn(async () => 'k'),
}));
vi.mock('../../reader/PdfReader', () => ({
  default: ({ title }: { title: string }) => <div aria-label="Translated PDF">{title}</div>,
}));

const paper = { id: 'a', path: 'a.pdf', notePath: 'a.notes.md', fingerprint: 'f'.repeat(64) };
const store = {
  getState: () => ({
    data: {
      settings: { model: { provider: 'openai', endpoint: model.endpoint, model: model.model } },
    },
  }),
} as unknown as WorkspaceStore;

function fakeEngine(initial: TranslationStatus) {
  let emit: ((event: TranslationEvent) => void) | undefined;
  const engine = {
    status: vi.fn(async () => initial),
    request: vi.fn(
      async () => ({ state: 'queued', progress: 0, message: '' }) as TranslationStatus,
    ),
    cancel: vi.fn(async () => {}),
    pdf: vi.fn(async () => new Uint8Array()),
    events: vi.fn(async (callback: (event: TranslationEvent) => void) => {
      emit = callback;
      return () => {};
    }),
  };
  const send = (status: TranslationStatus) =>
    act(() => emit?.({ projectId: 'p', paperId: 'a', fingerprint: paper.fingerprint, status }));
  return { engine: engine as unknown as Translator & typeof engine, send };
}

beforeEach(() => localStorage.clear());
afterEach(() => cleanup());

it('starts a translation, shows its progress and then the translated PDF', async () => {
  const user = userEvent.setup();
  const { engine, send } = fakeEngine({ state: 'idle', progress: 0, message: '' });
  render(
    <PaperTranslation
      projectId="p"
      paper={paper}
      title="Paper"
      store={store}
      readOnly={false}
      engine={engine}
    />,
  );
  await user.click(await screen.findByRole('button', { name: '开始翻译' }));
  expect(engine.request).toHaveBeenCalledWith('p', 'a', model, false);
  expect(await screen.findByText('排队中')).toBeTruthy();
  send({ state: 'translating', progress: 42.4, message: '' });
  expect(screen.getByText('正在翻译 42%')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: '停止' }));
  expect(engine.cancel).toHaveBeenCalledWith('p', 'a');
  send({ state: 'done', progress: 100, message: '' });
  expect(await screen.findByLabelText('Translated PDF')).toBeTruthy();
  expect(screen.getByText('Paper（译文）')).toBeTruthy();
});

it('shows why a translation failed and offers to try again', async () => {
  const { engine } = fakeEngine({
    state: 'failed',
    progress: 0,
    message: '模型账户余额或额度不足。',
  });
  render(
    <PaperTranslation
      projectId="p"
      paper={paper}
      title="Paper"
      store={store}
      readOnly={false}
      engine={engine}
    />,
  );
  expect(await screen.findByText('模型账户余额或额度不足。')).toBeTruthy();
  expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
});

it('translates PDFs that arrive, once, but not an existing library or a bulk import', async () => {
  const { engine } = fakeEngine({ state: 'idle', progress: 0, message: '' });
  const open = vi.fn(async (path: string) => ({ ...paper, id: path, path }));
  // The first look only remembers what is there.
  await translateArrivals('p', ['old.pdf'], open, store, engine);
  expect(engine.request).not.toHaveBeenCalled();
  await translateArrivals('p', ['old.pdf', 'new.pdf'], open, store, engine);
  await waitFor(() => expect(engine.request).toHaveBeenCalledWith('p', 'new.pdf', model));
  expect(engine.request).toHaveBeenCalledTimes(1);
  // An import of many papers at once is left for the user to translate.
  const many = Array.from({ length: 6 }, (_, i) => `bulk-${i}.pdf`);
  await translateArrivals('p', ['old.pdf', 'new.pdf', ...many], open, store, engine);
  expect(engine.request).toHaveBeenCalledTimes(1);
  // Turned off, nothing is translated by itself.
  setAutoTranslate(false);
  await translateArrivals('p', ['old.pdf', 'later.pdf'], open, store, engine);
  expect(engine.request).toHaveBeenCalledTimes(1);
  expect(arrivedPdfs('p', ['old.pdf'])).toEqual([]);
});
