import type { PublicSharedNote } from '@qnotes/shared';
import { toolResult } from './common.ts';

export interface PublicShareQNotesClient {
  resolvePublicShare(token: string): Promise<PublicSharedNote>;
}

export async function resolvePublicShareTool(client: PublicShareQNotesClient, args: { token: string }) {
  return toolResult(await client.resolvePublicShare(args.token));
}
