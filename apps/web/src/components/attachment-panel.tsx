import { Camera, Crop, Eye, Maximize2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Attachment, UUID } from '@qnotes/shared';
import { api } from '../api';
import { getSupabase } from '../supabase';
import {
  captureVisibleScreenshot,
  cropScreenshot,
  isDisplayCaptureSupported,
  isScreenshotCancellation,
  screenshotFile,
  ScreenshotCaptureError,
  type CropRect,
  type ScreenshotMode,
} from '../lib/screenshot';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu';
import { ScreenshotCropDialog } from './screenshot-crop-dialog';
import { useToast } from './ui/toast';

interface AttachmentPanelProps {
  noteId: UUID;
  attachments: Attachment[];
  onRefresh: () => Promise<unknown> | void;
  onCaptureFullPage: () => Promise<File>;
}

const terminalStatuses = new Set<Attachment['status']>(['ready', 'failed', 'unsupported', 'deleted']);
const maxTextPreviewCharacters = 1_000_000;

type PreviewKind = 'image' | 'pdf' | 'text' | 'unsupported';

interface AttachmentPreview {
  attachment: Attachment;
  kind: PreviewKind;
  signedUrl: string;
  text?: string;
}

function previewKind(attachment: Attachment): PreviewKind {
  if (attachment.mimeType.startsWith('image/')) return 'image';
  if (attachment.mimeType === 'application/pdf') return 'pdf';
  if (attachment.mimeType === 'text/plain' || attachment.mimeType === 'text/markdown') return 'text';
  return 'unsupported';
}

function statusMessage(attachment: Attachment): string {
  switch (attachment.status) {
    case 'pending_upload': return 'Preparing secure upload…';
    case 'uploaded': return 'Upload complete; waiting for text extraction.';
    case 'verifying': return 'Verifying uploaded bytes…';
    case 'queued': return 'Queued for text extraction.';
    case 'processing': return 'Extracting text; search indexing follows.';
    case 'ready': return 'Ready and searchable.';
    case 'unsupported': return attachment.extractionError === 'IMAGE_OCR_UNSUPPORTED' ? 'Stored securely; image OCR is not available.' : 'Stored securely; this file has no supported text extractor.';
    case 'failed': return 'Text extraction failed. Refresh to check again or download the original.';
    case 'deleting': return 'Removing attachment securely…';
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

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'Unknown size';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = -1;
  do {
    value /= 1024;
    unitIndex += 1;
  } while (value >= 1024 && unitIndex < units.length - 1);
  const precision = value >= 10 || Number.isInteger(value) ? 0 : 1;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

function attachmentType(attachment: Attachment): string {
  const knownTypes: Record<string, string> = {
    'application/pdf': 'PDF',
    'text/plain': 'TXT',
    'text/markdown': 'Markdown',
    'image/png': 'PNG',
    'image/jpeg': 'JPEG',
    'image/webp': 'WebP',
  };
  return knownTypes[attachment.mimeType] ?? attachment.mimeType.split('/').at(-1)?.toUpperCase() ?? 'File';
}

function screenshotErrorMessage(error: unknown): { message: string; kind: 'error' | 'info' } {
  if (isScreenshotCancellation(error)) return { message: 'Screenshot capture cancelled.', kind: 'info' };
  if (error instanceof ScreenshotCaptureError) return { message: error.message, kind: error.code === 'unsupported' ? 'info' : 'error' };
  return { message: error instanceof Error ? error.message : 'Unable to capture screenshot. Try again or upload an image file.', kind: 'error' };
}

export function AttachmentPanel({ noteId, attachments, onRefresh, onCaptureFullPage }: AttachmentPanelProps): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(attachments.length > 0);
  const [monitoringExpired, setMonitoringExpired] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [fallbackUrls, setFallbackUrls] = useState<Record<string, string>>({});
  const [cropSource, setCropSource] = useState<Blob | null>(null);
  const [preview, setPreview] = useState<AttachmentPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const { toast } = useToast();
  const refreshRef = useRef(onRefresh);
  const previewRequestRef = useRef(0);
  refreshRef.current = onRefresh;
  const waiting = attachments.some((attachment) => !terminalStatuses.has(attachment.status));
  const displayCaptureSupported = isDisplayCaptureSupported();

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

  const uploadAttachment = async (file: File, screenshot = false) => {
    setExpanded(true);
    setBusyLabel(screenshot ? 'Uploading screenshot…' : 'Uploading attachment…');
    try {
      const request = await api.requestAttachmentUpload({ noteId, fileName: file.name, mimeType: file.type || 'application/octet-stream', sizeBytes: file.size });
      const uploaded = await getSupabase().storage.from('note-attachments').uploadToSignedUrl(request.path, request.token, file);
      if (uploaded.error) throw uploaded.error;
      await api.finalizeAttachment(request.attachment.id);
      toast(screenshot ? 'Screenshot attached securely.' : 'Attachment uploaded. Text extraction and indexing are continuing.', 'success');
      await refreshRef.current();
    } catch (error: unknown) {
      toast(error instanceof Error ? error.message : 'Attachment upload failed.', 'error');
    }
  };

  const uploadFile = async (file: File) => {
    setBusy(true);
    setBusyLabel('Uploading attachment…');
    try { await uploadAttachment(file); } finally { setBusy(false); setBusyLabel(null); }
  };

  const startScreenshot = async (mode: ScreenshotMode) => {
    if (busy) return;
    setBusy(true);
    setBusyLabel('Capturing screenshot…');
    let waitingForCrop = false;
    try {
      if (mode === 'full-page') {
        await uploadAttachment(await onCaptureFullPage(), true);
      } else {
        // This call stays at the start of the menu-selection handler so the browser can honor transient activation.
        const source = await captureVisibleScreenshot();
        if (mode === 'crop') {
          waitingForCrop = true;
          setCropSource(source);
          setBusyLabel('Choose a crop to continue.');
        } else {
          await uploadAttachment(screenshotFile(source, 'visible'), true);
        }
      }
    } catch (error: unknown) {
      const result = screenshotErrorMessage(error);
      toast(result.message, result.kind);
    } finally {
      if (!waitingForCrop) { setBusy(false); setBusyLabel(null); }
    }
  };

  const cancelCrop = () => { setCropSource(null); setBusy(false); setBusyLabel(null); };
  const confirmCrop = async (crop: CropRect) => {
    if (!cropSource) return;
    try {
      const cropped = await cropScreenshot(cropSource, crop);
      await uploadAttachment(screenshotFile(cropped, 'crop'), true);
    } catch (error: unknown) {
      const result = screenshotErrorMessage(error);
      toast(result.message, result.kind);
    } finally {
      setCropSource(null);
      setBusy(false);
      setBusyLabel(null);
    }
  };

  const open = async (attachment: Attachment) => {
    try {
      const result = await api.getAttachmentDownloadUrl(attachment.id);
      const opened = window.open(result.signedUrl, '_blank', 'noopener,noreferrer');
      if (!opened) { setFallbackUrls((current) => ({ ...current, [attachment.id]: result.signedUrl })); toast('Your browser blocked the attachment window. Use the temporary link beside the file.', 'info'); }
    } catch { toast('Unable to open attachment.', 'error'); }
  };

  const closePreview = () => {
    previewRequestRef.current += 1;
    setPreview(null);
    setPreviewLoading(false);
    setPreviewError(null);
  };

  const openPreview = async (attachment: Attachment) => {
    const requestId = ++previewRequestRef.current;
    const kind = previewKind(attachment);
    setPreview({ attachment, kind, signedUrl: '' });
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const result = await api.getAttachmentDownloadUrl(attachment.id);
      if (requestId !== previewRequestRef.current) return;
      if (kind === 'text') {
        const response = await fetch(result.signedUrl, { referrerPolicy: 'no-referrer' });
        if (!response.ok) throw new Error(`Preview request failed (${response.status}).`);
        const text = await response.text();
        const truncated = text.length > maxTextPreviewCharacters;
        setPreview({ attachment, kind, signedUrl: result.signedUrl, text: truncated ? `${text.slice(0, maxTextPreviewCharacters)}\n\n[Preview truncated at 1 MB. Use Open for the full file.]` : text });
      } else {
        setPreview({ attachment, kind, signedUrl: result.signedUrl });
      }
    } catch {
      if (requestId === previewRequestRef.current) setPreviewError('Unable to load this private preview. Use Open to access the original file.');
    } finally {
      if (requestId === previewRequestRef.current) setPreviewLoading(false);
    }
  };

  return <>
    <section className="q-card q-panel q-attachment-panel" aria-label="Attachments">
      <details open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
        <summary><span><strong>Attachments</strong><span className="q-small">{attachments.length ? `${attachments.length} file${attachments.length === 1 ? '' : 's'}` : 'Optional supporting files'}</span></span><span aria-hidden="true">{expanded ? '−' : '+'}</span></summary>
        <div className="q-attachment-content">
          <div className="q-field">
            <label className="q-label" htmlFor={`attachment-upload-${noteId}`}>Add a file</label>
            <input id={`attachment-upload-${noteId}`} className="q-input" type="file" accept="text/plain,text/markdown,application/pdf,image/png,image/jpeg,image/webp" disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadFile(file); event.currentTarget.value = ''; }} />
            <span className="q-field-help">TXT, Markdown, PDF, PNG, JPEG, or WebP · up to 20 MB. Images are stored, but OCR is not available.</span>
            <div className="q-attachment-upload-actions" data-screenshot-exclude="true">
              <DropdownMenu>
                <DropdownMenuTrigger asChild><Button type="button" variant="outline" disabled={busy}><Camera size={16} aria-hidden="true" />Screenshot</Button></DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuItem className="q-screenshot-menu-item" disabled={!displayCaptureSupported} onSelect={() => { void startScreenshot('visible'); }}><Camera size={16} aria-hidden="true" /><span><strong>Visible Area</strong><small>Capture the screen or window you choose.</small></span></DropdownMenuItem>
                  <DropdownMenuItem className="q-screenshot-menu-item" onSelect={() => { void startScreenshot('full-page'); }}><Maximize2 size={16} aria-hidden="true" /><span><strong>Entire Page</strong><small>Capture the current QNotes page.</small></span></DropdownMenuItem>
                  <DropdownMenuItem className="q-screenshot-menu-item" disabled={!displayCaptureSupported} onSelect={() => { void startScreenshot('crop'); }}><Crop size={16} aria-hidden="true" /><span><strong>Cropped Zone</strong><small>Capture a screen area, then choose the crop.</small></span></DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              {!displayCaptureSupported && <span className="q-field-help">Screen capture is unavailable here. You can still upload an image file or capture the current page.</span>}
            </div>
            {busy && <span className="q-screenshot-status" role="status">{busyLabel ?? 'Working…'}</span>}
          </div>
          {waiting && <div className="q-attachment-monitor" role="status">{monitoringExpired ? 'Processing is taking longer than expected.' : 'Checking extraction and indexing status…'}<Button type="button" variant="outline" size="sm" onClick={() => void refreshNow()} disabled={refreshing}>{refreshing ? 'Refreshing…' : 'Refresh status'}</Button></div>}
          <div className="q-attachment-list">{attachments.length ? attachments.map((attachment) => <div className="q-attachment-row" key={attachment.id}><div><div className="q-attachment-name" title={attachment.originalFileName}>{attachment.originalFileName}</div><div className="q-attachment-meta" aria-label={`${attachmentType(attachment)}, ${formatFileSize(attachment.sizeBytes)}`}>{attachmentType(attachment)} · {formatFileSize(attachment.sizeBytes)}</div><div className="q-small">{statusMessage(attachment)}</div>{errorMessage(attachment.extractionError) && <div className="q-field-error">{errorMessage(attachment.extractionError)}</div>}</div><div className="q-attachment-actions"><Button variant="outline" size="sm" onClick={() => void openPreview(attachment)} disabled={attachment.status === 'pending_upload'}><Eye size={14} aria-hidden="true" />Preview</Button><Button variant="ghost" size="sm" onClick={() => void open(attachment)} disabled={attachment.status === 'pending_upload'}>Open</Button>{fallbackUrls[attachment.id] && <a className="q-search-temporary-link" href={fallbackUrls[attachment.id]} target="_blank" rel="noreferrer">Open temporary link</a>}</div></div>) : <p>No attachments yet.</p>}</div>
        </div>
      </details>
    </section>
    <ScreenshotCropDialog open={Boolean(cropSource)} source={cropSource} onOpenChange={(open) => { if (!open) cancelCrop(); }} onConfirm={confirmCrop} />
    <Dialog open={Boolean(preview)} onOpenChange={(open) => { if (!open) closePreview(); }}>
      <DialogContent className="q-attachment-preview-dialog">
        <DialogHeader>
          <DialogTitle>{preview?.attachment.originalFileName ?? 'Attachment preview'}</DialogTitle>
          <DialogDescription>{preview ? `${preview.attachment.mimeType} · private preview link expires shortly.` : 'Loading private attachment preview.'}</DialogDescription>
        </DialogHeader>
        <div className={`q-attachment-preview q-attachment-preview-${preview?.kind ?? 'empty'}`} aria-busy={previewLoading}>
          {previewLoading && <p className="q-small">Loading private preview…</p>}
          {!previewLoading && previewError && <div className="q-error" role="alert">{previewError}</div>}
          {!previewLoading && !previewError && preview?.kind === 'image' && <img src={preview.signedUrl} alt={`Preview of ${preview.attachment.originalFileName}`} referrerPolicy="no-referrer" />}
          {!previewLoading && !previewError && preview?.kind === 'pdf' && <iframe src={preview.signedUrl} title={`Preview of ${preview.attachment.originalFileName}`} referrerPolicy="no-referrer" />}
          {!previewLoading && !previewError && preview?.kind === 'text' && <pre>{preview.text}</pre>}
          {!previewLoading && !previewError && preview?.kind === 'unsupported' && <p className="q-small">Preview is not available for this file type. Use Open to access the original.</p>}
        </div>
      </DialogContent>
    </Dialog>
  </>;
}
