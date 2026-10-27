-- IEM Careers database. Run once in Supabase: SQL Editor > New query > paste > Run.
create table if not exists public.docs (
  coll text not null check (coll in ('people','rsvp','profiles','openings','resources')),
  id text not null check (char_length(id) between 1 and 80),
  data jsonb not null default '{}'::jsonb check (octet_length(data::text) < 20000),
  owner uuid not null default auth.uid(),
  updated_at timestamptz not null default now(),
  primary key (coll, id)
);
create table if not exists public.admins (email text primary key);

alter table public.docs enable row level security;
alter table public.admins enable row level security;  -- no policies: nobody reads or edits it from the site

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')));
$$;
grant execute on function public.is_admin() to anon, authenticated;
grant usage on schema public to anon, authenticated;
grant select on public.docs to anon, authenticated;
grant insert, update, delete on public.docs to authenticated;

drop policy if exists docs_read on public.docs;
drop policy if exists docs_insert on public.docs;
drop policy if exists docs_update on public.docs;
drop policy if exists docs_delete on public.docs;

-- Everyone can read everything except RSVPs: each person sees their own, organisers see all.
create policy docs_read on public.docs for select
  using (coll <> 'rsvp' or id = auth.uid()::text or public.is_admin());

-- People write only their own name, ticks and RSVPs; anyone signed in can add openings and resources.
create policy docs_insert on public.docs for insert to authenticated
  with check (owner = auth.uid() and (
    (coll in ('people','rsvp','profiles') and id = auth.uid()::text) or coll in ('openings','resources')));

create policy docs_update on public.docs for update to authenticated
  using (owner = auth.uid() or (coll in ('openings','resources') and public.is_admin()))
  with check ((owner = auth.uid() and ((coll in ('people','rsvp','profiles') and id = auth.uid()::text) or coll in ('openings','resources')))
              or (coll in ('openings','resources') and public.is_admin()));

create policy docs_delete on public.docs for delete to authenticated
  using (owner = auth.uid() or (coll in ('openings','resources') and public.is_admin()));

-- Live updates
do $$ begin
  alter publication supabase_realtime add table public.docs;
exception when duplicate_object then null; end $$;

-- Organisers (run separately with your own email, don't commit it):
-- insert into public.admins (email) values ('you@example.com');
