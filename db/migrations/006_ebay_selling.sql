-- Selling on eBay: a new kind of connection (marketplace) and provider (ebay).
-- New databases get this from schema.sql directly; running it twice is harmless.
alter table action_connections drop constraint if exists action_connections_kind_check;
alter table action_connections add constraint action_connections_kind_check
  check (kind in ('hosting','social','marketplace','email','sms','ads','registrar'));
alter table action_connections drop constraint if exists action_connections_provider_check;
alter table action_connections add constraint action_connections_provider_check
  check (provider in ('netlify','bluesky','x','facebook','instagram','ebay'));
