import { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import type { PublicSharedNote } from '@qnotes/shared';
import { api } from '../api';
import { NotePreview } from '../components/note-preview';
import { Button } from '../components/ui/button';
import { useToast } from '../components/ui/toast';
import { formatUpdatedAt } from '../lib/utils';

const NOTE_SHARE_TOKEN_PATTERN = /^qns_[A-Za-z0-9_-]{43}$/;
const UNAVAILABLE_MESSAGE = 'This shared note is unavailable. The link may be invalid, expired, or revoked.';

function readToken(): string {
  return window.location.hash.startsWith('#') ? window.location.hash.slice(1) : '';
}

async function copyMarkdown(value: string): Promise<void> {
  if (typeof navigator.clipboard?.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Fall through to the temporary textarea for browsers that expose but
      // reject the async clipboard API in the current context.
    }
  }

  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '-9999px';
  textarea.style.left = '-9999px';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  document.body.append(textarea);
  const onCopy = (event: ClipboardEvent): void => {
    if (!event.clipboardData) return;
    event.preventDefault();
    event.clipboardData.setData('text/plain', value);
  };
  document.addEventListener('copy', onCopy);
  try {
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    if (!document.execCommand('copy')) throw new Error('Clipboard access was unavailable.');
  } finally {
    document.removeEventListener('copy', onCopy);
    textarea.remove();
  }
}

export function PublicSharePage(): JSX.Element {
  const [token, setToken] = useState(readToken);
  const [note, setNote] = useState<PublicSharedNote | null>(null);
  const [loading, setLoading] = useState(true);
  const [copyState, setCopyState] = useState<'idle' | 'copied'>('idle');
  const { toast } = useToast();

  useEffect(() => {
    const onHashChange = (): void => setToken(readToken());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setNote(null);
    if (!NOTE_SHARE_TOKEN_PATTERN.test(token)) {
      setLoading(false);
      return () => controller.abort();
    }
    void api.resolvePublicShare(token, { signal: controller.signal }).then((resolved) => {
      if (controller.signal.aborted) return;
      setNote(resolved);
      setLoading(false);
    }).catch(() => {
      if (controller.signal.aborted) return;
      setLoading(false);
    });
    return () => controller.abort();
  }, [token]);

  useEffect(() => {
    const previousTitle = document.title;
    const meta = document.querySelector('meta[name="robots"]') ?? document.head.appendChild(Object.assign(document.createElement('meta'), { name: 'robots' }));
    const previousRobots = meta.getAttribute('content');
    meta.setAttribute('content', 'noindex, nofollow, noarchive, nosnippet');
    return () => {
      document.title = previousTitle;
      if (previousRobots === null) meta.removeAttribute('content');
      else meta.setAttribute('content', previousRobots);
    };
  }, []);

  useEffect(() => {
    document.title = note?.title ? `${note.title} · Quadrate Notes` : 'Shared note · Quadrate Notes';
    setCopyState('idle');
  }, [note?.title]);

  const copyNoteMarkdown = async (): Promise<void> => {
    if (!note) return;
    try {
      await copyMarkdown(note.contentMarkdown);
      setCopyState('copied');
    } catch {
      setCopyState('idle');
      toast('Unable to copy Markdown. Please try again.', 'error');
    }
  };

  return <main className="q-public-share-page">
    <section className="q-public-share-shell">
      <a className="q-public-share-brand" href="/"><span className="q-brand-mark" aria-hidden="true">Qn</span><span>Quadrate Notes</span></a>
      <p className="q-public-share-badge">Read-only shared note</p>
      {loading ? <div className="q-public-share-note q-card" role="status"><div className="q-empty">Opening shared note…</div></div> : note ? <article className="q-public-share-note q-card">
        <header>
          <div className="q-public-share-heading"><h1>{note.title}</h1><p className="q-public-share-updated">Updated {formatUpdatedAt(note.updatedAt)}</p></div>
          <Button type="button" className="q-public-share-copy" onClick={() => void copyNoteMarkdown()} aria-label={copyState === 'copied' ? 'Markdown copied' : 'Copy Markdown'}>
            {copyState === 'copied' ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
            {copyState === 'copied' ? 'Copied' : 'Copy Markdown'}
          </Button>
        </header>
        <NotePreview markdown={note.contentMarkdown} />
        <footer><p>This is a read-only view. The note owner can revoke this link at any time.</p></footer>
      </article> : <div className="q-public-share-note q-card" role="alert"><h1>Shared note unavailable</h1><p>{UNAVAILABLE_MESSAGE}</p><a className="q-button q-button-outline" href="/">Go to Quadrate Notes</a></div>}
    </section>
  </main>;
}
