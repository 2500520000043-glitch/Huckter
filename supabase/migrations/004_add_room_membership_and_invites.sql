create table if not exists public.conversation_members (
  conversation_id bigint not null references public.conversations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz not null default timezone('utc', now()),
  primary key (conversation_id, user_id)
);

create index if not exists conversation_members_user_idx
  on public.conversation_members (user_id, conversation_id);

create table if not exists public.room_invites (
  id bigint generated always as identity primary key,
  conversation_id bigint not null references public.conversations(id) on delete cascade,
  token text not null unique,
  created_by uuid not null references public.profiles(id) on delete cascade,
  active boolean not null default true,
  max_uses int,
  used_count int not null default 0,
  expires_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint room_invites_max_uses_check check (max_uses is null or max_uses > 0),
  constraint room_invites_used_count_check check (used_count >= 0)
);

create index if not exists room_invites_conversation_active_idx
  on public.room_invites (conversation_id, active, created_at desc);

alter table public.conversation_members enable row level security;
alter table public.room_invites enable row level security;

alter table public.conversations enable row level security;
drop policy if exists "conversations_select_authenticated" on public.conversations;
create policy "conversations_select_member"
  on public.conversations
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.conversation_members m
      where m.conversation_id = conversations.id
        and m.user_id = (select auth.uid())
    )
  );

drop policy if exists "conversations_update_creator" on public.conversations;
create policy "conversations_update_creator"
  on public.conversations
  for update
  to authenticated
  using ((select auth.uid()) = created_by)
  with check ((select auth.uid()) = created_by);

drop policy if exists "conversations_insert_authenticated" on public.conversations;
create policy "conversations_insert_authenticated"
  on public.conversations
  for insert
  to authenticated
  with check ((select auth.uid()) = created_by);

alter table public.messages enable row level security;
drop policy if exists "messages_select_authenticated" on public.messages;
create policy "messages_select_member"
  on public.messages
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.conversation_members m
      where m.conversation_id = messages.conversation_id
        and m.user_id = (select auth.uid())
    )
  );

drop policy if exists "messages_insert_sender" on public.messages;
create policy "messages_insert_member_sender"
  on public.messages
  for insert
  to authenticated
  with check (
    (select auth.uid()) = sender_id
    and exists (
      select 1
      from public.conversation_members m
      where m.conversation_id = messages.conversation_id
        and m.user_id = (select auth.uid())
    )
  );

alter table public.call_requests enable row level security;
drop policy if exists "call_requests_select_authenticated" on public.call_requests;
create policy "call_requests_select_member"
  on public.call_requests
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.conversation_members m
      where m.conversation_id = call_requests.conversation_id
        and m.user_id = (select auth.uid())
    )
  );

drop policy if exists "call_requests_insert_requester" on public.call_requests;
create policy "call_requests_insert_requester_member"
  on public.call_requests
  for insert
  to authenticated
  with check (
    (select auth.uid()) = requester_id
    and exists (
      select 1
      from public.conversation_members m
      where m.conversation_id = call_requests.conversation_id
        and m.user_id = (select auth.uid())
    )
  );

drop policy if exists "call_requests_update_requester_or_acceptor" on public.call_requests;
create policy "call_requests_update_member"
  on public.call_requests
  for update
  to authenticated
  using (
    exists (
      select 1
      from public.conversation_members m
      where m.conversation_id = call_requests.conversation_id
        and m.user_id = (select auth.uid())
    )
  )
  with check (
    exists (
      select 1
      from public.conversation_members m
      where m.conversation_id = call_requests.conversation_id
        and m.user_id = (select auth.uid())
    )
    and (
      requester_id = (select auth.uid())
      or accepted_by = (select auth.uid())
      or (status in ('accepted', 'rejected') and accepted_by = (select auth.uid()))
    )
  );

drop policy if exists "conversation_members_select_own" on public.conversation_members;
create policy "conversation_members_select_own"
  on public.conversation_members
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "conversation_members_insert_creator_self" on public.conversation_members;
create policy "conversation_members_insert_creator_self"
  on public.conversation_members
  for insert
  to authenticated
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1
      from public.conversations c
      where c.id = conversation_members.conversation_id
        and c.created_by = (select auth.uid())
    )
  );

drop policy if exists "room_invites_select_member" on public.room_invites;
create policy "room_invites_select_member"
  on public.room_invites
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.conversation_members m
      where m.conversation_id = room_invites.conversation_id
        and m.user_id = (select auth.uid())
    )
  );

drop policy if exists "room_invites_update_creator" on public.room_invites;
create policy "room_invites_update_creator"
  on public.room_invites
  for update
  to authenticated
  using ((select auth.uid()) = created_by)
  with check ((select auth.uid()) = created_by);

create or replace function public.create_conversation_room(
  p_name text,
  p_description text default ''
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid;
  v_conversation_id bigint;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  insert into public.conversations(name, description, created_by)
  values (coalesce(nullif(trim(p_name), ''), 'Untitled Room'), coalesce(p_description, ''), v_uid)
  returning id into v_conversation_id;

  insert into public.conversation_members(conversation_id, user_id)
  values (v_conversation_id, v_uid)
  on conflict do nothing;

  return v_conversation_id;
end;
$$;

grant execute on function public.create_conversation_room(text, text) to authenticated;

create or replace function public.create_room_invite(
  p_conversation_id bigint,
  p_max_uses int default 1,
  p_expires_in_minutes int default 1440
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid;
  v_token text;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  if not exists (
    select 1
    from public.conversation_members m
    where m.conversation_id = p_conversation_id
      and m.user_id = v_uid
  ) then
    raise exception 'Not a member of this room';
  end if;

  v_token := replace(gen_random_uuid()::text, '-', '');

  insert into public.room_invites(
    conversation_id,
    token,
    created_by,
    max_uses,
    expires_at,
    active
  )
  values (
    p_conversation_id,
    v_token,
    v_uid,
    case when p_max_uses is null or p_max_uses <= 0 then 1 else p_max_uses end,
    case
      when p_expires_in_minutes is null or p_expires_in_minutes <= 0 then null
      else timezone('utc', now()) + make_interval(mins => p_expires_in_minutes)
    end,
    true
  );

  return v_token;
end;
$$;

grant execute on function public.create_room_invite(bigint, int, int) to authenticated;

create or replace function public.accept_room_invite(p_token text)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid;
  v_invite record;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  select id, conversation_id, active, max_uses, used_count, expires_at
  into v_invite
  from public.room_invites
  where token = p_token
  for update;

  if not found then
    raise exception 'Invite not found';
  end if;

  if v_invite.active is not true then
    raise exception 'Invite is inactive';
  end if;

  if v_invite.expires_at is not null and v_invite.expires_at < timezone('utc', now()) then
    raise exception 'Invite expired';
  end if;

  if v_invite.max_uses is not null and v_invite.used_count >= v_invite.max_uses then
    raise exception 'Invite usage limit reached';
  end if;

  insert into public.conversation_members(conversation_id, user_id)
  values (v_invite.conversation_id, v_uid)
  on conflict do nothing;

  update public.room_invites
  set used_count = used_count + 1,
      updated_at = timezone('utc', now())
  where id = v_invite.id;

  return v_invite.conversation_id;
end;
$$;

grant execute on function public.accept_room_invite(text) to authenticated;

insert into public.conversation_members(conversation_id, user_id)
select c.id, c.created_by
from public.conversations c
where c.created_by is not null
on conflict do nothing;
