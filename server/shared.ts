/**
 * Small types and checks shared by the routes and the assistant's publishing code.
 */
import { HttpError } from "./http.ts";

/** A query function, passed in so the same SQL runs against Postgres and against PGlite in tests. */
export type Run = (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;

/** `fetch`, injected so the publishing code is tested against a fake provider. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * A provider (Netlify, Bluesky) refused or failed. unauthorized: reconnect needed. rejected: the
 * provider refused this request. unavailable: retry later. Messages carry a status code and a
 * kind, never a response body, because a provider's error body can echo request data.
 */
export class ProviderError extends Error {
  constructor(readonly kind: "unauthorized" | "rejected" | "unavailable", message: string, readonly status?: number) {
    super(message);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertUuid(id: string): void {
  if (!UUID.test(id)) throw new HttpError(400, "That isn't a valid id.");
}
