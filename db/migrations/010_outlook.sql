-- Outlook: a new provider (Microsoft, for sending emails the person approves and, if they turn it
-- on, reading their inbox), and the per-account switch for reading. Reading is off by default.
-- New databases get this from schema.sql directly; running it twice is harmless.
alter table action_connections drop constraint if exists action_connections_provider_check;
alter table action_connections add constraint action_connections_provider_check
  check (provider in ('netlify','bluesky','x','facebook','instagram','ebay','outlook'));
alter table action_connections add column if not exists read_inbox boolean not null default false;
