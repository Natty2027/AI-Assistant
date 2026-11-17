/**
 * Requests to Hera that run in the background. Building a website can take Hera ten minutes or
 * more (every page is a long step), which is longer than a phone will hold one request open, so
 * the app starts a run, gets its id at once, and checks back every few seconds for the answer.
 *
 * Kept in memory: a run belongs to this server process, and a restart (a deploy) loses the ones in
 * flight, which the app reports so the person can send the request again. One run per person at a
 * time, so two requests can't edit the same website at once. Finished answers are kept for half an
 * hour, so an app that was in the background can still collect its answer.
 */
import { randomUUID } from "node:crypto";

export interface RunFailure { status: number; message: string; code?: string }

export type RunState =
  | { status: "running" }
  | { status: "finished"; result: unknown }
  | { status: "failed"; failure: RunFailure };

interface Job { userId: string; state: RunState; endedAt: number | null }

export class RunJobs {
  private readonly jobs = new Map<string, Job>();

  constructor(
    /** Turns a failed run into what the app is told. Unknown errors become a plain apology. */
    private readonly describe: (e: unknown) => RunFailure,
    private readonly clock: () => number = () => Date.now(),
    private readonly keepMs = 30 * 60_000,
  ) {}

  isRunning(userId: string): boolean {
    this.sweep();
    return [...this.jobs.values()].some((j) => j.userId === userId && j.state.status === "running");
  }

  /** Starts `work` and returns the run's id at once. Callers check isRunning first. */
  start(userId: string, work: () => Promise<unknown>): string {
    const id = randomUUID();
    const job: Job = { userId, state: { status: "running" }, endedAt: null };
    this.jobs.set(id, job);
    work().then(
      (result) => { job.state = { status: "finished", result }; job.endedAt = this.clock(); },
      (e) => { job.state = { status: "failed", failure: this.describe(e) }; job.endedAt = this.clock(); },
    );
    return id;
  }

  /** The run's state, or null if it isn't this person's or is no longer kept. */
  get(userId: string, id: string): RunState | null {
    this.sweep();
    const job = this.jobs.get(id);
    return job && job.userId === userId ? job.state : null;
  }

  private sweep(): void {
    const now = this.clock();
    for (const [id, job] of this.jobs) {
      if (job.endedAt !== null && now - job.endedAt > this.keepMs) this.jobs.delete(id);
    }
  }
}
