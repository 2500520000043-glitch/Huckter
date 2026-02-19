create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  team_name text,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.conversations (
  id bigint generated always as identity primary key,
  name text not null,
  description text not null default '',
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.messages (
  id bigint generated always as identity primary key,
  conversation_id bigint not null references public.conversations(id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  content text not null check (char_length(content) > 0 and char_length(content) <= 4000),
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists messages_conversation_created_idx
  on public.messages (conversation_id, created_at desc);

alter table public.profiles enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;

drop policy if exists "profiles_select_authenticated" on public.profiles;
create policy "profiles_select_authenticated"
  on public.profiles
  for select
  to authenticated
  using (true);

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own"
  on public.profiles
  for insert
  to authenticated
  with check (auth.uid() = id);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
  on public.profiles
  for update
  to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

drop policy if exists "conversations_select_authenticated" on public.conversations;
create policy "conversations_select_authenticated"
  on public.conversations
  for select
  to authenticated
  using (true);

drop policy if exists "conversations_insert_authenticated" on public.conversations;
create policy "conversations_insert_authenticated"
  on public.conversations
  for insert
  to authenticated
  with check (auth.uid() = created_by);

drop policy if exists "conversations_update_creator" on public.conversations;
create policy "conversations_update_creator"
  on public.conversations
  for update
  to authenticated
  using (auth.uid() = created_by)
  with check (auth.uid() = created_by);

drop policy if exists "messages_select_authenticated" on public.messages;
create policy "messages_select_authenticated"
  on public.messages
  for select
  to authenticated
  using (true);

drop policy if exists "messages_insert_sender" on public.messages;
create policy "messages_insert_sender"
  on public.messages
  for insert
  to authenticated
  with check (auth.uid() = sender_id);

grant usage on schema public to anon, authenticated;
grant select, insert, update on public.profiles to authenticated;
grant select, insert, update on public.conversations to authenticated;
grant select, insert on public.messages to authenticated;
grant usage, select on all sequences in schema public to authenticated;

do $$
begin
  if not exists (select 1 from public.conversations) then
    insert into public.conversations(name, description, created_by)
    values
      ('Brand Lab', 'Launch Squad coordination', null),
      ('Product Rituals', 'Design and roadmap sync', null),
      ('Engineering Pulse', 'Build quality and release updates', null);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'messages'
  ) then
    alter publication supabase_realtime add table public.messages;
  end if;
end $$;
