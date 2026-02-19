create table if not exists public.call_requests (
  id bigint generated always as identity primary key,
  conversation_id bigint not null references public.conversations(id) on delete cascade,
  requester_id uuid not null references public.profiles(id) on delete cascade,
  accepted_by uuid references public.profiles(id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'rejected', 'ended', 'cancelled')),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists call_requests_conversation_status_created_idx
  on public.call_requests (conversation_id, status, created_at desc);

alter table public.call_requests enable row level security;

drop policy if exists "call_requests_select_authenticated" on public.call_requests;
create policy "call_requests_select_authenticated"
  on public.call_requests
  for select
  to authenticated
  using (true);

drop policy if exists "call_requests_insert_requester" on public.call_requests;
create policy "call_requests_insert_requester"
  on public.call_requests
  for insert
  to authenticated
  with check ((select auth.uid()) = requester_id);

drop policy if exists "call_requests_update_requester_or_acceptor" on public.call_requests;
create policy "call_requests_update_requester_or_acceptor"
  on public.call_requests
  for update
  to authenticated
  using ((status = 'pending') or ((select auth.uid()) = requester_id) or ((select auth.uid()) = accepted_by))
  with check (((select auth.uid()) = requester_id) or ((select auth.uid()) = accepted_by));

grant select, insert, update on public.call_requests to authenticated;
grant usage, select on all sequences in schema public to authenticated;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'call_requests'
  ) then
    alter publication supabase_realtime add table public.call_requests;
  end if;
end $$;
