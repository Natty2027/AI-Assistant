/**
 * What the assistant may do in the world, and the deterministic rules every action must pass.
 *
 * The rules live here, in code, not in a prompt. OWASP's guidance for LLM apps is explicit that
 * a system prompt is not a security control: "controls need to be enforced outside the model".
 * Every check is a plain function of the action and the user's own data, so it can be tested,
 * explained to the user, and cannot be talked out of by anything the model reads.
 *
 * Sources for the specific rules (see docs/SAFE-ACTIONS.md for the full list):
 *   - FTC Consumer Reviews and Testimonials rule (16 CFR 465): no fake or AI-written reviews.
 *   - X automation rules: no spam, no bulk mentions, no duplicate posts across accounts.
 *   - CAN-SPAM: unsubscribe link, postal address, no deceptive subject lines.
 *   - TCPA: prior express written consent for marketing texts, quiet hours, STOP opt-out.
 */
import { z } from "zod";

/* ------------------------------ actions ------------------------------ */

/** draft: nothing leaves the app. publish: visible to other people. spend: costs money. */
export type Tier = "draft" | "publish" | "spend";

export const ACTION_KINDS = [
  "site.deploy", "social.post", "email.campaign", "sms.campaign", "ads.campaign", "domain.purchase",
] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export interface ActionSpec {
  tier: Exclude<Tier, "draft">;
  label: string;
  /** Which kind of user-owned connection the action must target. */
  connection: ConnectionKind;
  /** Executed actions allowed per connection per day. Deliberately below platform limits. */
  dailyLimit: number;
}

export const ACTIONS: Record<ActionKind, ActionSpec> = {
  "site.deploy":     { tier: "publish", label: "Publish a website",        connection: "hosting",   dailyLimit: 10 },
  "social.post":     { tier: "publish", label: "Publish a social post",    connection: "social",    dailyLimit: 5 },
  "email.campaign":  { tier: "publish", label: "Send an email campaign",   connection: "email",     dailyLimit: 1 },
  "sms.campaign":    { tier: "publish", label: "Send a text campaign",     connection: "sms",       dailyLimit: 1 },
  "ads.campaign":    { tier: "spend",   label: "Start a paid ad campaign", connection: "ads",       dailyLimit: 2 },
  "domain.purchase": { tier: "spend",   label: "Buy a domain name",        connection: "registrar", dailyLimit: 1 },
};

/** Never offered, never automated, regardless of approval. Shown to users and to the model. */
export const NEVER_AUTOMATED = [
  "Direct messages to people who have not contacted you",
  "Automated likes, follows, reposts or replies to strangers",
  "Writing reviews or testimonials, or posting them as if from customers",
  "Posting the same content across several accounts",
  "Buying followers, views or engagement",
  "Emailing purchased or scraped lists",
  "Texting anyone without recorded written consent",
  "Logging in to a platform through a browser to get around its official API",
] as const;

export function isActionKind(k: unknown): k is ActionKind {
  return typeof k === "string" && (ACTION_KINDS as readonly string[]).includes(k);
}

/* ------------------------------ payloads ------------------------------ */

const id = z.string().min(1).max(100);
const https = z.string().max(2048).refine((u) => {
  try { return new URL(u).protocol === "https:"; } catch { return false; }
}, "must be an https:// address");

export const PLATFORMS = ["x", "instagram", "linkedin", "facebook"] as const;
export type Platform = (typeof PLATFORMS)[number];

/** Character limits per platform. Kept conservative; the platform has the final say. */
export const TEXT_LIMITS: Record<Platform, number> = { x: 280, instagram: 2200, linkedin: 3000, facebook: 5000 };

export const PAYLOADS = {
  // contentHash fingerprints every file of the site, so an approval covers the content the
  // person saw, not just "site X": edits made after approving cannot slip into the publish.
  "site.deploy": z.object({ connectionId: id, siteId: id, contentHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  "social.post": z.object({
    connectionId: id,
    text: z.string().min(1).max(5000),
    link: https.nullable(),
    sponsored: z.boolean(),
    mediaRefs: z.array(id).max(10),
  }).strict(),
  "email.campaign": z.object({
    connectionId: id, listId: id,
    subject: z.string().min(1).max(200), bodyText: z.string().min(1).max(50_000),
    fromName: z.string().min(1).max(100), postalAddress: z.string().max(300),
    unsubscribeUrl: z.string().max(2048),
  }).strict(),
  "sms.campaign": z.object({
    connectionId: id, listId: id, text: z.string().min(1).max(640),
    audienceTimezone: z.string().min(1).max(64), sendAt: z.string().min(1).max(40),
  }).strict(),
  "ads.campaign": z.object({ connectionId: id, budgetCents: z.number().int().positive(), text: z.string().min(1).max(2000), link: https }).strict(),
  "domain.purchase": z.object({ connectionId: id, domain: z.string().min(3).max(253), priceCents: z.number().int().positive() }).strict(),
} satisfies Record<ActionKind, z.ZodType>;

export type Payload<K extends ActionKind> = z.infer<(typeof PAYLOADS)[K]>;

/* ------------------------------ the user's world ------------------------------ */

export type ConnectionKind = "hosting" | "social" | "email" | "sms" | "ads" | "registrar";

/** Everything an action may point at is one of these, owned by the user. The model never
 *  supplies a raw address, handle or URL as a destination, so injected text cannot redirect
 *  a post or a campaign somewhere the user did not connect. */
export interface Connection { id: string; kind: ConnectionKind; platform?: Platform; label: string }
export interface AudienceList { id: string; kind: "email" | "sms"; source: "opt_in" | "existing_customers" | "purchased" | "scraped"; size: number; consentRecords: number }
export interface RecentPost { connectionId: string; text: string; at: Date }

export interface Context {
  connections: Connection[];
  lists: AudienceList[];
  recentPosts: RecentPost[];
  /** Executed actions today, keyed `${kind}:${connectionId}`. */
  usageToday: Record<string, number>;
  /** 0 means spending is switched off. */
  spendCapCents: number;
  spentThisMonthCents: number;
  /** Results of scanning a site before it can be deployed, keyed by site id. */
  siteScans: Record<string, Check[]>;
  /** The current fingerprint of each site's files, keyed by site id. */
  siteDigests: Record<string, string>;
}

/* ------------------------------ checks ------------------------------ */

/** block: cannot be approved. attest: the user must confirm a specific fact before approving.
 *  warn: shown, does not stop anything. */
export interface Check { id: string; level: "block" | "attest" | "warn"; message: string }

const normalize = (s: string) => s.toLowerCase().replace(/https?:\/\/\S+/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

// Quoted words followed by a name ("Best coffee in town!" - Sarah K.), star ratings, "5/5".
const TESTIMONIAL = [
  /["“][^"”]{8,}["”]\s*[-–—~]\s*\p{Lu}/u,
  /[★⭐]{2,}|\b[1-5](\.\d)?\s*\/\s*5\b|\b[1-5](\.\d)?\s*stars?\b/iu,
  /\b(our|my) (customers|clients|patients|students) (say|said|rave|agree)\b/i,
];
const CLAIMS = /\b(guaranteed?|risk[- ]free|no risk|100% (effective|safe|results)|cures?|miracle|get rich|overnight results|clinically proven|doctors? recommend)\b/i;
const DISCLOSURE = /(#ad\b|#sponsored\b|\bsponsored\b|\bpaid partnership\b|\badvertisement\b)/i;
const SHORTENERS = /^(bit\.ly|tinyurl\.com|t\.co|goo\.gl|ow\.ly|is\.gd|buff\.ly|rebrand\.ly|cutt\.ly)$/i;
const DAY_MS = 86_400_000;

function contentChecks(text: string, out: Check[]): void {
  if (TESTIMONIAL.some((re) => re.test(text))) {
    out.push({ id: "testimonial", level: "attest",
      message: "This looks like a review, rating or testimonial. Only real reviews from real customers, used with their permission, may be published (FTC rule 16 CFR 465). The assistant never writes them." });
  }
  if (CLAIMS.test(text)) {
    out.push({ id: "claims", level: "attest",
      message: "This makes a strong claim (guaranteed, risk-free, cures...). You must be able to back it up; unsupported claims can be deceptive advertising." });
  }
}

function linkChecks(link: string | null, out: Check[]): void {
  if (!link) return;
  try {
    const host = new URL(link).hostname;
    if (SHORTENERS.test(host)) {
      out.push({ id: "link_shortener", level: "warn", message: "A link shortener hides where the link goes. Platforms and readers trust direct links more." });
    }
  } catch { /* the schema already rejected a malformed link */ }
}

function withinQuietHours(sendAt: string, timeZone: string): boolean | null {
  const when = new Date(sendAt);
  if (Number.isNaN(when.getTime())) return null;
  try {
    const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" }).format(when));
    return hour < 8 || hour >= 21;
  } catch {
    return null; // unknown time zone
  }
}

/**
 * Every rule for one proposed action. Pure: same inputs, same answer. `now` is passed in so the
 * time-based rules are testable and so execution-time re-checks see the real clock.
 */
export function evaluate(kind: ActionKind, rawPayload: unknown, ctx: Context, now = new Date()): Check[] {
  const out: Check[] = [];
  const spec = ACTIONS[kind];
  const parsed = PAYLOADS[kind].safeParse(rawPayload);
  if (!parsed.success) {
    const where = parsed.error.issues[0]?.path.join(".") || "payload";
    return [{ id: "invalid", level: "block", message: `The action is malformed (${where}).` }];
  }
  const p = parsed.data as Record<string, any>;

  // Every destination must be something the user connected, of the right kind.
  const conn = ctx.connections.find((c) => c.id === p.connectionId);
  if (!conn || conn.kind !== spec.connection) {
    out.push({ id: "unknown_destination", level: "block", message: "That destination is not one of your connected accounts." });
    return out;
  }

  const used = ctx.usageToday[`${kind}:${conn.id}`] ?? 0;
  if (used >= spec.dailyLimit) {
    out.push({ id: "daily_limit", level: "block", message: `Daily limit reached for this account (${spec.dailyLimit}). Posting more looks like spam to platforms.` });
  }

  switch (kind) {
    case "social.post": {
      const platform = conn.platform;
      if (!platform) { out.push({ id: "unknown_platform", level: "block", message: "This account's platform is not known." }); break; }
      if (p.text.length > TEXT_LIMITS[platform]) {
        out.push({ id: "too_long", level: "block", message: `Too long for ${platform} (${p.text.length}/${TEXT_LIMITS[platform]} characters).` });
      }
      if (platform === "instagram" && p.mediaRefs.length === 0) {
        out.push({ id: "needs_media", level: "block", message: "Instagram posts need an image or video." });
      }
      if (p.sponsored && !DISCLOSURE.test(p.text)) {
        out.push({ id: "disclosure", level: "block", message: "Sponsored content must say so clearly, for example #ad or 'Paid partnership'." });
      }
      const mentions = (p.text.match(/(^|\s)@\w{1,30}/g) ?? []).length;
      if (mentions > 2) {
        out.push({ id: "mass_mentions", level: "block", message: "Mentioning many accounts in an automated post is treated as spam." });
      } else if (mentions > 0) {
        out.push({ id: "mentions", level: "warn", message: "This post mentions other accounts. Make sure they would welcome it." });
      }
      contentChecks(p.text, out);
      linkChecks(p.link, out);
      const norm = normalize(p.text);
      for (const r of ctx.recentPosts) {
        if (normalize(r.text) !== norm) continue;
        const age = now.getTime() - r.at.getTime();
        if (r.connectionId !== conn.id && age < 7 * DAY_MS) {
          out.push({ id: "duplicate_across_accounts", level: "block", message: "The same post already went to another account this week. Posting duplicates across accounts is not allowed." });
          break;
        }
        if (r.connectionId === conn.id && age < DAY_MS) {
          out.push({ id: "repeat_post", level: "block", message: "This exact post already went out from this account today." });
          break;
        }
      }
      break;
    }

    case "email.campaign": {
      const list = ctx.lists.find((l) => l.id === p.listId && l.kind === "email");
      if (!list) { out.push({ id: "unknown_list", level: "block", message: "That is not one of your email lists." }); break; }
      if (list.source === "purchased" || list.source === "scraped") {
        out.push({ id: "list_source", level: "block", message: "Purchased or scraped lists cannot be emailed." });
      }
      if (!https.safeParse(p.unsubscribeUrl).success) {
        out.push({ id: "unsubscribe", level: "block", message: "Commercial email needs a working unsubscribe link (CAN-SPAM)." });
      }
      if (p.postalAddress.trim().length < 10) {
        out.push({ id: "postal_address", level: "block", message: "Commercial email must include your physical postal address (CAN-SPAM)." });
      }
      if (/^\s*(re|fw|fwd)\s*:/i.test(p.subject)) {
        out.push({ id: "deceptive_subject", level: "block", message: "A subject line must not pretend to be a reply or forward." });
      }
      contentChecks(`${p.subject}\n${p.bodyText}`, out);
      break;
    }

    case "sms.campaign": {
      const list = ctx.lists.find((l) => l.id === p.listId && l.kind === "sms");
      if (!list) { out.push({ id: "unknown_list", level: "block", message: "That is not one of your text-message lists." }); break; }
      if (list.size === 0 || list.consentRecords < list.size) {
        out.push({ id: "sms_consent", level: "block", message: "Every recipient needs recorded written consent before a marketing text (TCPA)." });
      }
      if (!/\b(reply|text)\s+stop\b/i.test(p.text)) {
        out.push({ id: "sms_opt_out", level: "block", message: "Marketing texts must say how to opt out, e.g. 'Reply STOP to unsubscribe'." });
      }
      const quiet = withinQuietHours(p.sendAt, p.audienceTimezone);
      if (quiet === null) {
        out.push({ id: "sms_time", level: "block", message: "The send time or time zone is not valid." });
      } else if (quiet) {
        out.push({ id: "quiet_hours", level: "block", message: "Marketing texts may not go out before 8 AM or after 9 PM in the recipients' time zone." });
      }
      contentChecks(p.text, out);
      break;
    }

    case "ads.campaign":
    case "domain.purchase": {
      const amount = kind === "ads.campaign" ? p.budgetCents : p.priceCents;
      if (ctx.spendCapCents <= 0) {
        out.push({ id: "no_spend_cap", level: "block", message: "Spending is switched off. Set a monthly spending limit in Settings first." });
      } else if (ctx.spentThisMonthCents + amount > ctx.spendCapCents) {
        out.push({ id: "over_spend_cap", level: "block", message: "This would go over your monthly spending limit." });
      }
      if (kind === "ads.campaign") { contentChecks(p.text, out); linkChecks(p.link, out); }
      break;
    }

    case "site.deploy": {
      const scan = ctx.siteScans[p.siteId];
      if (!scan) { out.push({ id: "site_not_scanned", level: "block", message: "The site has not been checked yet." }); break; }
      if (ctx.siteDigests[p.siteId] !== p.contentHash) {
        out.push({ id: "site_changed", level: "block", message: "The site's files changed after this was proposed. Review the current version and approve that." });
      }
      out.push(...scan);
      break;
    }
  }
  return out;
}

export const isBlocked = (checks: Check[]) => checks.some((c) => c.level === "block");
export const attestationsNeeded = (checks: Check[]) => checks.filter((c) => c.level === "attest").map((c) => c.id);
