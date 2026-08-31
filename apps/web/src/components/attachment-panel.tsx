import { useState } from 'react';
import type { Attachment, UUID } from '@qnotes/shared';
import { api } from '../api';
import { supabase } from '../supabase';
import { Button } from './ui/button';
import { useToast } from './ui/toast';

interface AttachmentPanelProps { noteId: UUID; attachments: Attachment[]; onRefresh: () => void; }

export function AttachmentPanel({ noteId, attachments, onRefresh }: AttachmentPanelProps): JSX.Element {
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();
  const upload = async (file: File) => {
    setBusy(true);
    try {
      const request = await api.requestAttachmentUpload({ noteId, fileName: file.name, mimeType: file.type || 'application/octet-stream', sizeBytes: file.size });
      const uploaded = await supabase.storage.from('note-attachments').uploadToSignedUrl(request.path, request.token, file);
      if (uploaded.error) throw uploaded.error;
      await api.finalizeAttachment(request.attachment.id);
      toast('Attachment uploaded and queued for indexing.', 'success');
      onRefresh();
    } catch (error: unknown) {
      toast(error instanceof Error ? error.message : 'Attachment upload failed.', 'error');
    } finally {
      setBusy(false);
    }
  };
  const open = async (attachment: Attachment) => {
    try {
      const result = await api.getAttachmentDownloadUrl(attachment.id);
      window.open(result.signedUrl, '_blank', 'noopener,noreferrer');
    } catch { toast('Unable to open attachment.', 'error'); }
  };
  return <section className="q-card q-card-pad q-panel" aria-label="Attachments"><h3>Attachments</h3><div className="q-field"><span className="q-label">Add a file</span><input className="q-input" type="file" accept="text/plain,text/markdown,application/pdf,image/png,image/jpeg,image/webp" disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); event.currentTarget.value = ''; }} /></div><div className="q-attachment-list" style={{ marginTop: 14 }}>{attachments.length ? attachments.map((attachment) => <div className="q-attachment-row" key={attachment.id}><div><div className="q-attachment-name">{attachment.originalFileName}</div><div className="q-small">{attachment.status}{attachment.extractionError ? ` · ${attachment.extractionError}` : ''}</div></div><Button variant="ghost" size="sm" onClick={() => void open(attachment)}>Open</Button></div>) : <p>No attachments yet.</p>}</div></section>;
}
