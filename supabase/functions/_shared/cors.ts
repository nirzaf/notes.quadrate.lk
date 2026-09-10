import { ApiError } from './errors.ts';

export function applyCors(request: Request, responseHeaders: Headers): void {
  const origin = request.headers.get('origin');
  if (!origin) return;
  const allowed = (Deno.env.get('QNOTES_ALLOWED_ORIGIN') ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  if (!allowed.includes(origin)) throw new ApiError(403, 'CORS_ORIGIN_DENIED', 'The request origin is not allowed.');
  responseHeaders.set('Access-Control-Allow-Origin', origin);
  responseHeaders.set('Vary', 'Origin');
  responseHeaders.set('Access-Control-Allow-Headers', 'authorization, content-type, x-request-id, x-qnotes-worker-secret, x-vault-approval, x-vault-request-hash');
  responseHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  responseHeaders.set('Access-Control-Expose-Headers', 'x-request-id');
}
