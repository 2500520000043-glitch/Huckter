create index if not exists conversations_created_by_idx on public.conversations(created_by);
create index if not exists messages_sender_id_idx on public.messages(sender_id);

alter policy "profiles_insert_own"
on public.profiles
with check ((select auth.uid()) = id);

alter policy "profiles_update_own"
on public.profiles
using ((select auth.uid()) = id)
with check ((select auth.uid()) = id);

alter policy "conversations_insert_authenticated"
on public.conversations
with check ((select auth.uid()) = created_by);

alter policy "conversations_update_creator"
on public.conversations
using ((select auth.uid()) = created_by)
with check ((select auth.uid()) = created_by);

alter policy "messages_insert_sender"
on public.messages
with check ((select auth.uid()) = sender_id);
