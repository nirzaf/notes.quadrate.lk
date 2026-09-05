import type { SyncStatus } from '@qnotes/shared';

const labels: Record<SyncStatus, string> = {
  saved: 'Saved',
  pending: 'Changes waiting to save',
  saving: 'Saving…',
  draft: 'Draft saved locally',
  'validation-error': 'Save failed — fix validation',
  'network-error': 'Network save failed',
  'storage-error': 'Local draft storage unavailable',
  'remote-change': 'Changes on another device',
  syncing: 'Syncing…',
  offline: 'Offline — draft saved locally',
  conflict: 'Conflict requires review',
  error: 'Save failed',
};

export function SyncStatus({ status, onRetry }: { status: SyncStatus; onRetry?: () => void }): JSX.Element {
  const tone = status === 'conflict' || status === 'error' || status === 'validation-error' || status === 'network-error' || status === 'storage-error' ? 'q-status-error' : status === 'remote-change' || status === 'offline' || status === 'draft' ? 'q-status-warning' : '';
  const retryable = status === 'network-error' || status === 'offline' || status === 'error';
  return <span className={`q-status ${tone}`} role="status"><span className="q-status-dot" />{labels[status]}{retryable && onRetry ? <button type="button" className="q-status-retry" onClick={onRetry}>Retry</button> : null}</span>;
}
