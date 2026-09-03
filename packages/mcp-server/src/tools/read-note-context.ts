import { toolResult, type ReadQNotesClient } from './common.js';

export async function readNoteContextTool(client: ReadQNotesClient, args: { documentId: string; before?: number; after?: number; maxTokens?: number }) {
  return toolResult(await client.readNoteContext(args.documentId, { before: args.before ?? 1, after: args.after ?? 1, maxTokens: args.maxTokens ?? 1800 }));
}
