-- Immutable, account-owned machine snapshots. Existing file-sync data is deliberately untouched.
begin;

create table public.pi_sync_backups (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid not null,
  device_name text not null check (char_length(device_name) between 1 and 80),
  created_at timestamptz not null default now(),
  file_count integer not null check (file_count between 1 and 5000),
  package_count integer not null check (package_count between 0 and 5000),
  total_bytes bigint not null check (total_bytes between 0 and 20971520),
  archive jsonb not null check (coalesce(
    archive->>'version' = '1'
    and archive->>'kind' = 'machine'
    and jsonb_typeof(archive->'files') = 'array'
    and jsonb_array_length(archive->'files') = file_count
    and octet_length(archive::text) <= 26214400,
    false
  ))
);

create index pi_sync_backups_account_date on public.pi_sync_backups (user_id, created_at desc);
alter table public.pi_sync_backups enable row level security;
revoke all on public.pi_sync_backups from public, anon, authenticated, service_role;
grant select, insert, delete on public.pi_sync_backups to service_role;

commit;
