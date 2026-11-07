/**
 * Small in-memory fixed-window limiter, same shape as the one the Cognivate API ships:
 * bounded key count, expired entries evicted first, oldest dropped if nothing has expired.
 *
 * Per-process only. With more than one instance the effective ceiling is N x max, so move
 * this to Redis or the database before scaling out; until then it is a defence-in-depth
 * layer, not the authoritative control.
 */
import type { IncomingMessage } from "node:http";

export interface Limiter {
  /** Count a request. Returns false once the key is over its budget. */
  hit(key: string): boolean;
  /** True when the key is already over budget, without counting a request. */
  blocked(key: string): boolean;
}

export function createLimiter(opts: { windowMs: number; max: number; maxKeys?: number }): Limiter {
  const maxKeys = opts.maxKeys ?? 50_000;
  const buckets = new Map<string, { count: number; resetAt: number }>();

  function makeRoom(now: number): void {
    for (const [k, b] of buckets) if (b.resetAt < now) buckets.delete(k);
    if (buckets.size >= maxKeys) {
      const oldest = buckets.keys().next().value;
      if (oldest !== undefined) buckets.delete(oldest);
    }
  }

  return {
    hit(key) {
      const now = Date.now();
      const b = buckets.get(key);
      if (!b || b.resetAt < now) {
        if (buckets.size >= maxKeys) makeRoom(now);
        buckets.set(key, { count: 1, resetAt: now + opts.windowMs });
        return true;
      }
      b.count += 1;
      return b.count <= opts.max;
    },
    blocked(key) {
      const b = buckets.get(key);
      return Boolean(b && b.resetAt >= Date.now() && b.count >= opts.max);
    },
  };
}

/**
 * The caller's address. Behind Railway's proxy the socket address is the proxy's, so trust
 * the LAST X-Forwarded-For entry (appended by the nearest proxy, which the client cannot
 * forge) rather than the first (which the client can set to anything). Off Railway there is
 * no proxy to trust, so the header is ignored entirely.
 */
export function clientIp(req: IncomingMessage): string {
  if (process.env.RAILWAY_ENVIRONMENT) {
    const xff = req.headers["x-forwarded-for"];
    const last = (Array.isArray(xff) ? xff.join(",") : xff)?.split(",").pop()?.trim();
    if (last) return last;
  }
  return req.socket.remoteAddress ?? "unknown";
}
