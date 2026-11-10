-- Running it twice is harmless.
-- The organizations table had no row-level security, so the public (anon) key that ships in the
-- app could read or change it through Supabase's REST API. Only the server uses it.
revoke all on organizations from anon, authenticated;
alter table organizations enable row level security;
