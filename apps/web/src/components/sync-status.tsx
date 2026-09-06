import type { SyncStatus } from '@qnotes/shared';
import { useEffect, useState } from 'react';

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

function savedLabel(savedAt: string | undefined, now: number): string {
  if (!savedAt) return 'Saved';
  const timestamp = Date.parse(savedAt);
  if (!Number.isFinite(timestamp)) return 'Saved';
  const elapsedSeconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (elapsedSeconds < 10) return 'Saved just now';
  if (elapsedSeconds < 60) return `Saved ${elapsedSeconds}s ago`;
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return `Saved ${elapsedMinutes}m ago`;
  return 'Saved earlier';
}

export function SyncStatus({ status, savedAt, onRetry }: { status: SyncStatus; savedAt?: string; onRetry?: () => void }): JSX.Element {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (status !== 'saved' || !savedAt) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, [savedAt, status]);
  const tone = status === 'conflict' || status === 'error' || status === 'validation-error' || status === 'network-error' || status === 'storage-error' ? 'q-status-error' : status === 'remote-change' || status === 'offline' || status === 'draft' ? 'q-status-warning' : '';
  const retryable = status === 'network-error' || status === 'offline' || status === 'error';
  return <span className={`q-status ${tone}`} role="status" aria-live={status === 'saved' ? 'off' : 'polite'}><span className="q-status-dot" />{status === 'saved' ? savedLabel(savedAt, now) : labels[status]}{retryable && onRetry ? <button type="button" className="q-status-retry" onClick={onRetry}>Retry</button> : null}</span>;
}
