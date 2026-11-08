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

export const config = {
  port: Number(opt("PORT") ?? 4000),

  /** Browser origins allowed to call this API with credentials, comma-separated. The native app
   *  doesn't use CORS, so this is normally empty. "*" is honored only when ALLOW_ANY_ORIGIN=1. */
  allowedOrigins: (opt("ALLOWED_ORIGINS") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  // Off by default: nothing legitimate needs it.
  allowAnyOrigin: bool("ALLOW_ANY_ORIGIN", false),

  /** Postgres / Supabase connection string. When absent, the server boots in NO-DB mode:
   *  routes that need persistence return 503 instead of crashing, so a first deploy and the
   *  health check can be verified before a database exists. */
  databaseUrl: opt("DATABASE_URL"),

  /** PEM of the CA that signed the database certificate. Set it to enable verification. */
  databaseCa: opt("DATABASE_CA")?.replace(/\\n/g, "\n"),

  /** Legacy Supabase JWT secret, for projects that still sign HS256 tokens. Optional: current
   *  projects sign with asymmetric keys, verified through supabaseUrl below. */
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

  /** Staging/testing: a long random secret sent as `Authorization: Bearer` (the app's developer
   *  token), mapped to TEST_USER_ID (a row that must already exist in auth.users). Unlike
   *  DEV_USER_ID this is safe on a public URL, because nothing is accepted without the secret.
   *  Leave it unset in production. */
  testAccessToken: opt("TEST_ACCESS_TOKEN"),
  testUserId: opt("TEST_USER_ID"),

  /** 32-byte base64 master key that wraps per-connection data keys (envelope encryption).
   *  In production this is a KMS key id instead; see server/crypto/envelope.ts. */
  masterKey: opt("MASTER_KEY"),

  anthropicApiKey: opt("ANTHROPIC_API_KEY"),

  /** Where the assistant keeps each person's website files until they publish them. On a host
   *  with an ephemeral disk (Railway's default), point this at a mounted volume. */
  sitesDir: opt("AGENT_SITES_DIR") ?? "data/sites",
} as const;
