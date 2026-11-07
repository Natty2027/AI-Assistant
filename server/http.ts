/**
 * A tiny routing + request/response layer over node:http. No framework, matching the repo's
 * zero-dependency posture (the mock server is plain node:http too). It gives us: typed JSON
 * handlers, CORS with credentials, body parsing with a size cap, and one place where every
 * thrown error becomes a clean JSON response instead of a hung socket.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { config } from "./config.ts";
import { clientIp, createLimiter } from "./rateLimit.ts";

export type Method = "GET" | "POST" | "PATCH" | "DELETE";

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  /** Parsed JSON body ({} for GET / empty). */
  body: Record<string, unknown>;
  /** Named params captured from the route pattern, e.g. /proposals/:id. */
  params: Record<string, string>;
  /** Populated by requireAuth(); the authenticated user's id. */
  userId?: string;
}

export type Handler = (ctx: Ctx) => Promise<unknown> | unknown;

interface Route {
  method: Method;
  /** Segments; a segment beginning with ":" is a named param. */
  segments: string[];
  handler: Handler;
}

const MAX_BODY_BYTES = 8 * 1024 * 1024; // capture uploads base64 images; keep in step with 5MB raw

/** Thrown by handlers to return a specific status with a plain-language message. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly expose = true,
    /** Stable machine-readable reason, e.g. "ai_consent_required", for the client to branch on. */
    readonly code?: string
  ) {
    super(message);
  }
}

export class Router {
  private routes: Route[] = [];

  add(method: Method, pattern: string, handler: Handler): this {
    this.routes.push({ method, segments: pattern.split("/").filter(Boolean), handler });
    return this;
  }
  get(p: string, h: Handler) { return this.add("GET", p, h); }
  post(p: string, h: Handler) { return this.add("POST", p, h); }
  patch(p: string, h: Handler) { return this.add("PATCH", p, h); }
  delete(p: string, h: Handler) { return this.add("DELETE", p, h); }

  private match(method: string, path: string): { route: Route; params: Record<string, string> } | null {
    const parts = path.split("/").filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== method) continue;
      if (route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < route.segments.length; i++) {
        const seg = route.segments[i];
        if (seg.startsWith(":")) params[seg.slice(1)] = decodeURIComponent(parts[i]);
        else if (seg !== parts[i]) { ok = false; break; }
      }
      if (ok) return { route, params };
    }
    return null;
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Headers first, so they are on every response including 4xx and 429, which are the
    // ones most likely to be probed.
    setSecurityHeaders(res);
    setCors(req, res);
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    if (!perIp.hit(clientIp(req))) {
      return send(res, 429, { error: "Too many requests. Please slow down." });
    }

    const url = new URL(req.url ?? "/", `http://localhost:${config.port}`);
    const matched = this.match(req.method ?? "GET", url.pathname);

    if (!matched) {
      return send(res, 404, { error: `no route for ${req.method} ${url.pathname}` });
    }

    try {
      const body = await readJsonBody(req);
      const ctx: Ctx = { req, res, url, body, params: matched.params };
      const result = await matched.route.handler(ctx);
      if (!res.writableEnded) send(res, 200, result ?? { ok: true });
    } catch (err) {
      handleError(res, err, `${req.method} ${url.pathname}`);
    }
  }
}

/** Generous per-IP ceiling across all routes; the tight limits live on the sensitive ones. */
const perIp = createLimiter({ windowMs: 60_000, max: 300 });

/** The response headers helmet's default profile sets, written by hand like Cognivate's
 *  secureHeaders. This server returns JSON only, so no CSP is needed here. */
function setSecurityHeaders(res: ServerResponse): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cache-Control", "no-store");
}

function setCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  const allowed =
    origin && (config.allowAnyOrigin || config.allowedOrigins.includes(origin)) ? origin : null;
  // Auth is a Bearer header, never a cookie, so credentialed CORS is deliberately never
  // enabled: reflecting an origin with credentials is what turns an open CORS policy into a
  // cross-site request hole.
  if (allowed) res.setHeader("Access-Control-Allow-Origin", allowed);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  res.setHeader("Vary", "Origin");
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.method === "GET" || req.method === "DELETE") return {};
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new HttpError(413, "Request body too large");
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new HttpError(400, "Body was not valid JSON");
  }
}

function handleError(res: ServerResponse, err: unknown, where: string): void {
  if (err instanceof HttpError) {
    console.warn(`[${err.status}] ${where}: ${err.message}`);
    send(res, err.status, { error: err.expose ? err.message : "Request failed", code: err.code ?? null });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[500] ${where}:`, message);
  send(res, 500, { error: "Internal error" });
}

export function send(res: ServerResponse, status: number, payload: unknown): void {
  if (res.writableEnded) return;
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}
