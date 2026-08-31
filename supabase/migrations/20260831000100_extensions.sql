create schema if not exists notesdb;
create schema if not exists extensions;

create extension if not exists pgcrypto;
create extension if not exists vector with schema extensions;
create extension if not exists pgmq;
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;
create extension if not exists supabase_vault;
