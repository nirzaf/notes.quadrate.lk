import type { PublicSharedNote } from '@qnotes/shared';
import { boundedMcpContentBytes, toolResult } from './common.ts';
import { publicSharedNoteSchema } from '../contracts.ts';

export interface PublicShareQNotesClient {
  resolvePublicShare(token: string, options?: { offset?: number; lineStart?: number; lineEnd?: number; maxBytes?: number; continuation?: string }): Promise<PublicSharedNote>;
}

export async function resolvePublicShareTool(client: PublicShareQNotesClient, args: { token: string; offset?: number; lineStart?: number; lineEnd?: number; maxBytes?: number; continuation?: string }) {
  return toolResult(await client.resolvePublicShare(args.token, {
    maxBytes: boundedMcpContentBytes(args.maxBytes),
    ...(args.offset === undefined ? {} : { offset: args.offset }),
    ...(args.lineStart === undefined ? {} : { lineStart: args.lineStart }),
    ...(args.lineEnd === undefined ? {} : { lineEnd: args.lineEnd }),
    ...(args.continuation === undefined ? {} : { continuation: args.continuation }),
  }), publicSharedNoteSchema);
}
