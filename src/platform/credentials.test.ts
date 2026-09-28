import { describe, expect, it } from 'vitest';
import { credentialSlot, nativeCredentials } from './credentials';

describe('credential slots', () => {
  it('files one key per provider endpoint and ignores a trailing slash', () => {
    expect(credentialSlot('openai', ' https://api.openai.com/v1/ ')).toBe(
      credentialSlot('openai', 'https://api.openai.com/v1'),
    );
    // Two endpoints of the same vendor are two accounts, so they must not share.
    expect(credentialSlot('openai', 'https://api.openai.com/v1')).not.toBe(
      credentialSlot('openai', 'https://gateway.example/v1'),
    );
    expect(credentialSlot('openai', 'https://gateway.example/v1')).not.toBe(
      credentialSlot('anthropic', 'https://gateway.example/v1'),
    );
  });
});

describe('native credential backend', () => {
  it('refuses to pretend a browser preview has local storage', async () => {
    // The desktop commands are unreachable outside Tauri; the panel treats a
    // rejection as "no stored key" and keeps working with a session-only key.
    await expect(
      nativeCredentials.load({ provider: 'openai', endpoint: 'https://api.openai.com/v1' }),
    ).rejects.toThrow('浏览器预览没有本机凭据存储。');
  });
});
