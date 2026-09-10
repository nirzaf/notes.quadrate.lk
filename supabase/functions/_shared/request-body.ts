export class RequestBodyTooLarge extends Error {
  constructor() {
    super('request body is too large');
    this.name = 'RequestBodyTooLarge';
  }
}

export async function readRequestBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('invalid request body limit');
  const contentLength = request.headers.get('content-length')?.trim();
  if (contentLength && /^\d+$/u.test(contentLength) && Number(contentLength) > maxBytes) throw new RequestBodyTooLarge();
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new RequestBodyTooLarge();
      }
      chunks.push(result.value);
    }
  } catch (error) {
    if (error instanceof RequestBodyTooLarge) throw error;
    throw new Error('request body could not be read');
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function boundedRequest(request: Request, maxBytes: number): Promise<Request> {
  if (!request.body) return request;
  const bytes = await readRequestBody(request, maxBytes);
  return new Request(request, { body: bytes as BodyInit, duplex: 'half' } as RequestInit & { duplex: 'half' });
}
