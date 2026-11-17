// Which app versions the service still serves. The app sends its version in
// `x-scientify-version`; below MIN_CLIENT_VERSION its requests are refused with
// `client_outdated`, so sync and the official models pause until it updates.
// Raise the minimum only when the interface stops being compatible. Versions
// from before the header (0.3.0-alpha.5 and older) are let through.

import { fail } from './http.mjs';
import { DOMAINS } from './sync.mjs';

function parse(version) {
  const [core, pre = ''] = String(version).trim().replace(/^v/, '').split('-', 2);
  const numbers = core.split('.').map((part) => Number.parseInt(part, 10) || 0);
  return { numbers, pre };
}

/** Negative when `a` comes before `b` ("0.4.0-alpha.2" before "0.4.0"). */
export function compareVersions(a, b) {
  const x = parse(a);
  const y = parse(b);
  for (let index = 0; index < 3; index += 1) {
    const difference = (x.numbers[index] ?? 0) - (y.numbers[index] ?? 0);
    if (difference) return Math.sign(difference);
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return Math.sign(x.pre.localeCompare(y.pre, 'en', { numeric: true }));
}

/** Also lists the sync types this server takes, so apps only send ones it knows. */
export function clientPolicy(config) {
  return {
    minimum: config.minClientVersion || null,
    recommended: config.recommendedClientVersion || null,
    syncDomains: Object.keys(DOMAINS),
  };
}

/** Refuses requests from an app older than the minimum. */
export function requireSupportedClient(request, config) {
  const version = request.headers['x-scientify-version'];
  if (!version || !config.minClientVersion) return;
  if (compareVersions(String(version), config.minClientVersion) < 0)
    throw fail(
      426,
      `这个版本的 Scientify（${version}）太旧了，请在“设置 → 关于”里更新到最新版。`,
      'client_outdated',
    );
}
