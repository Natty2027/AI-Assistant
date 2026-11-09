-- For databases created before posting to X, Facebook and Instagram existed.
-- New databases get this from schema.sql directly; running it twice is harmless.
alter table action_connections drop constraint if exists action_connections_provider_check;
alter table action_connections add constraint action_connections_provider_check
  check (provider in ('netlify','bluesky','x','facebook','instagram'));
