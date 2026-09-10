import { serviceClient } from './database.ts';
import { ApiError } from './errors.ts';

export const MAX_API_REQUEST_BODY_BYTES = 8 * 1024 * 1024;
export const MAX_PUBLIC_SHARE_REQUEST_BODY_BYTES = 1024;
export const MAX_MCP_REQUEST_BODY_BYTES = MAX_API_REQUEST_BODY_BYTES;
export const MAX_OAUTH_REGISTER_BODY_BYTES = 64 * 1024;
export const MAX_OAUTH_FORM_BODY_BYTES = 32 * 1024;
export const MAX_VAULT_REQUEST_BODY_BYTES = 262_144 + 16_384;

export type RequestBudgetBucket = 'public-share' | 'oauth' | 'embedding' | 'workspace-export' | 'workspace-import' | 'attachment-processing';

export const REQUEST_BUDGETS: Record<RequestBudgetBucket, { limit: number; cost: number }> = {
  'public-share': { limit: 60, cost: 1 },
  oauth: { limit: 30, cost: 1 },
  embedding: { limit: 20, cost: 1 },
  'workspace-export': { limit: 2, cost: 1 },
  'workspace-import': { limit: 2, cost: 1 },
  'attachment-processing': { limit: 20, cost: 1 },
};

export interface RequestBudgetDecision {
  allowed: boolean;
  retryAfterSeconds: number;
  unavailable: boolean;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function firstForwardedAddress(value: string | null): string | null {
  const candidate = value?.split(',')[0]?.trim() ?? '';
  return candidate && candidate.length <= 128 ? candidate : null;
}

export function requestClientPrincipal(request: Request): string {
  const configuredHeader = (Deno.env.get('QNOTES_CLIENT_IP_HEADER')?.trim().toLowerCase() || 'x-forwarded-for');
  if (!/^[a-z0-9-]+$/u.test(configuredHeader)) return 'unknown';
  return firstForwardedAddress(request.headers.get(configuredHeader))
    ?? firstForwardedAddress(request.headers.get('cf-connecting-ip'))
    ?? 'unknown';
}

async function principalHash(bucket: RequestBudgetBucket, principal: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`qnotes-budget:${bucket}:${principal}`));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function consumeRequestBudget(bucket: RequestBudgetBucket, principal: string, cost = REQUEST_BUDGETS[bucket].cost): Promise<RequestBudgetDecision> {
  const policy = REQUEST_BUDGETS[bucket];
  const hash = await principalHash(bucket, principal);
  try {
    const result = await serviceClient.rpc('qnotes_consume_request_budget', {
      p_bucket: bucket,
      p_principal_hash: hash,
      p_limit: policy.limit,
      p_window_seconds: 60,
      p_cost: Number.isSafeInteger(cost) && cost > 0 ? cost : policy.cost,
    });
    if (result.error) return { allowed: false, retryAfterSeconds: 5, unavailable: true };
    const row = Array.isArray(result.data) ? record(result.data[0]) : record(result.data);
    if (typeof row.allowed !== 'boolean') return { allowed: false, retryAfterSeconds: 5, unavailable: true };
    const retryAfterSeconds = typeof row.retry_after_seconds === 'number' && Number.isSafeInteger(row.retry_after_seconds)
      ? Math.max(0, row.retry_after_seconds)
      : 0;
    return { allowed: row.allowed, retryAfterSeconds, unavailable: false };
  } catch {
    return { allowed: false, retryAfterSeconds: 5, unavailable: true };
  }
}

export async function enforceRequestBudget(bucket: RequestBudgetBucket, principal: string, cost = REQUEST_BUDGETS[bucket].cost): Promise<RequestBudgetDecision> {
  const decision = await consumeRequestBudget(bucket, principal, cost);
  if (decision.unavailable) throw new ApiError(503, 'RESOURCE_LIMIT_UNAVAILABLE', 'Request capacity could not be verified. Retry later.');
  if (!decision.allowed) throw new ApiError(429, 'RATE_LIMITED', 'Request rate limit exceeded. Retry later.', { retryAfterSeconds: decision.retryAfterSeconds });
  return decision;
}
