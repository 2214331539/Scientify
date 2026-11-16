// Calls to /admin/api. The custom header proves the request comes from these
// pages; the session cookie is sent automatically and never readable here.

export class SignedOut extends Error {}

export async function api(method, path, body) {
  const response = await fetch(`/admin/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: { 'x-scientify-admin': '1', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let value = {};
  try {
    value = await response.json();
  } catch {
    value = {};
  }
  if (response.status === 401 && value.code === 'admin_signed_out') throw new SignedOut(value.error);
  if (!response.ok) throw new Error(value.error || `请求失败（HTTP ${response.status}）`);
  return value;
}

export const get = (path) => api('GET', path);
export const post = (path, body = {}) => api('POST', path, body);
export const put = (path, body = {}) => api('PUT', path, body);
export const del = (path) => api('DELETE', path);
