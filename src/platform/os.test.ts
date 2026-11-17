import { afterEach, expect, it } from 'vitest';
import { displayPath, isMacOS, operatingSystem, platformClass } from './os';

const originalNavigator = globalThis.navigator;

afterEach(() => {
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: originalNavigator });
});

function setNavigator(userAgent: string, platform: string) {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { userAgent, platform },
  });
}

it('centralizes macOS detection for the UI and shortcuts', () => {
  setNavigator('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)', 'MacIntel');
  expect(operatingSystem()).toBe('macos');
  expect(isMacOS()).toBe(true);
  expect(platformClass()).toBe('platform-macos');
});

it('does not classify Windows as macOS', () => {
  setNavigator('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Win32');
  expect(operatingSystem()).toBe('windows');
  expect(isMacOS()).toBe(false);
});

it('shows Windows paths without the long-path prefix', () => {
  expect(displayPath(String.raw`\\?\F:\Project\实验`)).toBe(String.raw`F:\Project\实验`);
  expect(displayPath(String.raw`\\?\UNC\server\share\code`)).toBe(String.raw`\\server\share\code`);
  expect(displayPath('/home/researcher/code')).toBe('/home/researcher/code');
});

it('tells when two folders are the same or nested', async () => {
  const { sameOrInside } = await import('./os');
  expect(sameOrInside('D:\\AScience\\Proactive', 'd:\\ascience\\proactive\\')).toBe(true);
  expect(sameOrInside('D:\\AScience\\Proactive\\code', '\\\\?\\D:\\AScience\\Proactive')).toBe(
    true,
  );
  expect(sameOrInside('D:\\AScience\\Proactive', 'D:\\AScience\\Proactive2')).toBe(false);
  expect(sameOrInside('/Users/a/papers', '/Users/a/code')).toBe(false);
});
