-- Keep the versioned note mutation response aligned with the public Note contract.
-- The release-hardening migration replaced this helper without notebookId,
-- which made a successful notebook move look like an Unfiled note to clients.
create or replace function public.qnotes_note_json(p_note notesdb.notes)
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object(
    'id', p_note.id,
    'slug', p_note.slug,
    'title', p_note.title,
    'contentMarkdown', p_note.content_markdown,
    'contentPlain', p_note.content_plain,
    'tags', p_note.tags,
    'notebookId', p_note.notebook_id,
    'version', p_note.version,
    'createdAt', p_note.created_at,
    'updatedAt', p_note.updated_at,
    'deletedAt', p_note.deleted_at
  );
$$;
