// Small HTTP helpers shared by the API, the billing routes and the admin pages.

export function send(response, status, value, headers = {}) {
  const body = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
  response.writeHead(status, {
    'content-type':
      typeof value === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    ...headers,
  });
  response.end(body);
}

/** An error the handler turns into a JSON answer; `code` lets clients tell cases apart. */
export function fail(status, message, code) {
  return Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
}

export async function body(request, limit = 10 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw fail(413, '请求体过大。');
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw fail(400, '请求体不是有效 JSON。');
  }
}

export function bearer(request) {
  const header = request.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

/** Behind Nginx the client address arrives in X-Real-IP; otherwise use the socket. */
export function clientAddress(request, config) {
  const forwarded = config.trustProxy ? String(request.headers['x-real-ip'] ?? '') : '';
  return forwarded || request.socket.remoteAddress || 'unknown';
}

/** A whole number within bounds, or the fallback when the value is missing. */
export function integer(value, fallback, min, max) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max)
    throw fail(400, `数值超出范围（${min}–${max}）。`);
  return parsed;
}
