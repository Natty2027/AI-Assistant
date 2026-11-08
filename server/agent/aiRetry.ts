/**
 * Retry wrapper for Claude calls, ported from Cognivate's withAiRetry (proven in production
 * there). Transient Anthropic failures (429, 5xx, dropped connections) are common enough that
 * failing a whole assistant run on one of them costs people real work: a run is many turns, and
 * one hiccup on turn fifteen would otherwise throw away the fourteen before it.
 *
 * Failure taxonomy:
 *   Transient (retried): HTTP 429 (honouring Retry-After), 500-599, ECONNRESET / ETIMEDOUT /
 *     ECONNREFUSED, and aborts that were not our own timeout.
 *   Terminal (fail fast): any other 4xx (a bad request, auth or quota: retrying won't help),
 *     our own per-attempt timeout (retrying just waits again), and anything else.
 *
 * The Anthropic client is created with maxRetries: 0 (routes.ts) so retries happen here only,
 * once, rather than compounding the SDK's own retries with these.
 */

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;
const JITTER_MS = 250;
const MAX_BACKOFF_MS = 8_000;
/** Covers a long, high-effort turn with adaptive thinking before the response starts. */
const DEFAULT_ATTEMPT_TIMEOUT_MS = 300_000;

type RetryableError = Error & {
  status?: number;
  code?: string;
  headers?: Headers | Record<string, string | string[] | undefined>;
};

/** Thrown when OUR per-attempt timeout fires, so callers can tell "took too long" (tell the
 *  person) from a dropped connection (already retried). */
export class AiTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`AI call exceeded the ${timeoutMs}ms attempt timeout`);
    this.name = "AiTimeoutError";
  }
}

export function isTransient(err: RetryableError): boolean {
  if (err instanceof AiTimeoutError) return false;
  if (err.code === "ECONNRESET" || err.code === "ETIMEDOUT" || err.code === "ECONNREFUSED") return true;
  if (err.name === "AbortError" || err.name === "TimeoutError" || err.name === "APIConnectionError") return true;
  const status = err.status;
  if (typeof status !== "number") return false;
  return status === 429 || (status >= 500 && status < 600);
}

/** Retry-After in seconds or as an HTTP date (RFC 7231), capped. null when absent. */
export function parseRetryAfterMs(headers: RetryableError["headers"], now = Date.now()): number | null {
  if (!headers) return null;
  const raw = headers instanceof Headers
    ? headers.get("retry-after")
    : headers["retry-after"] ?? headers["Retry-After"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_BACKOFF_MS);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, Math.min(date - now, MAX_BACKOFF_MS));
  return null;
}

/** 500ms, then 1500ms (plus up to 250ms jitter), unless the server said how long to wait. */
export function backoffDelayMs(attempt: number, retryAfterMs: number | null, random = Math.random): number {
  if (retryAfterMs !== null) return retryAfterMs;
  const base = BASE_BACKOFF_MS * Math.pow(3, attempt - 1);
  return Math.min(base + Math.floor(random() * JITTER_MS), MAX_BACKOFF_MS);
}

export interface AiRetryOptions {
  attemptTimeoutMs?: number;
  /** Injected in tests so backoff costs nothing. */
  sleep?: (ms: number) => Promise<void>;
  onAttemptFailed?: (info: { attempt: number; err: RetryableError; willRetry: boolean }) => void;
}

/**
 * Runs `call`, retrying transient failures. `call` receives an AbortSignal that fires at the
 * per-attempt timeout; pass it to the SDK so a hung request really stops.
 */
export async function withAiRetry<T>(call: (signal: AbortSignal) => Promise<T>, opts: AiRetryOptions = {}): Promise<T> {
  const timeoutMs = opts.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastErr: RetryableError | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try {
      return await call(controller.signal);
    } catch (err) {
      lastErr = timedOut ? new AiTimeoutError(timeoutMs) : (err as RetryableError);
      const willRetry = isTransient(lastErr) && attempt < MAX_ATTEMPTS;
      opts.onAttemptFailed?.({ attempt, err: lastErr, willRetry });
      if (!willRetry) throw lastErr;
      await sleep(backoffDelayMs(attempt, parseRetryAfterMs(lastErr.headers)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr ?? new Error("withAiRetry: exhausted with no error");
}
