-- For databases created from db/schema.sql before Bluesky publishing existed.
-- New databases get this from schema.sql directly; running it twice is harmless.
alter table action_connections drop constraint if exists action_connections_provider_check;
alter table action_connections add constraint action_connections_provider_check
  check (provider in ('netlify','bluesky'));
