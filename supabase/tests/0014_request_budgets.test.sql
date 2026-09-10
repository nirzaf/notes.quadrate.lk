begin;
select plan(14);

select ok(to_regprocedure('public.qnotes_consume_request_budget(text,text,integer,integer,integer)') is not null, 'request budget RPC exists');
select ok((select p.prosecdef from pg_proc p where p.oid = 'public.qnotes_consume_request_budget(text,text,integer,integer,integer)'::regprocedure), 'request budget RPC is SECURITY DEFINER');
select ok(not has_function_privilege('anon', 'public.qnotes_consume_request_budget(text,text,integer,integer,integer)', 'EXECUTE'), 'anon cannot execute the request budget RPC');
select ok(not has_function_privilege('authenticated', 'public.qnotes_consume_request_budget(text,text,integer,integer,integer)', 'EXECUTE'), 'authenticated cannot execute the request budget RPC');
select ok(has_function_privilege('service_role', 'public.qnotes_consume_request_budget(text,text,integer,integer,integer)', 'EXECUTE'), 'service_role can execute the request budget RPC');

select is((select allowed from public.qnotes_consume_request_budget('public-share', repeat('a', 64), 2, 60, 1)), true, 'the first request in a bucket is allowed');
select is((select request_count from public.qnotes_consume_request_budget('public-share', repeat('a', 64), 2, 60, 1)), 2, 'the atomic counter records the request count');
select is((select allowed from public.qnotes_consume_request_budget('public-share', repeat('a', 64), 2, 60, 1)), false, 'the shared counter rejects requests over the limit');
select ok((select retry_after_seconds > 0 from public.qnotes_consume_request_budget('public-share', repeat('a', 64), 2, 60, 1)), 'a rejected request receives a retry delay');
select is((select allowed from public.qnotes_consume_request_budget('public-share', repeat('b', 64), 2, 60, 1)), true, 'a separate principal has a separate budget');
select is((select allowed from public.qnotes_consume_request_budget('oauth', repeat('a', 64), 1, 60, 1)), true, 'budget buckets are independent');
select is((select allowed from public.qnotes_consume_request_budget('oauth', repeat('a', 64), 1, 60, 1)), false, 'the OAuth bucket has its own limit');
select throws_ok($$select * from public.qnotes_consume_request_budget('unknown', repeat('a', 64), 1, 60, 1)$$, 'P0001', 'bucket is invalid', 'unknown budget buckets are rejected');
select throws_ok($$select * from public.qnotes_consume_request_budget('oauth', 'not-a-hash', 1, 60, 1)$$, 'P0001', 'principal hash is invalid', 'raw limiter keys are rejected');

select * from finish();
rollback;
