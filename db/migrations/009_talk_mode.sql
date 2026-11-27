-- Talk conversations (spoken back-and-forth with Hera), for databases created before the talk
-- mode existed. Until it's run, talk conversations are kept in the server's memory instead.
-- Running it twice, or on a database that already has it, is harmless.
alter table agent_conversations drop constraint if exists agent_conversations_mode_check;
alter table agent_conversations add constraint agent_conversations_mode_check
  check (mode in ('site','posts','schedule','launch','talk'));
