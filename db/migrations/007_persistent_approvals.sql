-- Approvals and finished assistant runs survive a restart or a deploy.
-- New databases get this from schema.sql directly; running it twice is harmless.

-- Proposals waiting for (or past) the person's approval: the whole record, and the hash of a live
-- approval token (never the token itself). Server-only.
create table if not exists agent_proposals (
  id          text primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  record      jsonb not null,
  token_hash  bytea,
  updated_at  timestamptz not null default now()
);
create index if not exists agent_proposals_user on agent_proposals (user_id);
revoke all on agent_proposals from anon, authenticated;
alter table agent_proposals enable row level security;

-- A finished background run's answer, kept for half an hour for the app to collect. Server-only.
create table if not exists agent_runs (
  id          uuid primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  state       jsonb not null,
  ended_at    timestamptz not null default now()
);
create index if not exists agent_runs_ended on agent_runs (ended_at);
revoke all on agent_runs from anon, authenticated;
alter table agent_runs enable row level security;
