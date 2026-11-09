-- Launch Kit conversations, for databases that ran 003 before the launch mode existed.
-- Running it twice, or on a database that already has it, is harmless.
alter table agent_conversations drop constraint if exists agent_conversations_mode_check;
alter table agent_conversations add constraint agent_conversations_mode_check
  check (mode in ('site','posts','schedule','launch'));
