export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const MAX_REQUEST_TIMEOUT_MS = 120_000;

const LOOPBACK_HTTP_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function validateApiEndpoint(value: string, options: { allowInsecureLoopback?: boolean } = {}): string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim() || value.includes('\0')) {
    throw new TypeError('The API endpoint must be a trimmed URL.');
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError('The API endpoint must be a valid URL.');
  }

  if (parsed.username || parsed.password || parsed.search || parsed.hash || value.includes('?') || value.includes('#')) {
    throw new TypeError('The API endpoint must not contain credentials, queries, or fragments.');
  }
  let pathSegments: string[];
  try {
    const rawPath = value.match(/^[a-z][a-z\d+.-]*:\/\/[^/]*(.*)$/i)?.[1] ?? '';
    pathSegments = [...decodeURIComponent(rawPath).split(/[\/\\]/), ...parsed.pathname.split('/').map((segment) => decodeURIComponent(segment))];
  } catch {
    throw new TypeError('The API endpoint path is malformed.');
  }
  if (/[\\\u0000-\u001f\u007f]/.test(value) || pathSegments.some((segment) => segment === '.' || segment === '..')) {
    throw new TypeError('The API endpoint path is malformed.');
  }
  if (parsed.protocol === 'https:') return value;
  if (parsed.protocol === 'http:' && options.allowInsecureLoopback === true && LOOPBACK_HTTP_HOSTS.has(parsed.hostname)) return value;
  throw new TypeError('The API endpoint must use HTTPS; HTTP is allowed only for explicitly enabled loopback development.');
}

export function boundedTimeout(timeoutMs: number | undefined): number {
  const value = timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isFinite(value) || value < 0) throw new RangeError('timeoutMs must be a finite, non-negative number.');
  return Math.min(value, MAX_REQUEST_TIMEOUT_MS);
}

export function requestTimeoutError(): DOMException {
  return new DOMException('The request timed out.', 'TimeoutError');
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason;
}

export interface RequestSignal {
  signal: AbortSignal;
  cleanup: () => void;
}

export function createRequestSignal(callerSignal: AbortSignal | null | undefined, timeoutMs: number | undefined): RequestSignal {
  const controller = new AbortController();
  const boundedMs = boundedTimeout(timeoutMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (timer !== undefined) clearTimeout(timer);
    callerSignal?.removeEventListener('abort', abortFromCaller);
  };
  const abortFromCaller = () => controller.abort(callerSignal?.reason);
  controller.signal.addEventListener('abort', cleanup, { once: true });

  if (callerSignal) {
    if (callerSignal.aborted) controller.abort(callerSignal.reason);
    else callerSignal.addEventListener('abort', abortFromCaller, { once: true });
  }
  if (!controller.signal.aborted) timer = setTimeout(() => controller.abort(requestTimeoutError()), boundedMs);

  return {
    signal: controller.signal,
    cleanup,
  };
}

export function redactSensitive(value: unknown, secrets: readonly (string | null | undefined)[]): unknown {
  const candidates = secrets.filter((secret): secret is string => typeof secret === 'string' && secret.length > 0).sort((left, right) => right.length - left.length);
  const redact = (input: unknown, seen: WeakSet<object>): unknown => {
    if (typeof input === 'string') return candidates.reduce((result, secret) => result.split(secret).join('[REDACTED]'), input);
    if (input === null || typeof input !== 'object') return input;
    if (seen.has(input)) return '[REDACTED]';
    seen.add(input);
    if (Array.isArray(input)) return input.map((item) => redact(item, seen));
    return Object.fromEntries(Object.entries(input).map(([key, item]) => [key, redact(item, seen)]));
  };
  return redact(value, new WeakSet<object>());
}

export function requestSecrets(body: BodyInit | null | undefined, accessToken?: string | null): string[] {
  const secrets = accessToken ? [accessToken] : [];
  if (typeof body !== 'string') return secrets;
  try {
    const collect = (value: unknown, key = ''): void => {
      if (typeof value === 'string' && /token|secret|password|value/i.test(key)) secrets.push(value);
      else if (Array.isArray(value)) value.forEach((item) => collect(item, key));
      else if (value && typeof value === 'object') Object.entries(value).forEach(([childKey, childValue]) => collect(childValue, childKey));
    };
    collect(JSON.parse(body));
  } catch {
    // The server owns request validation; only redact values from parseable JSON.
  }
  return secrets;
}
