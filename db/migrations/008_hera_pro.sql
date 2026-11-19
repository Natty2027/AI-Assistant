-- Hera Pro and monthly request counts.
-- New databases get this from schema.sql directly; running it twice is harmless.

-- The person's Pro subscription, from a verified App Store purchase. One subscription belongs to
-- one Hera account. Server-only.
create table if not exists user_plans (
  user_id                  uuid primary key references auth.users(id) on delete cascade,
  product_id               text not null,
  original_transaction_id  text not null unique,
  expires_at               timestamptz not null,
  environment              text not null,
  updated_at               timestamptz not null default now()
);
revoke all on user_plans from anon, authenticated;
alter table user_plans enable row level security;

-- Requests to Hera per person per month (YYYY-MM, UTC), for the monthly limit. Server-only.
create table if not exists agent_usage (
  user_id   uuid not null references auth.users(id) on delete cascade,
  month     text not null check (month ~ '^\d{4}-\d{2}$'),
  requests  integer not null default 0,
  primary key (user_id, month)
);
revoke all on agent_usage from anon, authenticated;
alter table agent_usage enable row level security;
