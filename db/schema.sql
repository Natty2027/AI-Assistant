-- DELIVERABLE 3 (part 1) — schema, privacy toggle, and its enforcement.
--
-- The toggle is not a UI preference that the application layer politely respects. It is a
-- database constraint: when adaptive_automation_enabled is false, rows physically cannot be
-- written to the behavioural tables, and existing behavioural data is destroyed on the
-- transition. A bug in the app layer cannot produce a silent shadow profile.

create extension if not exists "pgcrypto";
-- Needed by the GiST index on events_cache: a uuid column has no GiST operator class without it.
create extension if not exists "btree_gist";
create extension if not exists "supabase_vault";   -- personal tier; enterprise swaps to KMS

-- ============================================================
-- Identity and settings
-- ============================================================

create type pcc_tier as enum ('personal', 'enterprise');

create table organizations (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  tier          pcc_tier not null default 'enterprise',
  -- Org policy can force the toggle off for every member; members cannot override.
  policy_forbid_adaptive boolean not null default false,
  data_region   text not null default 'us-east-1',
  retention_days integer not null default 365,
  created_at    timestamptz not null default now()
);

create table user_settings (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  -- org_id, tier and org_role are assigned by the server only. They are deliberately absent
  -- from the column grants in the RLS section, so a client cannot join an organization, claim
  -- the enterprise tier, or shed an org policy by nulling org_id.
  org_id        uuid references organizations(id) on delete cascade,
  org_role      text not null default 'member' check (org_role in ('member', 'admin')),
  tier          pcc_tier not null default 'personal',
  timezone      text not null default 'UTC',
  region        text,

  -- THE TOGGLE
  adaptive_automation_enabled boolean not null default false,
  adaptive_toggled_at         timestamptz,

  -- Auto-commit is a column so it is auditable, but the CHECK pins it false.
  -- Removing this constraint is a deliberate, reviewable act, not an accident.
  auto_commit_enabled boolean not null default false,
  constraint auto_commit_always_off check (auto_commit_enabled = false),

  tts_enabled   boolean not null default true,
  disclaimer_acknowledged_at timestamptz,

  -- Explicit consent to send the user's content (selected text, images) to the model provider.
  -- NULL means no consent: the server refuses to call the model. Written by the server only,
  -- so a client cannot assert consent it never gave. Revoking sets it back to NULL.
  ai_consent_at timestamptz,

  created_at    timestamptz not null default now()
);

-- ============================================================
-- OAuth token storage — envelope encryption, not E2EE. See README.
-- ============================================================

create type calendar_provider as enum ('google', 'microsoft', 'canvas_ical', 'blackboard_ical');

create table oauth_connections (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  provider          calendar_provider not null,
  account_email     text,

  -- Ciphertext only. Wrapped by a per-tenant data key, which is itself wrapped by the KMS
  -- master key. Plaintext exists only inside the sync worker's memory.
  access_token_ct   bytea not null,
  refresh_token_ct  bytea,
  data_key_id       text not null,
  key_version       integer not null default 1,

  scopes            text[] not null default '{}',
  expires_at        timestamptz,
  last_sync_at      timestamptz,
  revoked_at        timestamptz,
  created_at        timestamptz not null default now(),
  unique (user_id, provider, account_email)
);

-- Tokens are never selectable by the client role under any circumstance.
revoke all on oauth_connections from anon, authenticated;

-- ============================================================
-- Accounts the assistant may publish to (hosting today; social later)
-- ============================================================

-- Separate from oauth_connections: those are calendars the app reads and writes on the user's
-- behalf; these are places the assistant's work can be published, each action approved
-- individually. Same rule for both: the token is ciphertext, and no client role can read it.
create table action_connections (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  kind          text not null check (kind in ('hosting','social','email','sms','ads','registrar')),
  provider      text not null check (provider in ('netlify','bluesky','x','facebook','instagram')),
  label         text not null,
  token_ct      bytea not null,
  data_key_id   text not null,
  -- e.g. the Netlify site this connection publishes to, so the address stays the same
  target_ref    text,
  created_at    timestamptz not null default now(),
  revoked_at    timestamptz
);
create index on action_connections (user_id) where revoked_at is null;
revoke all on action_connections from anon, authenticated;
alter table action_connections enable row level security;

-- ============================================================
-- Hera's memory
-- ============================================================

-- One conversation with the assistant, so a reply continues the same task (the drafts, files
-- and plan so far) instead of starting over. Kept for a week after its last message, and deleted
-- with the account. Server-only: no client role can read it.
create table if not exists agent_conversations (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  mode        text not null check (mode in ('site','posts','schedule','launch')),
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

-- ============================================================
-- Disclosure acknowledgement — enforced, not decorative
-- ============================================================

-- The limits of each provider (especially: iCal feeds can never be written to) are shown
-- before the OAuth window opens, and acknowledged explicitly. This table is what makes that
-- a gate rather than a paragraph. A bug in the UI cannot skip it, because the trigger below
-- refuses the connection outright.

create table connection_disclosures (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  provider          calendar_provider not null,
  disclosure_version integer not null,
  acknowledged_at   timestamptz not null default now(),
  unique (user_id, provider, disclosure_version)
);

-- The current calendar-disclosure version (the calendar features that used it have been
-- removed from the server). Raising it invalidates prior acknowledgements.
create or replace function pcc_current_disclosure_version() returns integer
  language sql immutable as $$ select 1 $$;

-- Every SECURITY DEFINER function pins search_path. Without it, a caller who can create
-- objects in a schema earlier on their own search_path can shadow a table this function
-- reads and have it run their definition with the owner's privileges.
create or replace function pcc_require_disclosure()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not exists (
    select 1 from connection_disclosures d
     where d.user_id = new.user_id
       and d.provider = new.provider
       and d.disclosure_version = pcc_current_disclosure_version()
  ) then
    raise exception
      'pcc: cannot connect % — no current disclosure acknowledgement for this user',
      new.provider;
  end if;
  return new;
end;
$$;

create trigger trg_require_disclosure
  before insert on oauth_connections
  for each row execute function pcc_require_disclosure();

-- ============================================================
-- Events: mirrored, proposed, confirmed
-- ============================================================

-- Read-through mirror of every connected calendar. Powers conflict checking without a
-- round trip to three providers on every keystroke.
create table events_cache (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  provider      calendar_provider not null,
  provider_event_id text not null,
  title         text,
  start_time    timestamptz not null,
  end_time      timestamptz not null,
  all_day       boolean not null default false,
  busy          boolean not null default true,
  category      text not null default 'other'
                  check (category in ('exam','class','meeting','focus_block','assignment','other')),
  synced_at     timestamptz not null default now(),
  unique (user_id, provider, provider_event_id),
  constraint events_cache_ordered check (end_time >= start_time)
);

create index on events_cache (user_id, start_time, end_time);
-- Overlap queries in the conflict checker hit this directly.
create index on events_cache using gist (user_id, tstzrange(start_time, end_time, '[)'));

create type proposal_status as enum (
  'pending_confirmation', 'confirmed', 'rejected', 'expired', 'superseded'
);
create type proposal_source as enum ('vision', 'voice', 'chat', 'habit_engine');

create table proposed_events (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  source        proposal_source not null,
  source_ref    text,                       -- storage key of the image, transcript id, etc.

  title         text not null,
  start_time    timestamptz,
  end_time      timestamptz,
  all_day       boolean not null default false,
  location      text,
  description   text,

  confidence    jsonb not null default '{}'::jsonb,
  assumptions   jsonb not null default '[]'::jsonb,
  needs_review  jsonb not null default '[]'::jsonb,

  status        proposal_status not null default 'pending_confirmation',
  confirmed_at  timestamptz,
  written_event_id text,                    -- provider event id, set only after confirmation
  created_at    timestamptz not null default now()
);

-- The invariant the disclaimer depends on: nothing acquires a provider event id without
-- having been confirmed first.
alter table proposed_events add constraint no_write_without_confirmation
  check (written_event_id is null or (status = 'confirmed' and confirmed_at is not null));

create index on proposed_events (user_id, status, start_time);

-- ============================================================
-- Behavioural tables — gated on the toggle
-- ============================================================

create table habit_observations (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  -- Deliberately structural, not semantic. We store that an event of category X was moved
  -- from 18:00 to 19:30 on a Tuesday. We do not store the title or the attendees.
  category      text not null,
  day_of_week   smallint not null check (day_of_week between 0 and 6),
  original_start_minute integer,
  final_start_minute    integer not null check (final_start_minute between 0 and 1439),
  duration_minutes      integer,
  action        text not null check (action in ('created','moved','deleted','accepted','declined')),
  observed_at   timestamptz not null default now()
);

create table habit_profiles (
  user_id       uuid not null references auth.users(id) on delete cascade,
  category      text not null,
  day_of_week   smallint not null,
  median_start_minute integer not null,
  median_duration_minutes integer,
  sample_size   integer not null,
  confidence    real not null check (confidence between 0 and 1),
  updated_at    timestamptz not null default now(),
  primary key (user_id, category, day_of_week)
);

-- ---- Gate: reject writes when the toggle is off, at the storage layer. ----

create or replace function pcc_require_adaptive_enabled()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  enabled boolean;
  org_forbids boolean;
begin
  select s.adaptive_automation_enabled,
         coalesce(o.policy_forbid_adaptive, false)
    into enabled, org_forbids
    from user_settings s
    left join organizations o on o.id = s.org_id
   where s.user_id = new.user_id;

  if org_forbids then
    raise exception 'pcc: adaptive automation disabled by organization policy';
  end if;
  if not coalesce(enabled, false) then
    raise exception 'pcc: adaptive automation is OFF for this user';
  end if;
  return new;
end;
$$;

create trigger trg_gate_observations
  before insert or update on habit_observations
  for each row execute function pcc_require_adaptive_enabled();

create trigger trg_gate_profiles
  before insert or update on habit_profiles
  for each row execute function pcc_require_adaptive_enabled();

-- ---- Purge: turning the toggle off destroys the profile, immediately. ----

create or replace function pcc_purge_on_toggle_off()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  -- An org that forbids adaptive automation cannot have it switched on, by anyone.
  if new.adaptive_automation_enabled
     and not old.adaptive_automation_enabled
     and exists (select 1 from organizations o
                  where o.id = new.org_id and o.policy_forbid_adaptive) then
    raise exception 'pcc: adaptive automation disabled by organization policy';
  end if;

  if old.adaptive_automation_enabled and not new.adaptive_automation_enabled then
    delete from habit_observations where user_id = new.user_id;
    delete from habit_profiles     where user_id = new.user_id;
    delete from proposed_events
      where user_id = new.user_id
        and source = 'habit_engine'
        and status = 'pending_confirmation';
    new.adaptive_toggled_at := now();
  elsif not old.adaptive_automation_enabled and new.adaptive_automation_enabled then
    new.adaptive_toggled_at := now();
  end if;
  return new;
end;
$$;

create trigger trg_purge_on_toggle_off
  before update on user_settings
  for each row execute function pcc_purge_on_toggle_off();

-- ============================================================
-- Safety events — content-free by construction
-- ============================================================

create table safety_events (
  id          bigserial primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  kind        text not null check (kind in ('crisis_intercept','content_block','injection_blocked')),
  detector    text not null,
  occurred_at timestamptz not null default now()
);
-- No content column exists, so no code path can add one without a migration review.

-- ============================================================
-- Enterprise audit log — append-only
-- ============================================================

create table audit_log (
  id          bigserial primary key,
  org_id      uuid references organizations(id) on delete cascade,
  user_id     uuid references auth.users(id) on delete set null,
  action      text not null,
  target_type text,
  target_id   text,
  metadata    jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);

create rule audit_log_no_update as on update to audit_log do instead nothing;
create rule audit_log_no_delete as on delete to audit_log do instead nothing;

-- ============================================================
-- Row level security
-- ============================================================

alter table user_settings        enable row level security;
alter table oauth_connections    enable row level security;
alter table proposed_events      enable row level security;
alter table habit_observations   enable row level security;
alter table habit_profiles       enable row level security;
alter table events_cache         enable row level security;
alter table connection_disclosures enable row level security;
alter table safety_events        enable row level security;
alter table audit_log            enable row level security;

create policy own_settings on user_settings
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- RLS decides WHICH rows a user touches; these grants decide WHICH COLUMNS. Without them the
-- policy above lets a user rewrite org_id (to escape an org policy), tier, or org_role (to
-- read another organization's audit log). Deleting the row is also withheld, since the row
-- is what carries the toggle and the consent state; the server removes it on account deletion.
revoke all on user_settings from anon, authenticated;
grant select on user_settings to authenticated;
grant insert (user_id, timezone, region, tts_enabled) on user_settings to authenticated;
grant update (timezone, region, adaptive_automation_enabled, tts_enabled,
              disclaimer_acknowledged_at) on user_settings to authenticated;

create policy own_proposals on proposed_events
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Behavioural rows are readable by their owner and only while the toggle is on.
create policy own_observations on habit_observations
  for select using (
    user_id = auth.uid()
    and exists (select 1 from user_settings s
                 where s.user_id = auth.uid() and s.adaptive_automation_enabled)
  );

create policy own_profiles on habit_profiles
  for select using (
    user_id = auth.uid()
    and exists (select 1 from user_settings s
                 where s.user_id = auth.uid() and s.adaptive_automation_enabled)
  );

create policy own_events_cache on events_cache
  for select using (user_id = auth.uid());

-- Users may insert their own acknowledgement; they may never delete one, because deleting
-- it would let a client re-open the connect path without re-reading the disclosure.
create policy own_disclosures_read on connection_disclosures
  for select using (user_id = auth.uid());
create policy own_disclosures_insert on connection_disclosures
  for insert with check (user_id = auth.uid());

create policy own_safety_events on safety_events
  for select using (user_id = auth.uid());

-- Audit log: org ADMINS read their own org, nobody writes from the client. Membership alone
-- is not enough; org_role and org_id are server-assigned (see the column grants above).
create policy org_admin_reads_audit on audit_log
  for select using (
    org_id in (select org_id from user_settings
                where user_id = auth.uid() and tier = 'enterprise' and org_role = 'admin')
  );

-- No policy grants INSERT on oauth_connections to authenticated; the server role only.
