select vault.create_secret('http://api.supabase.internal:8000', 'qnotes_project_url', 'Local-only URL for worker cron jobs')
where not exists (select 1 from vault.decrypted_secrets where name = 'qnotes_project_url');

select vault.create_secret('local-qnotes-worker-secret', 'qnotes_internal_worker_secret', 'Local-only qnotes worker authentication secret')
where not exists (select 1 from vault.decrypted_secrets where name = 'qnotes_internal_worker_secret');
