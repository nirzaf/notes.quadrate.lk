select plan(17);

select ok(to_regclass('notesdb.vault_projects') is not null, 'Vault projects table exists');
select ok(to_regclass('notesdb.vault_environments') is not null, 'Vault environments table exists');
select ok(to_regclass('notesdb.vault_secrets') is not null, 'Vault secrets metadata table exists');
select ok(to_regclass('notesdb.vault_agent_tokens') is not null, 'Vault agent token table exists');
select ok(to_regclass('notesdb.vault_agent_grants') is not null, 'Vault grants table exists');
select ok(to_regclass('notesdb.vault_audit_events') is not null, 'Vault audit table exists');
select ok(to_regclass('notesdb.vault_mutations') is not null, 'Vault mutation receipts table exists');
select ok((select relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'notesdb' and c.relname = 'vault_secrets'), 'Vault metadata uses RLS');
select ok(not has_table_privilege('anon', 'notesdb.vault_secrets', 'SELECT'), 'anon cannot read Vault metadata directly');
select ok(not has_table_privilege('authenticated', 'notesdb.vault_secrets', 'SELECT'), 'authenticated cannot read Vault metadata directly');
select ok(not has_table_privilege('anon', 'vault.decrypted_secrets', 'SELECT'), 'anon cannot read decrypted Vault values directly');
select ok(not has_table_privilege('authenticated', 'vault.decrypted_secrets', 'SELECT'), 'authenticated cannot read decrypted Vault values directly');
select ok((select p.prosecdef from pg_proc p where p.oid = 'public.qnotes_vault_reveal_secret(uuid,uuid,uuid,text,uuid,text)'::regprocedure), 'Vault reveal RPC is SECURITY DEFINER');
select ok(not has_function_privilege('anon', 'public.qnotes_vault_reveal_secret(uuid,uuid,uuid,text,uuid,text)', 'EXECUTE'), 'anon cannot execute the reveal RPC');
select ok(not has_function_privilege('authenticated', 'public.qnotes_vault_reveal_secret(uuid,uuid,uuid,text,uuid,text)', 'EXECUTE'), 'authenticated cannot execute the reveal RPC');
select ok(has_function_privilege('service_role', 'public.qnotes_vault_reveal_secret(uuid,uuid,uuid,text,uuid,text)', 'EXECUTE'), 'service_role can execute the reveal RPC');
