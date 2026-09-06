let pendingEditorFocusNoteId: string | null = null;

/** Request one-time editor focus for a note created during this SPA session. */
export function requestEditorFocus(noteId: string): void {
  pendingEditorFocusNoteId = noteId;
}

/** Consume the one-time focus request so revisiting an existing note stays quiet. */
export function consumeEditorFocus(noteId: string): boolean {
  if (pendingEditorFocusNoteId !== noteId) return false;
  pendingEditorFocusNoteId = null;
  return true;
}
