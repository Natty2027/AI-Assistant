/**
 * A PGlite database with db/schema.sql loaded and Supabase's auth stubs in place, for tests that
 * need real SQL behaviour (constraints, triggers, conflict handling) rather than a mock.
 * Not Supabase itself; see test/schema.test.ts for what is and is not stubbed.
 */
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";

export type Run = (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;

export async function makeDb(): Promise<{ db: PGlite; run: Run }> {
  const db = new PGlite({ extensions: { btree_gist } });
  await db.exec(`
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create role anon nologin;
    create role authenticated nologin;
    grant usage on schema auth, public to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
    alter default privileges in schema public grant all on tables to anon, authenticated;
  `);
  const sql = readFileSync(new URL("../../db/schema.sql", import.meta.url), "utf8")
    .replace(/create extension if not exists "pgcrypto";/i, "")
    .replace(/create extension if not exists "supabase_vault";[^\n]*/i, "");
  await db.exec(sql);
  const run: Run = async (text, params = []) => {
    const r = await db.query(text, params as any[]);
    return { rows: r.rows as any[] };
  };
  return { db, run };
}

export async function addUser(db: PGlite, id: string): Promise<void> {
  await db.exec(`insert into auth.users (id) values ('${id}') on conflict do nothing;
                 insert into user_settings (user_id) values ('${id}') on conflict do nothing;`);
}
