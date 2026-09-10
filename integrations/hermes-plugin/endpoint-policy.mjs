const LOOPBACK_HTTP_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

// Standalone copy of the API client's endpoint policy. The plugin is copied
// independently of the workspace packages, so it must carry this boundary.
export function validateApiEndpoint(value, options = {}) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim() || value.includes('\0')) {
    throw new TypeError('The API endpoint must be a trimmed URL.');
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError('The API endpoint must be a valid URL.');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new TypeError('The API endpoint must not contain credentials, queries, or fragments.');
  }
  if (/[\\\u0000-\u001f\u007f]/.test(value) || /\/(?:\.{1,2})(?:\/|$)/.test(value)) {
    throw new TypeError('The API endpoint path is malformed.');
  }
  if (parsed.protocol === 'https:') return value;
  if (parsed.protocol === 'http:' && options.allowInsecureLoopback === true && LOOPBACK_HTTP_HOSTS.has(parsed.hostname)) return value;
  throw new TypeError('The API endpoint must use HTTPS; HTTP is allowed only for explicitly enabled loopback development.');
}
