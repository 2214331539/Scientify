import { afterEach, expect, it } from 'vitest';
import { isMacOS, operatingSystem, platformClass } from './os';

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
