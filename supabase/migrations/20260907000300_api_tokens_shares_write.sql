alter table notesdb.api_tokens
  drop constraint api_tokens_scope_check;

alter table notesdb.api_tokens
  add constraint api_tokens_scope_check check (
    scopes <@ array[
      'notes:read',
      'notes:write',
      'search:read',
      'shares:write',
      'attachments:read',
      'attachments:write'
    ]::text[]
  );
