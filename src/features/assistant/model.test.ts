import { expect, it } from 'vitest';
import {
  asConversation,
  contextMaterial,
  freezeContext,
  newConversation,
  requestMessages,
} from './model';

it('keeps legacy and new conversations in ask mode and preserves explicit full permission', () => {
  const chat = newConversation('p1');
  expect(chat.agentPermission ?? 'ask').toBe('ask');
  expect(asConversation(chat).agentPermission).toBe('ask');
  expect(asConversation({ ...chat, agentPermission: 'full' }).agentPermission).toBe('full');
  expect(asConversation({ ...chat, agentPermission: 'invalid' }).agentPermission).toBe('ask');
});

it('identifies the visible browser tab without presenting its unread body as context', () => {
  const context = freezeContext({
    workspace: 'literature',
    projectId: 'p1',
    title: 'Research source',
    browser: { tabId: 'remote-visible', url: 'https://example.com/paper' },
  });
  const material = contextMaterial(context);
  expect(material).toContain('remote-visible');
  expect(material).toContain('https://example.com/paper');
  expect(material).toContain('网页正文尚未读取');
});

it('keeps image attachments as multimodal parts in the provider request', () => {
  const conversation = newConversation('project');
  conversation.messages.push({
    id: 'message',
    role: 'user',
    text: '请识别图片',
    createdAt: '',
    attachments: [{ name: 'plot.png', mimeType: 'image/png', data: 'aGVsbG8=' }],
  });
  expect(requestMessages(conversation).at(-1)).toEqual({
    role: 'user',
    content: [
      { type: 'text', text: '请识别图片' },
      { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' },
    ],
  });
});
