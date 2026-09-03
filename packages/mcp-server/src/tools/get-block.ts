import { toolResult, type ReadQNotesClient } from './common.js';

export async function getBlockTool(client: ReadQNotesClient, args: { noteRef: string; blockKey: string }) {
  return toolResult(await client.getBlock(args.noteRef, args.blockKey));
}
