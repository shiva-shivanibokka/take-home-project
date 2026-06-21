-- Enable Supabase Realtime on the tables the board subscribes to.
-- Run once after creating the schema.
-- In Supabase: Database → Replication → Tables, or run this SQL.

begin;
  -- Add tables to the realtime publication
  alter publication supabase_realtime add table jobs;
  alter publication supabase_realtime add table events;
  alter publication supabase_realtime add table handoffs;
  alter publication supabase_realtime add table reviews;
commit;
