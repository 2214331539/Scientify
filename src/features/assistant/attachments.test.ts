import { expect, it } from 'vitest';
import { readAttachment } from './attachments';
import { attachmentMaterial, attachmentNote, newConversation, requestMessages } from './model';

it('extracts explicit text files without sending them as image parts', async () => {
  const attachment = await readAttachment(
    new File(['# Research\nalpha'], 'notes.md', { type: 'text/markdown' }),
  );
  expect(attachment.text).toContain('alpha');
  const chat = newConversation('p1');
  chat.messages.push({
    id: 'm',
    role: 'user',
    text: '解释',
    createdAt: '',
    attachments: [attachment, { name: 'image.png', mimeType: 'image/png', data: 'aW1hZ2U=' }],
  });
  const message = requestMessages(chat)[1];
  expect(message.content).toEqual([
    { type: 'text', text: expect.stringContaining('alpha') },
    { type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' },
  ]);
  expect(attachmentMaterial([attachment])).toContain('不扩大工作区操作权限');
});

it('marks truncation and rejects binary, unsupported and oversized attachments', async () => {
  const attachment = await readAttachment(new File(['研究'.repeat(8000)], 'long.md'));
  expect(attachment.text).toHaveLength(12000);
  expect(attachment.truncated).toBe(true);
  await expect(readAttachment(new File(['\0binary'], 'bad.py'))).rejects.toThrow('文本');
  await expect(readAttachment(new File(['binary'], 'program.exe'))).rejects.toThrow('支持');
  await expect(
    readAttachment(new File([new Uint8Array(2 * 1024 * 1024 + 1)], 'large.txt')),
  ).rejects.toThrow('2 MiB');
});

it('hands saved files to the agent and labels only truncated quick-chat text', () => {
  const saved = {
    name: 'paper.pdf',
    mimeType: 'application/pdf',
    data: '',
    path: 'C:/data/agent/attachments/p1/c1/paper.pdf',
  };
  expect(attachmentMaterial([saved])).toContain('path="C:/data/agent/attachments/p1/c1/paper.pdf"');
  expect(attachmentMaterial([saved])).toContain('读取全文');
  expect(attachmentNote(saved)).toBe('');
  const partial = {
    name: 'long.pdf',
    mimeType: 'application/pdf',
    data: '',
    text: 'x',
    truncated: true,
    pages: { read: 6, total: 30 },
  };
  expect(attachmentNote(partial)).toBe('前 6/30 页');
  expect(attachmentMaterial([partial])).toContain('只含前 6 页，共 30 页');
});
