-- =============================================================
-- MIGRATION: per-proctor privacy
-- Run this ONCE in the Supabase SQL Editor (after the original
-- schema has been created). It gives every proctor their own
-- private register: each row is tagged with an owner and the
-- database refuses to show it to anyone else.
-- =============================================================

-- 1) tag every table with an owner
alter table students add column if not exists owner_id uuid;
alter table history  add column if not exists owner_id uuid;
alter table settings add column if not exists owner_id uuid;

-- 2) backfill existing rows to your (first) account
update students
  set owner_id = (select id from auth.users order by created_at limit 1)
  where owner_id is null;
update history
  set owner_id = (select s.owner_id from students s where s.id = history.student_id)
  where owner_id is null;
update settings
  set owner_id = (select id from auth.users order by created_at limit 1)
  where owner_id is null;

-- 3) settings: allow the same key for different proctors
alter table settings drop constraint settings_pkey;
alter table settings add primary key (owner_id, key);

-- 4) default owner on brand-new rows (the app sets it too)
alter table students alter column owner_id set default auth.uid();
alter table history  alter column owner_id set default auth.uid();

-- 5) helper indexes so owner-scoped queries stay fast
create index if not exists students_owner_idx on students (owner_id);
create index if not exists history_owner_idx  on history (owner_id);

-- 6) replace the open "any proctor can do anything" policies
--    with strict per-owner ones (enforced by the database)
drop policy if exists "proctors manage students" on students;
drop policy if exists "proctors manage history"  on history;
drop policy if exists "proctors manage settings" on settings;

create policy "own students" on students
  for all using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));
create policy "own history" on history
  for all using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));
create policy "own settings" on settings
  for all using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

-- 7) the student-ID uniqueness rule must be per proctor, not global:
--    without this, two proctors cannot both register student "A123".
--    The normalisation matches the app exactly (lowercase, a-z0-9 only).
drop index if exists students_sid_uniq;
create unique index if not exists students_owner_sid_uniq
  on students (owner_id, regexp_replace(lower(student_id), '[^a-z0-9]', '', 'g'));

-- 8) default owner on settings rows too, and make the columns
--    required — but only if the backfill above left nothing behind
--    (it stays optional when no account existed at migration time)
alter table settings alter column owner_id set default auth.uid();
do $$
begin
  if not exists (select 1 from students where owner_id is null)
     and not exists (select 1 from history  where owner_id is null)
     and not exists (select 1 from settings where owner_id is null) then
    alter table students alter column owner_id set not null;
    alter table history  alter column owner_id set not null;
    alter table settings alter column owner_id set not null;
  end if;
end $$;
