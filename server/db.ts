/**
 * Postgres access. A single lazily-created pool shared across the process.
 *
 * NO-DB mode: when DATABASE_URL is unset the pool is never created and pool() throws an
 * HttpError(503). This lets the server boot and serve /health and the OAuth *start* leg
 * before a database exists — the user is attaching the database as a later step, and the
 * server should not crash-loop in the meantime.
 *
 * The existing engine modules (adaptive/engine.ts, vision/imageToEvents.ts) accept a `pg`
 * Pool directly, so pool() returns exactly that type and is passed straight through.
 */
import * as pg from "pg";
import { config } from "./config.ts";
import { HttpError } from "./http.ts";

let _pool: pg.Pool | null = null;

/**
 * TLS to Postgres. With DATABASE_CA set (the PEM from Supabase > Database > SSL), the server
 * verifies the certificate chain, so a network attacker cannot impersonate the database.
 * Without it the connection is still encrypted but NOT authenticated, which is the previous
 * behaviour, kept so a first deploy does not fail to connect. The warning is deliberate:
 * set DATABASE_CA before this holds real user data.
 */
function sslOptions(): pg.ConnectionConfig["ssl"] {
  if (!config.databaseUrl || config.databaseUrl.includes("localhost")) return undefined;
  if (config.databaseCa) return { ca: config.databaseCa, rejectUnauthorized: true };
  console.warn("[db] DATABASE_CA is not set: the database certificate is not being verified.");
  return { rejectUnauthorized: false };
}

export function pool(): pg.Pool {
  if (!config.databaseUrl) {
    throw new HttpError(503, "This action needs a database, which isn't connected yet.");
  }
  if (!_pool) {
    _pool = new pg.Pool({
      connectionString: config.databaseUrl,
      ssl: sslOptions(),
      max: 10,
      idleTimeoutMillis: 30_000,
    });
    _pool.on("error", (err) => console.error("[db] idle client error:", err.message));
  }
  return _pool;
}

/** Convenience for one-shot queries where a full pool handle isn't needed. */
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params: unknown[] = []
): Promise<pg.QueryResult<T>> {
  return pool().query<T>(sql, params);
}

/** True when a connection string is configured (not whether it actually connects). */
export function dbConfigured(): boolean {
  return Boolean(config.databaseUrl);
}

/** Best-effort connectivity probe for the health check. */
export async function dbReachable(): Promise<boolean> {
  if (!config.databaseUrl) return false;
  try {
    await pool().query("select 1");
    return true;
  } catch {
    return false;
  }
}

export async function closePool(): Promise<void> {
  if (_pool) { await _pool.end(); _pool = null; }
}
