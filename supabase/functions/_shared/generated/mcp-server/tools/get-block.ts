import { boundedMcpContentBytes, toolResult, type ReadQNotesClient } from './common.ts';
import { noteBlockSchema } from '../contracts.ts';

export async function getBlockTool(client: ReadQNotesClient, args: { noteRef: string; blockKey: string; offset?: number; lineStart?: number; lineEnd?: number; maxBytes?: number; continuation?: string }) {
  return toolResult(await client.getBlock(args.noteRef, args.blockKey, {
    maxBytes: boundedMcpContentBytes(args.maxBytes),
    ...(args.offset === undefined ? {} : { offset: args.offset }),
    ...(args.lineStart === undefined ? {} : { lineStart: args.lineStart }),
    ...(args.lineEnd === undefined ? {} : { lineEnd: args.lineEnd }),
    ...(args.continuation === undefined ? {} : { continuation: args.continuation }),
  }), noteBlockSchema);
}
