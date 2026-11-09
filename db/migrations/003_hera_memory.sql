-- For databases created before Hera could remember conversations and facts.
-- New databases get this from schema.sql directly; running it twice is harmless.


-- One conversation with the assistant, so a reply continues the same task (the drafts, files
-- and plan so far) instead of starting over. Kept for a week after its last message, and deleted
-- with the account. Server-only: no client role can read it.
create table if not exists agent_conversations (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  mode        text not null check (mode in ('site','posts','schedule')),
  -- The model conversation so far, and the drafts and taint it carries between turns.
  state       jsonb not null,
  updated_at  timestamptz not null default now()
);
create index if not exists agent_conversations_user on agent_conversations (user_id, updated_at desc);
revoke all on agent_conversations from anon, authenticated;
alter table agent_conversations enable row level security;

-- Lasting facts the person told Hera (business name, hours, tone...), used in every task. The
-- person sees and deletes them in Settings.
create table if not exists agent_memories (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  text        text not null check (char_length(text) between 1 and 300),
  created_at  timestamptz not null default now()
);
create index if not exists agent_memories_user on agent_memories (user_id, created_at);
revoke all on agent_memories from anon, authenticated;
alter table agent_memories enable row level security;
