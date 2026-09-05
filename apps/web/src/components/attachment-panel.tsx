import { useEffect, useRef, useState } from 'react';
import type { Attachment, UUID } from '@qnotes/shared';
import { api } from '../api';
import { supabase } from '../supabase';
import { Button } from './ui/button';
import { useToast } from './ui/toast';

interface AttachmentPanelProps { noteId: UUID; attachments: Attachment[]; onRefresh: () => Promise<unknown> | void; }

const terminalStatuses = new Set<Attachment['status']>(['ready', 'failed', 'unsupported', 'deleted']);

function statusMessage(attachment: Attachment): string {
  switch (attachment.status) {
    case 'pending_upload': return 'Preparing secure upload…';
    case 'uploaded': return 'Upload complete; waiting for text extraction.';
    case 'queued': return 'Queued for text extraction.';
    case 'processing': return 'Extracting text; search indexing follows.';
    case 'ready': return 'Ready and searchable.';
    case 'unsupported': return attachment.extractionError === 'IMAGE_OCR_UNSUPPORTED' ? 'Stored securely; image OCR is not available.' : 'Stored securely; this file has no supported text extractor.';
    case 'failed': return 'Text extraction failed. Refresh to check again or download the original.';
    case 'deleted': return 'Deleted.';
  }
}

function errorMessage(error: string | null): string | null {
  if (!error) return null;
  if (error === 'NO_EXTRACTABLE_TEXT') return 'No extractable text was found.';
  if (error === 'IMAGE_OCR_UNSUPPORTED') return 'OCR is not available for scanned or image-only content.';
  if (error === 'UNSUPPORTED_ATTACHMENT_TYPE') return 'This file type is not supported for extraction.';
  return 'The file was kept, but its text could not be indexed.';
}

export function AttachmentPanel({ noteId, attachments, onRefresh }: AttachmentPanelProps): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(attachments.length > 0);
  const [monitoringExpired, setMonitoringExpired] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [fallbackUrls, setFallbackUrls] = useState<Record<string, string>>({});
  const { toast } = useToast();
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;
  const waiting = attachments.some((attachment) => !terminalStatuses.has(attachment.status));

  useEffect(() => { if (attachments.length) setExpanded(true); }, [attachments.length]);
  useEffect(() => {
    if (!waiting) { setMonitoringExpired(false); return undefined; }
    let timer: number | undefined;
    let attempts = 0;
    let stopped = false;
    const stop = () => { if (timer !== undefined) window.clearInterval(timer); timer = undefined; };
    const refresh = async () => {
      if (stopped || document.visibilityState !== 'visible') return;
      attempts += 1;
      if (attempts > 24) { stop(); setMonitoringExpired(true); return; }
      await refreshRef.current();
    };
    const start = () => { stop(); if (document.visibilityState === 'visible') timer = window.setInterval(() => { void refresh(); }, 2500); };
    const onVisibility = () => { if (document.visibilityState === 'hidden') stop(); else start(); };
    document.addEventListener('visibilitychange', onVisibility);
    start();
    return () => { stopped = true; stop(); document.removeEventListener('visibilitychange', onVisibility); };
  }, [waiting]);

  const refreshNow = async () => {
    setRefreshing(true); setMonitoringExpired(false);
    try { await refreshRef.current(); } finally { setRefreshing(false); }
  };
  const upload = async (file: File) => {
    setExpanded(true); setBusy(true);
    try {
      const request = await api.requestAttachmentUpload({ noteId, fileName: file.name, mimeType: file.type || 'application/octet-stream', sizeBytes: file.size });
      const uploaded = await supabase.storage.from('note-attachments').uploadToSignedUrl(request.path, request.token, file);
      if (uploaded.error) throw uploaded.error;
      await api.finalizeAttachment(request.attachment.id);
      toast('Attachment uploaded. Text extraction and indexing are continuing.', 'success');
      await refreshRef.current();
    } catch (error: unknown) { toast(error instanceof Error ? error.message : 'Attachment upload failed.', 'error'); }
    finally { setBusy(false); }
  };
  const open = async (attachment: Attachment) => {
    try {
      const result = await api.getAttachmentDownloadUrl(attachment.id);
      const opened = window.open(result.signedUrl, '_blank', 'noopener,noreferrer');
      if (!opened) { setFallbackUrls((current) => ({ ...current, [attachment.id]: result.signedUrl })); toast('Your browser blocked the attachment window. Use the temporary link beside the file.', 'info'); }
    } catch { toast('Unable to open attachment.', 'error'); }
  };
  return <section className="q-card q-panel q-attachment-panel" aria-label="Attachments"><details open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}><summary><span><strong>Attachments</strong><span className="q-small">{attachments.length ? `${attachments.length} file${attachments.length === 1 ? '' : 's'}` : 'Optional supporting files'}</span></span><span aria-hidden="true">{expanded ? '−' : '+'}</span></summary><div className="q-attachment-content"><div className="q-field"><label className="q-label" htmlFor={`attachment-upload-${noteId}`}>Add a file</label><input id={`attachment-upload-${noteId}`} className="q-input" type="file" accept="text/plain,text/markdown,application/pdf,image/png,image/jpeg,image/webp" disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); event.currentTarget.value = ''; }} /><span className="q-field-help">TXT, Markdown, PDF, PNG, JPEG, or WebP · up to 20 MB. Images are stored, but OCR is not available.</span></div>{waiting && <div className="q-attachment-monitor" role="status">{monitoringExpired ? 'Processing is taking longer than expected.' : 'Checking extraction and indexing status…'}<Button type="button" variant="outline" size="sm" onClick={() => void refreshNow()} disabled={refreshing}>{refreshing ? 'Refreshing…' : 'Refresh status'}</Button></div>}<div className="q-attachment-list">{attachments.length ? attachments.map((attachment) => <div className="q-attachment-row" key={attachment.id}><div><div className="q-attachment-name">{attachment.originalFileName}</div><div className="q-small">{statusMessage(attachment)}</div>{errorMessage(attachment.extractionError) && <div className="q-field-error">{errorMessage(attachment.extractionError)}</div>}</div><div className="q-attachment-actions"><Button variant="ghost" size="sm" onClick={() => void open(attachment)} disabled={attachment.status === 'pending_upload'}>Open</Button>{fallbackUrls[attachment.id] && <a className="q-search-temporary-link" href={fallbackUrls[attachment.id]} target="_blank" rel="noreferrer">Open temporary link</a>}</div></div>) : <p>No attachments yet.</p>}</div></div></details></section>;
}
