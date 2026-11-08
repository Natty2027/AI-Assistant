/**
 * The only path from "the assistant suggested it" to "it happened".
 *
 *   propose  ->  the user reviews the exact content  ->  approve  ->  execute (once)
 *
 * The guarantees, each enforced here rather than trusted to the model or the UI:
 *   - An approval is bound to a hash of the exact payload the user saw. If anything changes
 *     after approval, execution is refused.
 *   - An approval is a single-use secret token, held by the user's client, that expires. The
 *     model never sees it and has no tool that could use it.
 *   - Facts only the user can vouch for (these reviews are real, I can back up this claim) must
 *     be attested one by one; a generic "OK" does not cover them.
 *   - Spending needs the amount typed back.
 *   - A proposal shaped by outside content (a web page, a document) is flagged, and approving
 *     it requires acknowledging that.
 *   - Every rule is evaluated again at the moment of execution, because limits and spend may
 *     have changed since the proposal was made.
 *   - Everything is written to an append-only audit log.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  ACTIONS, attestationsNeeded, evaluate, isActionKind, isBlocked,
  type ActionKind, type Check, type Context,
} from "./policy.ts";

export type Status = "pending" | "blocked" | "approved" | "executing" | "executed" | "failed" | "rejected" | "expired";

export interface Proposal {
  id: string;
  userId: string;
  kind: ActionKind;
  payload: Readonly<Record<string, unknown>>;
  payloadHash: string;
  summary: string;
  checks: Check[];
  /** Shaped by content the user did not write (a web page, a document). */
  tainted: boolean;
  status: Status;
  createdAt: Date;
  expiresAt: Date;
  approvedAt?: Date;
  approvalExpiresAt?: Date;
  result?: { ok: boolean; ref?: string; detail: string };
}

export interface ExecutionResult { ok: boolean; ref?: string; detail: string }
export type Executor = (kind: ActionKind, payload: Readonly<Record<string, unknown>>) => Promise<ExecutionResult>;

export class ActionError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export interface AuditEntry {
  at: Date; userId: string; proposalId: string; kind: ActionKind;
  event: "proposed" | "blocked" | "approved" | "rejected" | "executed" | "failed" | "refused";
  payloadHash: string; detail: string;
}

const PROPOSAL_TTL_MS = 24 * 3_600_000;
const APPROVAL_TTL_MS = 15 * 60_000;

/** Stable JSON: object keys sorted at every level, so equal payloads always hash equally. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as any)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}
export const hashPayload = (p: unknown) => createHash("sha256").update(canonical(p)).digest("hex");
const sha = (s: string) => createHash("sha256").update(s).digest();

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object") { Object.values(o as object).forEach(deepFreeze); Object.freeze(o); }
  return o;
}

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * In-memory store. One process, one owner of state, so the status transitions below are atomic
 * (no await between the check and the write). Lost on restart, which fails safe: an approved
 * action that never ran simply has to be proposed again. Move to the database, with the same
 * conditional-update pattern, before running more than one server instance.
 */
export class ActionStore {
  private proposals = new Map<string, Proposal>();
  private tokens = new Map<string, Buffer>(); // proposal id -> sha256(token)
  private log: AuditEntry[] = [];

  constructor(private readonly clock: () => Date = () => new Date()) {}

  private audit(p: Proposal, event: AuditEntry["event"], detail: string): void {
    this.log.push(Object.freeze({ at: this.clock(), userId: p.userId, proposalId: p.id, kind: p.kind, event, payloadHash: p.payloadHash, detail }));
  }

  auditLog(userId: string): readonly AuditEntry[] {
    return this.log.filter((e) => e.userId === userId);
  }

  propose(args: { userId: string; kind: unknown; payload: unknown; summary: string; tainted: boolean; ctx: Context }): Proposal {
    if (!isActionKind(args.kind)) throw new ActionError("unknown_action", "That is not an action this app can take.");
    const payload = deepFreeze(structuredClone(args.payload)) as Record<string, unknown>;
    const now = this.clock();
    const checks = evaluate(args.kind, payload, args.ctx, now);
    const p: Proposal = {
      id: randomBytes(12).toString("hex"),
      userId: args.userId,
      kind: args.kind,
      payload,
      payloadHash: hashPayload(payload),
      summary: args.summary.slice(0, 300),
      checks,
      tainted: args.tainted,
      status: isBlocked(checks) ? "blocked" : "pending",
      createdAt: now,
      expiresAt: new Date(now.getTime() + PROPOSAL_TTL_MS),
    };
    this.proposals.set(p.id, p);
    this.audit(p, p.status === "blocked" ? "blocked" : "proposed", checks.map((c) => c.id).join(",") || "no issues");
    return p;
  }

  get(id: string, userId: string): Proposal {
    const p = this.proposals.get(id);
    // Someone else's proposal looks exactly like a missing one.
    if (!p || p.userId !== userId) throw new ActionError("not_found", "No such proposal.");
    if ((p.status === "pending" || p.status === "approved") && this.clock() > p.expiresAt) {
      p.status = "expired";
    }
    return p;
  }

  list(userId: string): Proposal[] {
    return [...this.proposals.values()].filter((p) => p.userId === userId).map((p) => this.get(p.id, userId));
  }

  /** Returns a single-use token. Only the user's client holds it; it is never logged. */
  approve(args: {
    id: string; userId: string; payloadHash: string;
    attestations?: string[]; acknowledgeTaint?: boolean; typedAmount?: string;
  }): { token: string; expiresAt: Date } {
    const p = this.get(args.id, args.userId);
    if (p.status !== "pending") throw new ActionError("not_pending", `This proposal is ${p.status}.`);
    if (args.payloadHash !== p.payloadHash) {
      throw new ActionError("hash_mismatch", "What you approved is not what was proposed. Review it again.");
    }
    const missing = attestationsNeeded(p.checks).filter((a) => !(args.attestations ?? []).includes(a));
    if (missing.length) throw new ActionError("attestation_required", `Please confirm: ${missing.join(", ")}.`);
    if (p.tainted && args.acknowledgeTaint !== true) {
      throw new ActionError("taint_ack_required", "This was shaped by outside content. Confirm you have read exactly what it will do.");
    }
    if (ACTIONS[p.kind].tier === "spend") {
      const cents = (p.payload.budgetCents ?? p.payload.priceCents) as number;
      if (args.typedAmount?.trim() !== formatCents(cents)) {
        throw new ActionError("amount_required", `Type ${formatCents(cents)} to confirm the amount.`);
      }
    }
    const token = randomBytes(32).toString("base64url");
    const now = this.clock();
    p.status = "approved";
    p.approvedAt = now;
    p.approvalExpiresAt = new Date(now.getTime() + APPROVAL_TTL_MS);
    this.tokens.set(p.id, sha(token));
    this.audit(p, "approved", (args.attestations ?? []).join(",") || "approved");
    return { token, expiresAt: p.approvalExpiresAt };
  }

  reject(id: string, userId: string): void {
    const p = this.get(id, userId);
    if (p.status !== "pending" && p.status !== "approved") throw new ActionError("not_pending", `This proposal is ${p.status}.`);
    p.status = "rejected";
    this.tokens.delete(p.id);
    this.audit(p, "rejected", "rejected by user");
  }

  /** Runs the action exactly once, after re-checking everything against the current state. */
  async execute(args: { id: string; userId: string; token: string; ctx: Context; executor: Executor }): Promise<Proposal> {
    const p = this.get(args.id, args.userId);
    const refuse = (code: string, msg: string): never => {
      this.audit(p, "refused", code);
      throw new ActionError(code, msg);
    };
    if (p.status !== "approved") refuse("not_approved", `This proposal is ${p.status}.`);
    const stored = this.tokens.get(p.id);
    const given = sha(String(args.token ?? ""));
    if (!stored || !timingSafeEqual(stored, given)) refuse("bad_token", "That approval is not valid.");
    if (this.clock() > (p.approvalExpiresAt as Date)) {
      p.status = "expired";
      this.tokens.delete(p.id);
      refuse("approval_expired", "The approval expired. Review and approve it again.");
    }
    // The payload is frozen, but verify anyway: the hash is the contract with the user.
    if (hashPayload(p.payload) !== p.payloadHash) refuse("hash_mismatch", "The action changed after approval.");

    const fresh = evaluate(p.kind, p.payload, args.ctx, this.clock());
    if (isBlocked(fresh)) {
      p.status = "blocked";
      p.checks = fresh;
      this.tokens.delete(p.id);
      refuse("blocked_at_execution", fresh.filter((c) => c.level === "block").map((c) => c.message).join(" "));
    }

    // Claim it before doing anything external: a second execute, even with the same token, now fails.
    p.status = "executing";
    this.tokens.delete(p.id);
    let result: ExecutionResult;
    try {
      result = await args.executor(p.kind, p.payload);
    } catch {
      // Error details from a provider can echo request data; keep them out of the log.
      result = { ok: false, detail: "The service could not complete this." };
    }
    p.result = result;
    // A failure is not retried automatically: it may have partly happened. Propose it again.
    p.status = result.ok ? "executed" : "failed";
    this.audit(p, result.ok ? "executed" : "failed", result.detail.slice(0, 200));
    return p;
  }

  /** What has actually gone out today and this month, from this store's own records, so the
   *  limits cannot be fed a flattering number by a caller. */
  usage(userId: string): { usageToday: Record<string, number>; spentThisMonthCents: number } {
    const now = this.clock();
    const day = now.toISOString().slice(0, 10);
    const month = now.toISOString().slice(0, 7);
    const usageToday: Record<string, number> = {};
    let spentThisMonthCents = 0;
    for (const p of this.proposals.values()) {
      if (p.userId !== userId || (p.status !== "executed" && p.status !== "executing")) continue;
      const when = (p.approvedAt ?? p.createdAt).toISOString();
      if (when.slice(0, 10) === day) {
        const key = `${p.kind}:${p.payload.connectionId as string}`;
        usageToday[key] = (usageToday[key] ?? 0) + 1;
      }
      if (ACTIONS[p.kind].tier === "spend" && when.slice(0, 7) === month) {
        spentThisMonthCents += (p.payload.budgetCents ?? p.payload.priceCents) as number;
      }
    }
    return { usageToday, spentThisMonthCents };
  }
}
