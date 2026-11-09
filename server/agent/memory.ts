/**
 * Hera's memory, in the database:
 *   - conversations (agent_conversations): where each task got to, so a reply continues it.
 *     Kept for a week after the last message.
 *   - memories (agent_memories): lasting facts the person told her, used in every task, which
 *     they can see and delete in Settings.
 *
 * Until migration 003 has been run, the tables don't exist; then both fall back to the server's
 * memory (lost on restart) rather than failing, so the assistant keeps working.
 */
import { randomUUID } from "node:crypto";
import type { Run } from "../shared.ts";
import type { AgentMode, ConversationState } from "./loop.ts";

export const MAX_MEMORIES = 50;
const KEEP_DAYS = 7;
/** A saved conversation bigger than this is too long to continue; the next request starts fresh. */
const MAX_STATE_BYTES = 1_500_000;

export interface Memory { id: string; text: string; createdAt: string }

/** Postgres "relation does not exist": the migration hasn't been run. */
const missingTable = (e: unknown) => (e as { code?: string })?.code === "42P01";

export class MemoryStore {
  private fallback: { conversations: Map<string, { userId: string; mode: AgentMode; state: ConversationState; at: number }>; memories: Map<string, Memory[]> } | null = null;

  constructor(private readonly run: Run, private readonly clock: () => number = () => Date.now()) {}

  private useFallback(e: unknown) {
    if (!missingTable(e)) throw e;
    if (!this.fallback) {
      console.warn("[memory] agent_conversations/agent_memories missing: run db/migrations/003_hera_memory.sql. Using in-process memory until then.");
      this.fallback = { conversations: new Map(), memories: new Map() };
    }
    return this.fallback;
  }

  /* ---------------- conversations ---------------- */

  /** The saved conversation, if it's this person's, in this mode, and recent enough. */
  async conversation(userId: string, id: string, mode: AgentMode): Promise<ConversationState | null> {
    const since = new Date(this.clock() - KEEP_DAYS * 86_400_000);
    try {
      const { rows } = await this.run(
        `select state from agent_conversations where id = $1 and user_id = $2 and mode = $3 and updated_at > $4`,
        [id, userId, mode, since]);
      return rows[0]?.state ?? null;
    } catch (e) {
      const c = this.useFallback(e).conversations.get(id);
      return c && c.userId === userId && c.mode === mode && c.at > since.getTime() ? c.state : null;
    }
  }

  /** Saves where the conversation got to. Returns its id, or null if it's too long to continue. */
  async saveConversation(userId: string, id: string | null, mode: AgentMode, state: ConversationState): Promise<string | null> {
    const json = JSON.stringify(state);
    if (Buffer.byteLength(json) > MAX_STATE_BYTES) {
      if (id) await this.deleteConversation(userId, id);
      return null;
    }
    const convId = id ?? randomUUID();
    try {
      await this.run(
        `insert into agent_conversations (id, user_id, mode, state, updated_at) values ($1, $2, $3, $4::jsonb, $5)
         on conflict (id) do update set state = excluded.state, updated_at = excluded.updated_at
         where agent_conversations.user_id = excluded.user_id`,
        [convId, userId, mode, json, new Date(this.clock())]);
      // Old conversations go as new ones are saved; no separate job needed.
      await this.run(`delete from agent_conversations where user_id = $1 and updated_at < $2`,
        [userId, new Date(this.clock() - KEEP_DAYS * 86_400_000)]);
    } catch (e) {
      this.useFallback(e).conversations.set(convId, { userId, mode, state, at: this.clock() });
    }
    return convId;
  }

  private async deleteConversation(userId: string, id: string): Promise<void> {
    try {
      await this.run(`delete from agent_conversations where id = $1 and user_id = $2`, [id, userId]);
    } catch (e) {
      this.useFallback(e).conversations.delete(id);
    }
  }

  /* ---------------- memories ---------------- */

  async memories(userId: string): Promise<Memory[]> {
    try {
      const { rows } = await this.run(
        `select id, text, created_at from agent_memories where user_id = $1 order by created_at`, [userId]);
      return rows.map((r) => ({ id: r.id, text: r.text, createdAt: new Date(r.created_at).toISOString() }));
    } catch (e) {
      return [...(this.useFallback(e).memories.get(userId) ?? [])];
    }
  }

  /** Saves a fact, unless it's already known or the list is full. Returns what happened, in words. */
  async remember(userId: string, text: string): Promise<{ saved: Memory | null; message: string }> {
    const fact = text.trim().replace(/\s+/g, " ").slice(0, 300);
    if (!fact) return { saved: null, message: "Nothing to remember." };
    const existing = await this.memories(userId);
    if (existing.some((m) => m.text.toLowerCase() === fact.toLowerCase())) return { saved: null, message: "Already remembered." };
    if (existing.length >= MAX_MEMORIES) {
      return { saved: null, message: `Not saved: Hera already remembers ${MAX_MEMORIES} things. The person can remove some in Settings.` };
    }
    try {
      const { rows } = await this.run(
        `insert into agent_memories (user_id, text) values ($1, $2) returning id, text, created_at`, [userId, fact]);
      const r = rows[0];
      return { saved: { id: r.id, text: r.text, createdAt: new Date(r.created_at).toISOString() }, message: "Remembered." };
    } catch (e) {
      const list = this.useFallback(e).memories;
      const memory = { id: randomUUID(), text: fact, createdAt: new Date(this.clock()).toISOString() };
      list.set(userId, [...(list.get(userId) ?? []), memory]);
      return { saved: memory, message: "Remembered." };
    }
  }

  /** Returns false if there was no such memory for this person. */
  async forgetMemory(userId: string, id: string): Promise<boolean> {
    try {
      const { rows } = await this.run(`delete from agent_memories where id = $1 and user_id = $2 returning id`, [id, userId]);
      return rows.length > 0;
    } catch (e) {
      const list = this.useFallback(e).memories;
      const before = list.get(userId) ?? [];
      list.set(userId, before.filter((m) => m.id !== id));
      return before.length !== (list.get(userId)?.length ?? 0);
    }
  }

  /** Account deletion (the database rows go with the account's other rows). */
  forgetAll(userId: string): void {
    if (!this.fallback) return;
    this.fallback.memories.delete(userId);
    for (const [id, c] of this.fallback.conversations) if (c.userId === userId) this.fallback.conversations.delete(id);
  }
}
