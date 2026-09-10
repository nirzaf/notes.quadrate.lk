import { MAX_AGENT_RESPONSE_MAX_BYTES, serializedWireBytes, sliceUtf8ByBytes, utf8LineRange, type Utf8ContentSlice } from '@qnotes/shared';
import { ApiError } from '../_shared/errors.ts';

export interface ReadRangeRequest {
  offset?: number;
  lineStart?: number;
  lineEnd?: number;
  maxBytes?: number;
  continuation?: string;
}

export interface ResolvedReadRange {
  startOffset: number;
  endOffset: number;
  maxBytes: number;
}

function integer(value: unknown, field: string, minimum: number): number | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new ApiError(422, 'VALIDATION_ERROR', `${field} must be a non-negative integer.`);
  }
  return parsed;
}

export function parseReadRange(values: Record<string, unknown>, defaultMaxBytes?: number): ReadRangeRequest {
  const offset = integer(values.offset, 'offset', 0);
  const lineStart = integer(values.lineStart, 'lineStart', 1);
  const lineEnd = integer(values.lineEnd, 'lineEnd', 1);
  if (lineStart !== undefined && lineEnd !== undefined && lineEnd < lineStart) throw new ApiError(422, 'VALIDATION_ERROR', 'lineEnd must be greater than or equal to lineStart.');
  if (offset !== undefined && (lineStart !== undefined || lineEnd !== undefined)) throw new ApiError(422, 'VALIDATION_ERROR', 'offset cannot be combined with a line range.');
  const rawMaxBytes = integer(values.maxBytes, 'maxBytes', 1);
  const maxBytes = rawMaxBytes ?? defaultMaxBytes;
  if (maxBytes !== undefined && maxBytes > MAX_AGENT_RESPONSE_MAX_BYTES) throw new ApiError(422, 'VALIDATION_ERROR', `maxBytes must be at most ${MAX_AGENT_RESPONSE_MAX_BYTES}.`);
  const continuation = values.continuation;
  if (continuation !== undefined && (typeof continuation !== 'string' || continuation.length === 0 || continuation.length > 8192)) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'continuation must be an opaque token no longer than 8192 characters.');
  }
  if (continuation && (offset !== undefined || lineStart !== undefined || lineEnd !== undefined)) throw new ApiError(422, 'VALIDATION_ERROR', 'continuation cannot be combined with offset or a line range.');
  return {
    ...(offset === undefined ? {} : { offset }),
    ...(lineStart === undefined ? {} : { lineStart }),
    ...(lineEnd === undefined ? {} : { lineEnd }),
    ...(maxBytes === undefined ? {} : { maxBytes }),
    ...(continuation === undefined ? {} : { continuation }),
  };
}

export function resolveReadRange(value: string, request: ReadRangeRequest): ResolvedReadRange {
  try {
    const lineRange = utf8LineRange(value, request.lineStart, request.lineEnd);
    const startOffset = request.offset ?? lineRange.startOffset;
    const endOffset = request.offset === undefined ? lineRange.endOffset : Number.MAX_SAFE_INTEGER;
    sliceUtf8ByBytes(value, startOffset, 0);
    return { startOffset, endOffset: Math.min(endOffset, lineRange.endOffset), maxBytes: request.maxBytes ?? Number.MAX_SAFE_INTEGER };
  } catch (error) {
    if (error instanceof RangeError) throw new ApiError(422, 'VALIDATION_ERROR', 'The requested content range is invalid.');
    throw error;
  }
}

export function contentSlice(value: string, startOffset: number, endOffset: number, maxContentBytes: number): Utf8ContentSlice {
  const available = Math.max(0, endOffset - startOffset);
  return sliceUtf8ByBytes(value, startOffset, Math.min(available, maxContentBytes));
}

export function fitJsonContent<T>(value: string, range: ResolvedReadRange, build: (slice: Utf8ContentSlice, truncated: boolean) => T): T {
  const available = Math.max(0, range.endOffset - range.startOffset);
  const candidate = (maxContentBytes: number): { slice: Utf8ContentSlice; value: T } => {
    const slice = contentSlice(value, range.startOffset, range.endOffset, maxContentBytes);
    return { slice, value: build(slice, slice.endOffset < range.endOffset) };
  };
  const complete = candidate(available);
  if (serializedWireBytes(complete.value) <= range.maxBytes) return complete.value;

  let low = 0;
  let high = available;
  let best: { slice: Utf8ContentSlice; value: T } | undefined;
  while (low <= high) {
    const requested = Math.floor((low + high) / 2);
    const current = candidate(requested);
    if (serializedWireBytes(current.value) <= range.maxBytes) {
      best = current;
      low = Math.max(requested + 1, current.slice.endOffset - range.startOffset + 1);
    } else {
      high = requested - 1;
    }
  }
  if (!best || (available > 0 && best.slice.endOffset === range.startOffset)) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'maxBytes is too small for the minimum response envelope.');
  }
  return best.value;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function encodeReadCursor(value: Record<string, unknown>): string {
  return btoa(JSON.stringify({ version: 1, ...value })).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

export function decodeReadCursor(value: string): Record<string, unknown> {
  try {
    const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4);
    const parsed = JSON.parse(atob(padded));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || (parsed as Record<string, unknown>).version !== 1) throw new Error('invalid cursor');
    return parsed as Record<string, unknown>;
  } catch {
    throw new ApiError(422, 'VALIDATION_ERROR', 'continuation is invalid or expired.');
  }
}

export function asCursorInteger(cursor: Record<string, unknown>, field: string, minimum = 0): number {
  const value = cursor[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw new ApiError(422, 'VALIDATION_ERROR', 'continuation is invalid or expired.');
  return value;
}

export function asCursorString(cursor: Record<string, unknown>, field: string): string {
  const value = cursor[field];
  if (typeof value !== 'string' || value.length === 0) throw new ApiError(422, 'VALIDATION_ERROR', 'continuation is invalid or expired.');
  return value;
}
