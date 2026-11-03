-- Run in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.
-- Safe to run more than once. Nothing here touches the data already in lesson_calendar_backup.

-- 1) Main backup table: RLS on, a signed-in user can only touch their own row, anon gets nothing.
alter table public.lesson_calendar_backup enable row level security;
alter table public.lesson_calendar_backup force row level security;
revoke all on public.lesson_calendar_backup from anon;

drop policy if exists lcb_select on public.lesson_calendar_backup;
drop policy if exists lcb_insert on public.lesson_calendar_backup;
drop policy if exists lcb_update on public.lesson_calendar_backup;
drop policy if exists lcb_delete on public.lesson_calendar_backup;
create policy lcb_select on public.lesson_calendar_backup for select to authenticated using (user_id = auth.uid());
create policy lcb_insert on public.lesson_calendar_backup for insert to authenticated with check (user_id = auth.uid());
create policy lcb_update on public.lesson_calendar_backup for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy lcb_delete on public.lesson_calendar_backup for delete to authenticated using (user_id = auth.uid());

-- 2) History: up to 5 snapshots a day; the day's last is kept 30 days, the others 3 days (the app enforces both).
create table if not exists public.lesson_calendar_backup_history (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  data        jsonb not null,
  events      int not null default 0,        -- counts, so the list does not have to download every snapshot
  enrollments int not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists lcbh_user_created on public.lesson_calendar_backup_history (user_id, created_at desc);

alter table public.lesson_calendar_backup_history enable row level security;
alter table public.lesson_calendar_backup_history force row level security;
revoke all on public.lesson_calendar_backup_history from anon;
grant select, insert, update, delete on public.lesson_calendar_backup_history to authenticated;

drop policy if exists lcbh_select on public.lesson_calendar_backup_history;
drop policy if exists lcbh_insert on public.lesson_calendar_backup_history;
drop policy if exists lcbh_update on public.lesson_calendar_backup_history;
drop policy if exists lcbh_delete on public.lesson_calendar_backup_history;
create policy lcbh_select on public.lesson_calendar_backup_history for select to authenticated using (user_id = auth.uid());
create policy lcbh_insert on public.lesson_calendar_backup_history for insert to authenticated with check (user_id = auth.uid());
create policy lcbh_update on public.lesson_calendar_backup_history for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy lcbh_delete on public.lesson_calendar_backup_history for delete to authenticated using (user_id = auth.uid());

-- ===================== Verification (run these separately, read-only) =====================
-- a) RLS must be true for both tables:
--   select relname, relrowsecurity as rls_on, relforcerowsecurity as rls_forced
--   from pg_class where relname in ('lesson_calendar_backup','lesson_calendar_backup_history');
-- b) Policies: every row should say roles = {authenticated} and reference auth.uid(); no policy for anon/public:
--   select tablename, policyname, cmd, roles, qual, with_check
--   from pg_policies where tablename in ('lesson_calendar_backup','lesson_calendar_backup_history') order by 1, 2;
-- c) Anon must have no privileges (expect 0 rows):
--   select table_name, privilege_type from information_schema.role_table_grants
--   where grantee = 'anon' and table_name in ('lesson_calendar_backup','lesson_calendar_backup_history');
-- d) Latest backup times:
--   select user_id, updated_at from public.lesson_calendar_backup;
--   select user_id, created_at, events, enrollments from public.lesson_calendar_backup_history order by created_at desc limit 5;
