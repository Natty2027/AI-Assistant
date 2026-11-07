/**
 * Reading and writing oauth_connections. The query function is passed in, so the same SQL runs
 * against Postgres in production and against PGlite in tests.
 */
import type { CalProvider, StoredConn, TokenStore } from "./calendar.ts";

export type Run = (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;

export interface NewConnection {
  userId: string;
  provider: CalProvider;
  email: string | null;
  accessCt: Buffer;
  refreshCt: Buffer | null;
  dataKeyId: string;
  scopes: string[];
  expiresInSeconds: number;
}

/**
 * Insert-or-replace. Reconnecting the same account must update the existing row: the table is
 * unique on (user, provider, email), so a plain insert fails with a constraint error the
 * second time anyone connects. The BEFORE INSERT disclosure trigger still fires on this
 * statement, so an upsert cannot be used to skip the acknowledgement.
 *
 * Rows with no email never conflict, so those older rows are cleared explicitly afterwards.
 * That delete runs only after the insert succeeded, so a refused connection cannot remove a
 * working one.
 */
export async function saveConnection(run: Run, c: NewConnection): Promise<string> {
  const { rows } = await run(
    `insert into oauth_connections
       (user_id, provider, account_email, access_token_ct, refresh_token_ct, data_key_id,
        scopes, expires_at)
     values ($1,$2,$3,$4,$5,$6,$7, now() + ($8 || ' seconds')::interval)
     on conflict (user_id, provider, account_email) do update set
       access_token_ct  = excluded.access_token_ct,
       refresh_token_ct = coalesce(excluded.refresh_token_ct, oauth_connections.refresh_token_ct),
       data_key_id      = excluded.data_key_id,
       scopes           = excluded.scopes,
       expires_at       = excluded.expires_at,
       revoked_at       = null
     returning id`,
    [c.userId, c.provider, c.email, c.accessCt, c.refreshCt, c.dataKeyId, c.scopes, String(c.expiresInSeconds)]
  );
  const id: string = rows[0].id;
  await run(
    `delete from oauth_connections
      where user_id = $1 and provider = $2 and id <> $3 and account_email is not distinct from $4`,
    [c.userId, c.provider, id, c.email]
  );
  return id;
}

/** Live (not revoked) calendar connections that can be read through an API. */
export async function loadConnections(run: Run, userId: string, provider?: CalProvider): Promise<StoredConn[]> {
  const { rows } = await run(
    `select id, provider, data_key_id, access_token_ct, refresh_token_ct, expires_at
       from oauth_connections
      where user_id = $1 and revoked_at is null and provider in ('google','microsoft')
        and ($2::text is null or provider::text = $2)
      order by created_at`,
    [userId, provider ?? null]
  );
  return rows as StoredConn[];
}

export function tokenStore(run: Run): TokenStore {
  return {
    async save(connId, access, refresh, expiresAt) {
      await run(
        `update oauth_connections
            set access_token_ct = $2, refresh_token_ct = $3, expires_at = $4
          where id = $1`,
        [connId, access, refresh, expiresAt.toISOString()]
      );
    },
  };
}

/** The provider said the grant is gone. Stop using it until the user reconnects. */
export async function markRevoked(run: Run, connId: string): Promise<void> {
  await run(`update oauth_connections set revoked_at = now() where id = $1`, [connId]);
}
