export class BenchmarkBodyParseError extends Error {
  constructor(label, status, cause) {
    super(`${label} returned malformed JSON (HTTP ${status}).`, { cause });
    this.name = 'BenchmarkBodyParseError';
  }
}

export async function readJsonBody(response, label = 'HTTP response') {
  const bytes = new Uint8Array(await response.arrayBuffer());
  try {
    return { bytes: bytes.byteLength, body: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch (error) {
    throw new BenchmarkBodyParseError(label, response.status, error);
  }
}
