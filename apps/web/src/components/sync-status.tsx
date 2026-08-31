import type { SyncStatus } from '@qnotes/shared';

const labels: Record<SyncStatus, string> = {
  saved: 'Saved',
  saving: 'Saving…',
  'remote-change': 'Changes on another device',
  syncing: 'Syncing…',
  offline: 'Offline — draft saved locally',
  conflict: 'Conflict requires review',
  error: 'Save failed — retrying',
};

export function SyncStatus({ status }: { status: SyncStatus }): JSX.Element {
  const tone = status === 'conflict' || status === 'error' ? 'q-status-error' : status === 'remote-change' || status === 'offline' ? 'q-status-warning' : '';
  return <span className={`q-status ${tone}`} role="status"><span className="q-status-dot" />{labels[status]}</span>;
}
