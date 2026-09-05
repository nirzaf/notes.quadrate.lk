import { toolResult, type ReadQNotesClient } from './common.js';

export async function readNoteContextTool(client: ReadQNotesClient, args: { documentId: string; before?: number; after?: number; maxTokens?: number; continuation?: string }) {
  const params: { before: number; after: number; maxTokens: number; continuation?: string } = {
    before: args.before ?? 1,
    after: args.after ?? 1,
    maxTokens: args.maxTokens ?? 1800,
  };
  if (args.continuation !== undefined) params.continuation = args.continuation;
  return toolResult(await client.readNoteContext(args.documentId, params));
}
