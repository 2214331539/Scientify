// Errors the app didn't catch go to the service (server errors.mjs), so they
// get fixed before anyone has to write in. Settings → 数据与备份 turns it off.
// Only the message and stack are sent, with account names in paths blanked.

import { invoke, isTauri } from '@tauri-apps/api/core';

const KEY = 'scientify.errorReports';
const PER_SESSION = 20;
// Noise that says nothing about a bug.
const IGNORED = [/ResizeObserver loop/i, /^Script error\.?$/i, /AbortError/];
const sent = new Set<string>();

export function errorReportsOn() {
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setErrorReports(on: boolean) {
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch {
    /* Without storage the switch lasts until the app closes. */
  }
}

/** "C:\Users\li\…", "/Users/li/…" and "/home/li/…" with the account name blanked. */
export function scrub(text: string) {
  return text
    .replace(/([A-Za-z]:[\\/]+Users[\\/]+)[^\\/\s"'`]+/gi, '$1~')
    .replace(/(\/(?:Users|home)\/)[^/\s"'`]+/g, '$1~');
}

/** What gets sent for an error, or null when it isn't worth sending. */
export function errorReport(error: unknown, source: string) {
  const known = error instanceof Error ? error : null;
  const text = known ? `${known.name}: ${known.message}` : String(error ?? '');
  const message = scrub(text).trim().slice(0, 1000);
  if (!message || IGNORED.some((pattern) => pattern.test(message))) return null;
  return { message, stack: scrub(known?.stack ?? '').slice(0, 8000), source };
}

export function reportError(error: unknown, source: string) {
  if (!isTauri() || !errorReportsOn()) return;
  const report = errorReport(error, source);
  if (!report) return;
  const key = `${report.message}\n${report.stack.slice(0, 300)}`;
  if (sent.has(key) || sent.size >= PER_SESSION) return;
  sent.add(key);
  void invoke('collaboration_report_error', { report }).catch(() => {});
}

/** Reports what reaches the window: uncaught errors, rejected promises nobody handled. */
export function installErrorReports() {
  window.addEventListener('error', (event) => reportError(event.error ?? event.message, 'error'));
  window.addEventListener('unhandledrejection', (event) => reportError(event.reason, 'promise'));
}
