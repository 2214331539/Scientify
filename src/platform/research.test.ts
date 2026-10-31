import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nativeResearch, type AIRequest, type ChatResult } from './research';

const ipc = vi.hoisted(() => ({
  invoke: vi.fn(),
  channels: [] as {
    onmessage(event: { type: 'ready' } | { type: 'delta'; text: string }): void;
  }[],
}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: ipc.invoke,
  Channel: class {
    onmessage = (_event: { type: 'ready' } | { type: 'delta'; text: string }) => {};
    constructor() {
      ipc.channels.push(this);
    }
  },
}));

beforeEach(() => {
  ipc.invoke.mockReset();
  ipc.channels.length = 0;
});

function setup() {
  let resolve!: (result: ChatResult) => void;
  let reject!: (reason: Error) => void;
  const result = new Promise<ChatResult>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  ipc.invoke.mockImplementation((command: string) => {
    if (command === 'research_chat_stream') return result;
    if (command === 'research_chat_cancel') return Promise.resolve();
    throw new Error(`Unexpected IPC command: ${command}`);
  });
  const request: AIRequest = {
    endpoint: 'http://localhost/v1',
    provider: 'openai',
    model: 'test-model',
    messages: [{ role: 'user', content: 'hello' }],
  };
  const onDelta = vi.fn();
  const stream = nativeResearch.streamAI!(request, onDelta);
  return { stream, resolve, reject, onDelta };
}

describe('native chat cancellation handshake', () => {
  it('waits for registration and cancels the same request exactly once', async () => {
    const { stream, resolve, onDelta } = setup();
    const cancelling = stream.cancel();
    await Promise.resolve();
    expect(ipc.invoke).toHaveBeenCalledOnce();
    ipc.channels[0].onmessage({ type: 'ready' });
    await cancelling;
    expect(ipc.invoke).toHaveBeenCalledTimes(2);
    expect(ipc.invoke).toHaveBeenLastCalledWith('research_chat_cancel', {
      requestId: ipc.invoke.mock.calls[0][1].requestId,
    });
    ipc.channels[0].onmessage({ type: 'delta', text: '部分回答' });
    expect(onDelta).toHaveBeenCalledWith('部分回答');
    resolve({ text: '部分回答', interrupted: true });
    await expect(stream.result).resolves.toEqual({ text: '部分回答', interrupted: true });
  });

  it('propagates a deferred cancellation failure and permits retry without losing the stream', async () => {
    const { stream, resolve } = setup();
    const cancelling = stream.cancel();
    const failure = expect(cancelling).rejects.toThrow('IPC disconnected');
    ipc.invoke.mockRejectedValueOnce(new Error('IPC disconnected'));
    ipc.channels[0].onmessage({ type: 'ready' });
    await failure;
    await stream.cancel();
    expect(
      ipc.invoke.mock.calls.filter(([command]) => command === 'research_chat_cancel'),
    ).toHaveLength(2);
    resolve({ text: '保留回答', interrupted: true });
    await expect(stream.result).resolves.toEqual({ text: '保留回答', interrupted: true });
  });

  it('settles both cancellation and the answer when startup fails before registration', async () => {
    const { stream, reject } = setup();
    const answerFailure = expect(stream.result).rejects.toThrow('startup failed');
    const cancelFailure = expect(stream.cancel()).rejects.toThrow('startup failed');
    reject(new Error('startup failed'));
    await Promise.all([answerFailure, cancelFailure]);
    expect(ipc.invoke).toHaveBeenCalledOnce();
  });

  it('cancels after registration without waiting for the model response', async () => {
    const { stream, resolve } = setup();
    ipc.channels[0].onmessage({ type: 'ready' });
    await stream.cancel();
    expect(ipc.invoke).toHaveBeenLastCalledWith('research_chat_cancel', expect.any(Object));
    resolve({ text: '', interrupted: true });
    await stream.result;
  });

  it('keeps registration and cancellation isolated between concurrent streams', async () => {
    const a = setup(),
      b = setup();
    const cancellingA = a.stream.cancel();
    ipc.channels[1].onmessage({ type: 'ready' });
    await b.stream.cancel();
    expect(ipc.invoke).toHaveBeenCalledTimes(3);
    expect(ipc.invoke).toHaveBeenLastCalledWith('research_chat_cancel', {
      requestId: ipc.invoke.mock.calls[1][1].requestId,
    });
    ipc.channels[0].onmessage({ type: 'ready' });
    await cancellingA;
    expect(ipc.invoke).toHaveBeenLastCalledWith('research_chat_cancel', {
      requestId: ipc.invoke.mock.calls[0][1].requestId,
    });
    a.resolve({ text: 'A', interrupted: true });
    b.resolve({ text: 'B', interrupted: true });
    await Promise.all([a.stream.result, b.stream.result]);
  });
});
