import { toolResult, type ReadQNotesClient } from './common.ts';

export async function getBlockTool(client: ReadQNotesClient, args: { noteRef: string; blockKey: string }) {
  return toolResult(await client.getBlock(args.noteRef, args.blockKey));
}
