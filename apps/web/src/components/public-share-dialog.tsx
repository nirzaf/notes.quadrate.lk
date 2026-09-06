import { Check, Copy, ExternalLink, Link2Off, RotateCw, Share2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Note, PublicShareMetadata } from '@qnotes/shared';
import { api } from '../api';
import { env } from '../env';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';
import { useToast } from './ui/toast';

type ExpiryChoice = '1' | '7' | '30' | '90' | 'never';

const expiryOptions: Array<{ value: ExpiryChoice; label: string }> = [
  { value: '1', label: '1 day' },
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: 'never', label: 'Never' },
];

function expiryDate(choice: ExpiryChoice): string | null {
  if (choice === 'never') return null;
  const date = new Date();
  date.setDate(date.getDate() + Number(choice));
  return date.toISOString();
}

function expiryLabel(share: PublicShareMetadata): string {
  if (!share.expiresAt) return 'Never';
  const date = new Date(share.expiresAt);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  if (date.getTime() <= Date.now()) return 'Expired';
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

interface PublicShareDialogProps {
  open: boolean;
  note: Note;
  share: PublicShareMetadata | null;
  loading?: boolean;
  onOpenChange: (open: boolean) => void;
  onBeforeCreate: () => Promise<void>;
  onRefresh: () => Promise<unknown> | unknown;
}

export function PublicShareDialog({ open, note, share, loading = false, onOpenChange, onBeforeCreate, onRefresh }: PublicShareDialogProps): JSX.Element {
  const { toast } = useToast();
  const [expiry, setExpiry] = useState<ExpiryChoice>('7');
  const [createdLink, setCreatedLink] = useState<string | null>(null);
  const [createdMarkdownUrl, setCreatedMarkdownUrl] = useState<string | null>(null);
  const [createdMetadata, setCreatedMetadata] = useState<PublicShareMetadata | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const openRef = useRef(open);
  const visibleShare = createdMetadata ?? share;
  const link = createdLink;

  useEffect(() => {
    openRef.current = open;
    if (!open) {
      setCreatedLink(null);
      setCreatedMarkdownUrl(null);
      setCreatedMetadata(null);
      setError(null);
      setBusy(false);
    }
  }, [open]);

  const create = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await onBeforeCreate();
      const result = await api.createPublicShare(note.id, { expiresAt: expiryDate(expiry) });
      const publicUrl = new URL('/share', window.location.origin);
      publicUrl.hash = result.token;
      const markdownUrl = new URL(`${env.qnotesApiUrl.replace(/\/$/, '')}/public/share/resolve`);
      markdownUrl.searchParams.set('token', result.token);
      if (openRef.current) {
        setCreatedLink(publicUrl.toString());
        setCreatedMarkdownUrl(markdownUrl.toString());
        setCreatedMetadata(result.metadata);
      }
      await onRefresh();
      if (openRef.current) toast('Public link created. It is shown only while this dialog is open.', 'success');
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : 'Unable to create a public link.');
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api.revokePublicShare(note.id);
      setCreatedLink(null);
      setCreatedMarkdownUrl(null);
      setCreatedMetadata(null);
      await onRefresh();
      toast('Public link revoked.', 'success');
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : 'Unable to revoke the public link.');
    } finally {
      setBusy(false);
    }
  };

  const copyValue = async (value: string, successMessage: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      toast(successMessage, 'success');
    } catch {
      setError('Clipboard access was unavailable. Select and copy the link manually.');
    }
  };

  const copy = async (): Promise<void> => {
    if (link) await copyValue(link, 'Public link copied.');
  };

  const copyMarkdown = async (): Promise<void> => {
    if (createdMarkdownUrl) await copyValue(createdMarkdownUrl, 'Markdown endpoint copied.');
  };

  const systemShare = async (): Promise<void> => {
    if (!link || typeof navigator.share !== 'function') return;
    try {
      await navigator.share({ title: note.title, url: link });
    } catch (cause: unknown) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      setError('The system share sheet could not be opened.');
    }
  };

  const openLink = (): void => {
    if (link) window.open(link, '_blank', 'noopener,noreferrer');
  };

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="q-public-share-dialog">
      <DialogHeader>
        <DialogTitle>Public sharing</DialogTitle>
        <DialogDescription>Give someone read-only access to this note. Attachments and private workspace data are never included.</DialogDescription>
      </DialogHeader>
      {loading ? <div className="q-empty">Checking the current link…</div> : visibleShare || link ? <>
        {link ? <div className="q-public-share-created">
          <div className="q-public-share-status"><Check size={18} aria-hidden="true" /><strong>Public link created</strong></div>
          <p className="q-small">Copy this link now. For safety, the secret is not retained after you close this dialog.</p>
          <div className="q-public-share-link"><code>{link}</code><Button type="button" variant="outline" size="sm" onClick={() => void copy()}><Copy size={15} aria-hidden="true" />Copy</Button></div>
          {createdMarkdownUrl ? <><p className="q-small">AI agents can fetch the note’s Markdown with a GET request:</p><div className="q-public-share-link"><code>{createdMarkdownUrl}</code><Button type="button" variant="outline" size="sm" onClick={() => void copyMarkdown()}><Copy size={15} aria-hidden="true" />Copy endpoint</Button></div></> : null}
          <p className="q-small">Expires: {createdMetadata ? expiryLabel(createdMetadata) : 'Unknown'}</p>
          <div className="q-dialog-actions q-public-share-actions"><Button type="button" variant="outline" onClick={openLink}><ExternalLink size={15} aria-hidden="true" />Open preview</Button>{typeof navigator.share === 'function' ? <Button type="button" variant="outline" onClick={() => void systemShare()}><Share2 size={15} aria-hidden="true" />Share</Button> : null}<Button type="button" variant="danger" onClick={() => void revoke()} disabled={busy}><Link2Off size={15} aria-hidden="true" />Revoke</Button></div>
        </div> : <div className="q-public-share-existing">
          <div className="q-public-share-status"><Check size={18} aria-hidden="true" /><strong>A public link is active</strong></div>
          <dl className="q-public-share-details"><div><dt>Token prefix</dt><dd><code>{visibleShare?.tokenPrefix}</code></dd></div><div><dt>Expires</dt><dd>{visibleShare ? expiryLabel(visibleShare) : 'Unknown'}</dd></div></dl>
          <p className="q-warning">Anyone with the link can read this note until you revoke it or it expires.</p>
          <div className="q-dialog-actions q-public-share-actions"><Button type="button" variant="outline" onClick={() => void create()} disabled={busy}><RotateCw size={15} aria-hidden="true" />Create new link</Button><Button type="button" variant="danger" onClick={() => void revoke()} disabled={busy}><Link2Off size={15} aria-hidden="true" />Revoke</Button></div>
        </div>}
      </> : <div className="q-public-share-create">
        <p className="q-small">The link contains a secret that is shown once. Choose how long it should remain usable.</p>
        <label className="q-label" htmlFor="public-share-expiry">Link lifetime</label>
        <select id="public-share-expiry" className="q-input" value={expiry} onChange={(event) => setExpiry(event.target.value as ExpiryChoice)} disabled={busy}>
          {expiryOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <p className="q-warning">Anyone with the link can read this note until you revoke it or it expires.</p>
        <div className="q-dialog-actions"><Button type="button" onClick={() => void create()} disabled={busy}>{busy ? 'Creating…' : 'Create public link'}</Button></div>
      </div>}
      {error ? <div className="q-error" role="alert">{error}</div> : null}
    </DialogContent>
  </Dialog>;
}
