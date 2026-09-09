interface RealtimeMutationEvent {
  sourceDeviceId: string;
  mutationId: string;
}

export function shouldSkipAcknowledgedRealtimeEvent(event: RealtimeMutationEvent, deviceId: string, isMutationAcknowledged: (mutationId: string) => boolean): boolean {
  return event.sourceDeviceId === deviceId && isMutationAcknowledged(event.mutationId);
}
