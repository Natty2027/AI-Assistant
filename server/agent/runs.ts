/**
 * Requests to Hera that run in the background. Building a website can take Hera ten minutes or
 * more (every page is a long step), which is longer than a phone will hold one request open, so
 * the app starts a run, gets its id at once, and checks back every few seconds for the answer.
 *
 * A run belongs to this server process. When the server is told to stop (a deploy), it stops
 * taking new runs and waits for the ones in flight to finish (drain). Finished answers are saved
 * (see RunSink) and kept for half an hour, so an app that was in the background, or that checks in
 * after a deploy, can still collect its answer. One run per person at a time, so two requests
 * can't edit the same website at once.
 */
import { randomUUID } from "node:crypto";

export interface RunFailure { status: number; message: string; code?: string }

export type RunState =
  | { status: "running" }
  | { status: "finished"; result: unknown }
  | { status: "failed"; failure: RunFailure };

interface Job { userId: string; state: RunState; endedAt: number | null }

/** Where finished runs are kept, so their answers survive a restart. */
export interface RunSink {
  save(id: string, userId: string, state: RunState): Promise<void>;
  load(id: string, userId: string): Promise<RunState | null>;
}

export class RunJobs {
  private readonly jobs = new Map<string, Job>();

  /** Set when the server is shutting down: no new runs start. */
  draining = false;

  constructor(
    /** Turns a failed run into what the app is told. Unknown errors become a plain apology. */
    private readonly describe: (e: unknown) => RunFailure,
    private readonly clock: () => number = () => Date.now(),
    private readonly keepMs = 30 * 60_000,
    private readonly sink: RunSink | null = null,
  ) {}

  /** How many runs are still going. */
  get inFlight(): number {
    return [...this.jobs.values()].filter((j) => j.state.status === "running").length;
  }

  /** Stops new runs and waits for the ones in flight, up to `maxMs`. */
  async drain(maxMs: number, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<void> {
    this.draining = true;
    const until = this.clock() + maxMs;
    while (this.inFlight > 0 && this.clock() < until) await sleep(1000);
  }

  isRunning(userId: string): boolean {
    this.sweep();
    return [...this.jobs.values()].some((j) => j.userId === userId && j.state.status === "running");
  }

  /** Starts `work` and returns the run's id at once. Callers check isRunning first. */
  start(userId: string, work: () => Promise<unknown>): string {
    const id = randomUUID();
    const job: Job = { userId, state: { status: "running" }, endedAt: null };
    this.jobs.set(id, job);
    // Saved as running too: during a deploy the new server answers the app's check-ins while this
    // one finishes the run, and it reads this to say "still working" rather than "lost".
    this.sink?.save(id, userId, job.state).catch((e) => console.error("[runs] couldn't save a run", e instanceof Error ? e.message : e));
    const end = (state: RunState) => {
      job.state = state;
      job.endedAt = this.clock();
      this.sink?.save(id, userId, state).catch((e) => console.error("[runs] couldn't save a result", e instanceof Error ? e.message : e));
    };
    work().then(
      (result) => end({ status: "finished", result }),
      (e) => end({ status: "failed", failure: this.describe(e) }),
    );
    return id;
  }

  /** The run's state, or null if it isn't this person's or is no longer kept. */
  get(userId: string, id: string): RunState | null {
    this.sweep();
    const job = this.jobs.get(id);
    return job && job.userId === userId ? job.state : null;
  }

  /** Like get, but also finds answers saved before a restart. */
  async find(userId: string, id: string): Promise<RunState | null> {
    return this.get(userId, id) ?? (this.sink ? await this.sink.load(id, userId).catch(() => null) : null);
  }

  private sweep(): void {
    const now = this.clock();
    for (const [id, job] of this.jobs) {
      if (job.endedAt !== null && now - job.endedAt > this.keepMs) this.jobs.delete(id);
    }
  }
}

/** The database sink for finished runs. Kept half an hour, like the in-memory copy. */
export function sqlRunSink(run: (sql: string, params: unknown[]) => Promise<{ rows: any[] }>): RunSink {
  return {
    async save(id, userId, state) {
      await run(`delete from agent_runs where ended_at < now() - interval '30 minutes'`, []);
      await run(`insert into agent_runs (id, user_id, state, ended_at) values ($1, $2, $3, now())
                 on conflict (id) do update set state = excluded.state, ended_at = now()`,
        [id, userId, JSON.stringify(state)]);
    },
    async load(id, userId) {
      const { rows } = await run(
        `select state, ended_at from agent_runs where id = $1 and user_id = $2 and ended_at > now() - interval '30 minutes'`, [id, userId]);
      if (!rows[0]) return null;
      const state = (typeof rows[0].state === "string" ? JSON.parse(rows[0].state) : rows[0].state) as RunState;
      // Saved as running and never finished within 20 minutes: its server stopped mid-run.
      if (state.status === "running" && Date.now() - new Date(rows[0].ended_at).getTime() > 20 * 60_000) return null;
      return state;
    },
  };
}
