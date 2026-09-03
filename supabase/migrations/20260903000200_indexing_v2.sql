-- Supabase supports sub-minute pg_cron intervals on current hosted Postgres.
-- Re-scheduling by the existing job name updates the prior one-minute jobs.
select cron.schedule(
  'qnotes-process-embeddings', '30 seconds',
  $$select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'qnotes_project_url') || '/functions/v1/embedding-worker',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-qnotes-worker-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'qnotes_internal_worker_secret')),
    body := '{}'::jsonb
  );$$
);

select cron.schedule(
  'qnotes-process-attachments', '30 seconds',
  $$select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'qnotes_project_url') || '/functions/v1/attachment-worker',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-qnotes-worker-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'qnotes_internal_worker_secret')),
    body := '{}'::jsonb
  );$$
);
