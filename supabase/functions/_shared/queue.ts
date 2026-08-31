import { serviceClient } from './database.ts';

export interface QueueMessage {
  message_id: number;
  read_count: number;
  message: unknown;
}

export async function readQueue(queueName: string, visibilitySeconds: number, batchSize: number): Promise<QueueMessage[]> {
  const { data, error } = await serviceClient.rpc('qnotes_read_queue', { p_queue_name: queueName, p_visibility_seconds: visibilitySeconds, p_batch_size: batchSize });
  if (error) throw error;
  return Array.isArray(data) ? data as QueueMessage[] : [];
}

export async function deleteQueueMessage(queueName: string, messageId: number): Promise<void> {
  const { error } = await serviceClient.rpc('qnotes_delete_queue_message', { p_queue_name: queueName, p_message_id: messageId });
  if (error) throw error;
}

export async function archiveQueueMessage(queueName: string, messageId: number): Promise<void> {
  const { error } = await serviceClient.rpc('qnotes_archive_queue_message', { p_queue_name: queueName, p_message_id: messageId });
  if (error) throw error;
}
