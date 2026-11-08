/**
 * Central configuration, read once from the environment.
 *
 * Nothing else in the server reads process.env directly — everything goes through here so the
 * required-vs-optional contract lives in one place and a missing secret fails loudly at boot
 * (for the things we cannot run without) or degrades explicitly (for the things we can stub).
 *
 * See .env.example for the full list and how to obtain each value.
 */

function opt(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length ? v : undefined;
}

function bool(name: string, dflt = false): boolean {
  const v = opt(name);
  if (v === undefined) return dflt;
  return v === "1" || v.toLowerCase() === "true";
}

export interface ProviderOAuthConfig {
  clientId: string;
  clientSecret: string;
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
}

export const config = {
  port: Number(opt("PORT") ?? 4000),

  /** Origins allowed to call this API with credentials. Extension origins look like
   *  chrome-extension://<id>. Comma-separated. "*" is honored only when ALLOW_ANY_ORIGIN=1. */
  allowedOrigins: (opt("ALLOWED_ORIGINS") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  // Off by default. The extension's service worker reaches the API through host_permissions,
  // which bypasses CORS, so nothing legitimate needs this on.
  allowAnyOrigin: bool("ALLOW_ANY_ORIGIN", false),

  /** Postgres / Supabase connection string. When absent, the server boots in NO-DB mode:
   *  routes that need persistence return 503 instead of crashing, so OAuth wiring and the
   *  health check can still be exercised before a database exists. */
  databaseUrl: opt("DATABASE_URL"),

  /** PEM of the CA that signed the database certificate. Set it to enable verification. */
  databaseCa: opt("DATABASE_CA")?.replace(/\\n/g, "\n"),

  /** Supabase JWT secret (Project Settings -> API -> JWT Secret). Used to verify the access
   *  token the client presents. When absent, DEV_USER_ID below is used instead. */
  supabaseJwtSecret: opt("SUPABASE_JWT_SECRET"),

  /** The Supabase project URL, e.g. https://abcd.supabase.co. Lets the server verify tokens
   *  signed with the project's asymmetric signing keys (the default for new projects), and
   *  delete the sign-in account when a person deletes their account. */
  supabaseUrl: opt("SUPABASE_URL")?.replace(/\/+$/, ""),
  /** Server-only. Used for one thing: deleting a person's sign-in account at their request
   *  (Apple guideline 5.1.1(v)). Never sent to the app. */
  supabaseServiceRoleKey: opt("SUPABASE_SERVICE_ROLE_KEY"),

  /** Shown on the public support, privacy and terms pages. */
  supportEmail: opt("SUPPORT_EMAIL") ?? "support@example.com",

  /** Dev-only escape hatch: treat every request as this user id. Never set in production. */
  devUserId: opt("DEV_USER_ID"),

  /** Staging/testing: a long random secret the extension sends as `Authorization: Bearer`,
   *  mapped to TEST_USER_ID (a row that must already exist in auth.users). Unlike DEV_USER_ID
   *  this is safe on a public URL, because nothing is accepted without the secret. Remove it
   *  once real sign-in exists. */
  testAccessToken: opt("TEST_ACCESS_TOKEN"),
  testUserId: opt("TEST_USER_ID"),

  /** Public https origin of this server, used to build nothing secret — only for logs. */
  publicUrl: opt("PUBLIC_URL"),

  /** 32-byte base64 master key that wraps per-connection data keys (envelope encryption).
   *  In production this is a KMS key id instead; see server/crypto/envelope.ts. */
  masterKey: opt("MASTER_KEY"),

  anthropicApiKey: opt("ANTHROPIC_API_KEY"),

  /** Where the assistant keeps each person's website files until they publish them. On a host
   *  with an ephemeral disk (Railway's default), point this at a mounted volume. */
  sitesDir: opt("AGENT_SITES_DIR") ?? "data/sites",

  /** Where moderation.ts posts content-free safety events. Points back at this server. */
  internalApi: opt("INTERNAL_API") ?? `http://localhost:${Number(opt("PORT") ?? 4000)}`,

  google: providerConfig("GOOGLE", {
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: [
      "https://www.googleapis.com/auth/calendar.events",
      "https://www.googleapis.com/auth/userinfo.email",
      "openid",
    ],
  }),

  microsoft: providerConfig("MICROSOFT", {
    authUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scopes: ["Calendars.ReadWrite", "offline_access", "openid", "email"],
  }),

  /** VAPID keys for Web Push reminders. Optional until Milestone 4. */
  vapid: {
    publicKey: opt("VAPID_PUBLIC_KEY"),
    privateKey: opt("VAPID_PRIVATE_KEY"),
    subject: opt("VAPID_SUBJECT") ?? "mailto:admin@example.com",
  },
} as const;

function providerConfig(
  prefix: string,
  fixed: { authUrl: string; tokenUrl: string; scopes: string[] }
): ProviderOAuthConfig | undefined {
  const clientId = opt(`${prefix}_CLIENT_ID`);
  const clientSecret = opt(`${prefix}_CLIENT_SECRET`);
  if (!clientId || !clientSecret) return undefined;
  return { clientId, clientSecret, ...fixed };
}

export function hasDb(): boolean {
  return Boolean(config.databaseUrl);
}
