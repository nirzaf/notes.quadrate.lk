import { useEffect, useMemo, useState } from 'react';
import type { Note } from '@qnotes/shared';
import { threeWayMerge, type DraftMetadataConflict } from '@qnotes/sync';
import { QNotesHttpError } from '@qnotes/api-client';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';

interface ConflictResolverProps {
  open: boolean;
  baseMarkdown: string;
  localMarkdown: string;
  remoteNote: Note | null;
  metadataConflicts?: DraftMetadataConflict[];
  error?: QNotesHttpError | null | undefined;
  onUseMine: () => void;
  onUseRemote: () => void;
  onSaveMerged: (markdown: string) => void;
  onSaveAsNew?: () => void;
  onCancel: () => void;
  remoteDeleted?: boolean;
}

function displayValue(value: string | string[] | null): string {
  if (value === null) return 'Unfiled';
  return Array.isArray(value) ? value.join(', ') || '(none)' : value || '(empty)';
}

export function ConflictResolver({ open, baseMarkdown, localMarkdown, remoteNote, metadataConflicts = [], error, onUseMine, onUseRemote, onSaveMerged, onSaveAsNew, onCancel, remoteDeleted = false }: ConflictResolverProps): JSX.Element {
  const merged = useMemo(() => remoteNote ? threeWayMerge(baseMarkdown, localMarkdown, remoteNote.contentMarkdown) : null, [baseMarkdown, localMarkdown, remoteNote]);
  const [manual, setManual] = useState<string | null>(null);
  useEffect(() => { if (open) setManual(null); }, [open, remoteNote?.version]);
  const value = manual ?? merged?.merged ?? localMarkdown;
  return <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel(); }}><DialogContent aria-describedby="conflict-description"><DialogHeader><DialogTitle>{remoteDeleted ? 'Note deleted elsewhere' : 'Conflict requires review'}</DialogTitle><DialogDescription id="conflict-description">{remoteDeleted ? 'This note was deleted on another device. Your local draft is preserved.' : 'This note changed on another device. Your draft is preserved until you choose how to reconcile it.'}</DialogDescription></DialogHeader><div className="q-panel-stack" style={{ marginTop: 18 }}><pre className="q-conflict-preview">{value}</pre>{metadataConflicts.length ? <section aria-label="Metadata conflicts" className="q-panel-stack"><strong>Metadata also needs review</strong><ul>{metadataConflicts.map((conflict) => <li key={conflict.field}><span>{conflict.field}: </span><span>local “{displayValue(conflict.local as string | string[] | null)}”</span><span> · remote “{displayValue(conflict.remote as string | string[] | null)}”</span></li>)}</ul></section> : null}{error?.details ? <span className="q-small">Remote version: {String((error.details as { currentVersion?: unknown }).currentVersion ?? remoteNote?.version ?? '')}</span> : null}<div className="q-toolbar">{remoteDeleted ? <><Button onClick={() => onSaveAsNew?.()}>Save as new note</Button><Button variant="ghost" onClick={onCancel}>Cancel and keep local draft</Button></> : <><Button variant="secondary" onClick={onUseMine}>Use mine</Button><Button variant="outline" onClick={onUseRemote}>Use remote</Button><Button onClick={() => onSaveMerged(value)}>Save merged result</Button><Button variant="ghost" onClick={onCancel}>Cancel and keep local draft</Button></>}</div>{!remoteDeleted ? <label className="q-field"><span className="q-label">Edit merged result</span><textarea className="q-input" rows={8} value={value} onChange={(event) => setManual(event.target.value)} /></label> : null}</div></DialogContent></Dialog>;
}
