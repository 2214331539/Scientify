import { chromium } from 'playwright';

// Use the installed Edge on Windows, or Playwright Chromium elsewhere.
// CI and developers can explicitly choose a channel or an executable.
export function launchUiBrowser() {
  const executablePath = process.env.SCIENTIFY_BROWSER_PATH;
  const channel =
    process.env.SCIENTIFY_BROWSER_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : 'chromium');
  return chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : channel === 'chromium' ? {} : { channel }),
  });
}
