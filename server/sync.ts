/**
 * Mirrors the next week of each connected calendar into events_cache, which is what the
 * "may the assistant speak right now" resolver and the conflict checker read.
 *
 * Read-only toward the provider. A failure on one provider never stops the others, and a
 * provider that says the grant is gone is marked revoked so it is not hammered every minute.
 */
import { freshAccessToken, listEvents, ProviderError, type CalProvider, type FetchLike } from "./calendar.ts";
import { loadConnections, markRevoked, tokenStore, type Run } from "./connections.ts";
import type { ProviderOAuthConfig } from "./config.ts";

export interface SyncDeps {
  run: Run;
  fetch: FetchLike;
  cfg: Partial<Record<CalProvider, ProviderOAuthConfig | undefined>>;
}

export interface SyncResult {
  synced: number;
  /** Providers whose sign-in has lapsed and need reconnecting. */
  reconnect: CalProvider[];
  /** Providers that could not be reached this time. */
  failed: CalProvider[];
}

const LOOKBACK_MS = 60 * 60_000;        // an event that began an hour ago may still be running
const WINDOW_MS = 7 * 24 * 3_600_000;

export async function syncUser(deps: SyncDeps, userId: string, now = new Date()): Promise<SyncResult> {
  const { run } = deps;
  const from = new Date(now.getTime() - LOOKBACK_MS);
  const to = new Date(now.getTime() + WINDOW_MS);
  const result: SyncResult = { synced: 0, reconnect: [], failed: [] };

  for (const conn of await loadConnections(run, userId)) {
    const cfg = deps.cfg[conn.provider];
    if (!cfg) { result.failed.push(conn.provider); continue; }

    let events;
    try {
      const token = await freshAccessToken(conn, cfg, tokenStore(run), deps.fetch);
      events = await listEvents(conn.provider, token, from, to, deps.fetch);
    } catch (e) {
      if (e instanceof ProviderError && e.kind === "unauthorized") {
        await markRevoked(run, conn.id);
        result.reconnect.push(conn.provider);
      } else {
        result.failed.push(conn.provider);
      }
      continue;
    }

    const stamp = new Date().toISOString();
    for (const ev of events) {
      await run(
        `insert into events_cache
           (user_id, provider, provider_event_id, title, start_time, end_time, all_day, busy, category, synced_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         on conflict (user_id, provider, provider_event_id) do update set
           title = excluded.title, start_time = excluded.start_time, end_time = excluded.end_time,
           all_day = excluded.all_day, busy = excluded.busy, category = excluded.category,
           synced_at = excluded.synced_at`,
        [userId, conn.provider, ev.id, ev.title.slice(0, 300), ev.start.toISOString(), ev.end.toISOString(),
         ev.allDay, ev.busy, ev.category, stamp]
      );
    }

    // Anything in the window that this pass did not see was deleted or moved out of it upstream.
    // Seeded staging rows ("dev-...") are left alone.
    await run(
      `delete from events_cache
        where user_id = $1 and provider = $2 and synced_at < $3 and end_time > $4
          and provider_event_id not like 'dev-%'`,
      [userId, conn.provider, stamp, from.toISOString()]
    );
    await run(`update oauth_connections set last_sync_at = now() where id = $1`, [conn.id]);
    result.synced += events.length;
  }
  return result;
}
