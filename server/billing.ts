/**
 * Hera Pro: a monthly subscription bought in the app through the App Store, and the monthly limit
 * on requests to Hera that keeps AI costs in check.
 *
 * Purchases: the app sends the App Store's signed transaction (a JWS). It's trusted only if its
 * certificate chain ends in Apple's own root (Apple Root CA - G3, pinned by fingerprint), each
 * certificate signs the next, and the leaf's key signs the transaction. Then it must be for this
 * app and one of our products, not revoked, not expired, and bought by this person (the purchase
 * carries their account id as its appAccountToken) or not yet claimed by anyone else.
 *
 * Limits: every request to Hera counts against the person's month. Off until BILLING=on, so
 * nobody is stopped before the subscription exists in App Store Connect.
 */
import { createHash, verify, X509Certificate } from "node:crypto";

/** SHA-256 of Apple Root CA - G3 (https://www.apple.com/certificateauthority/). */
const APPLE_ROOT_G3_SHA256 = "63343ABFB89A6A03EBB57E9B3F5FA7BE7C4F5C756F3017B3A8C488C3653E9179";

export class BillingError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export interface VerifiedTransaction {
  originalTransactionId: string;
  productId: string;
  expiresAt: Date;
  environment: string;
  appAccountToken: string | null;
  /** False when it was refunded, revoked or has run out: the person is back on the free plan. */
  active: boolean;
}

const b64url = (s: string) => Buffer.from(s, "base64url");

/**
 * Checks an App Store signed transaction and returns what it says. Throws BillingError when it
 * isn't genuine or isn't ours; a genuine one that's refunded or over comes back inactive.
 */
export function verifyTransaction(jws: string, opts: { bundleId: string; productIds: readonly string[]; now?: Date; rootSha256?: string }): VerifiedTransaction {
  if (typeof jws !== "string" || jws.length > 20_000) throw new BillingError("bad_purchase", "That purchase couldn't be read.");
  const parts = jws.split(".");
  if (parts.length !== 3) throw new BillingError("bad_purchase", "That purchase couldn't be read.");
  let header: { alg?: string; x5c?: string[] };
  let payload: Record<string, any>;
  try {
    header = JSON.parse(b64url(parts[0]).toString("utf8"));
    payload = JSON.parse(b64url(parts[1]).toString("utf8"));
  } catch {
    throw new BillingError("bad_purchase", "That purchase couldn't be read.");
  }
  if (header.alg !== "ES256" || !Array.isArray(header.x5c) || header.x5c.length !== 3) {
    throw new BillingError("bad_purchase", "That purchase isn't signed by the App Store.");
  }

  // The chain: leaf <- intermediate <- Apple's root, the root pinned by its fingerprint.
  let leaf: X509Certificate, intermediate: X509Certificate, root: X509Certificate;
  try {
    [leaf, intermediate, root] = header.x5c.map((c) => new X509Certificate(Buffer.from(c, "base64")));
  } catch {
    throw new BillingError("bad_purchase", "That purchase isn't signed by the App Store.");
  }
  const rootPrint = createHash("sha256").update(root.raw).digest("hex").toUpperCase();
  const now = opts.now ?? new Date();
  const valid = (c: X509Certificate) => new Date(c.validFrom) <= now && now <= new Date(c.validTo);
  // rootSha256 is for tests only, which can't get a real App Store signature.
  if (rootPrint !== (opts.rootSha256 ?? APPLE_ROOT_G3_SHA256) || !intermediate.verify(root.publicKey) || !leaf.verify(intermediate.publicKey)
      || !intermediate.checkIssued(root) || !leaf.checkIssued(intermediate) || ![leaf, intermediate].every(valid)) {
    throw new BillingError("bad_purchase", "That purchase isn't signed by the App Store.");
  }
  const signed = verify("sha256", Buffer.from(`${parts[0]}.${parts[1]}`), { key: leaf.publicKey, dsaEncoding: "ieee-p1363" }, b64url(parts[2]));
  if (!signed) throw new BillingError("bad_purchase", "That purchase isn't signed by the App Store.");

  if (payload.bundleId !== opts.bundleId || !opts.productIds.includes(payload.productId)) {
    throw new BillingError("not_ours", "That purchase isn't for Hera Pro.");
  }
  const expiresAt = new Date(Number(payload.expiresDate));
  if (Number.isNaN(expiresAt.getTime())) throw new BillingError("bad_purchase", "That purchase couldn't be read.");
  return {
    active: !payload.revocationDate && expiresAt > now,
    originalTransactionId: String(payload.originalTransactionId ?? payload.transactionId),
    productId: payload.productId,
    expiresAt,
    environment: String(payload.environment ?? "Production"),
    appAccountToken: typeof payload.appAccountToken === "string" ? payload.appAccountToken.toLowerCase() : null,
  };
}

export interface PlanStatus {
  plan: "free" | "pro";
  used: number;
  limit: number;
  /** First moment of next month, UTC: when the count starts again. */
  resetsAt: string;
  /** False while limits are off (BILLING not on): nothing is stopped. */
  enforced: boolean;
  proExpiresAt: string | null;
}

type Run = (sql: string, params: unknown[]) => Promise<{ rows: any[] }>;

export interface BillingConfig {
  enforced: boolean; freeLimit: number; proLimit: number; bundleId: string; productIds: readonly string[];
  /** Tests only: the fingerprint of a stand-in root, since a real App Store signature can't be made. */
  rootSha256?: string;
}

const month = (d: Date) => d.toISOString().slice(0, 7);
const nextMonth = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();

export class Billing {
  constructor(private readonly run: Run, private readonly cfg: BillingConfig, private readonly clock = () => new Date()) {}

  async status(userId: string): Promise<PlanStatus> {
    const now = this.clock();
    const [plan, usage] = await Promise.all([
      this.run(`select expires_at from user_plans where user_id = $1 and expires_at > $2`, [userId, now]),
      this.run(`select requests from agent_usage where user_id = $1 and month = $2`, [userId, month(now)]),
    ]);
    const pro = plan.rows[0] ? new Date(plan.rows[0].expires_at) : null;
    return {
      plan: pro ? "pro" : "free",
      used: Number(usage.rows[0]?.requests ?? 0),
      limit: pro ? this.cfg.proLimit : this.cfg.freeLimit,
      resetsAt: nextMonth(now),
      enforced: this.cfg.enforced,
      proExpiresAt: pro?.toISOString() ?? null,
    };
  }

  /** Counts one request, or throws if this month's are used up (when limits are on). */
  async useOne(userId: string): Promise<void> {
    const s = await this.status(userId);
    if (this.cfg.enforced && s.used >= s.limit) {
      const when = new Date(s.resetsAt).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
      throw new BillingError("limit_reached", s.plan === "free"
        ? `That's all ${s.limit} free requests for this month. Upgrade to Hera Pro for more, or wait until ${when}.`
        : `That's all ${s.limit} requests for this month. They start again on ${when}.`);
    }
    await this.run(
      `insert into agent_usage (user_id, month, requests) values ($1, $2, 1)
       on conflict (user_id, month) do update set requests = agent_usage.requests + 1`,
      [userId, month(this.clock())]);
  }

  /** Saves a verified purchase as this person's Pro plan. */
  async redeem(userId: string, jws: unknown): Promise<PlanStatus> {
    const tx = verifyTransaction(String(jws ?? ""), { bundleId: this.cfg.bundleId, productIds: this.cfg.productIds, now: this.clock(), rootSha256: this.cfg.rootSha256 });
    if (tx.appAccountToken && tx.appAccountToken !== userId.toLowerCase()) {
      throw new BillingError("not_yours", "That subscription belongs to a different Hera account.");
    }
    // One subscription, one Hera account: the first account to claim it keeps it.
    const { rows } = await this.run(`select user_id from user_plans where original_transaction_id = $1`, [tx.originalTransactionId]);
    if (rows[0] && rows[0].user_id !== userId) throw new BillingError("not_yours", "That subscription belongs to a different Hera account.");
    if (!tx.active) {
      // Refunded, revoked or over: Pro from this subscription ends now.
      await this.run(`update user_plans set expires_at = least(expires_at, now()), updated_at = now()
                       where user_id = $1 and original_transaction_id = $2`, [userId, tx.originalTransactionId]);
      return this.status(userId);
    }
    await this.run(
      `insert into user_plans (user_id, product_id, original_transaction_id, expires_at, environment, updated_at)
       values ($1, $2, $3, $4, $5, now())
       on conflict (user_id) do update set product_id = excluded.product_id, original_transaction_id = excluded.original_transaction_id,
         expires_at = excluded.expires_at, environment = excluded.environment, updated_at = now()`,
      [userId, tx.productId, tx.originalTransactionId, tx.expiresAt, tx.environment]);
    return this.status(userId);
  }
}
