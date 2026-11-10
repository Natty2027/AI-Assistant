/**
 * Photos people attach to their posts. Instagram requires one, and Meta fetches it from a public
 * https address rather than taking an upload, so photos are kept here and served at
 * <publicUrl>/media/<id>.jpg.
 *
 * The id is the owner's site id (a hash, not their user id) plus 128 random bits: nobody can
 * guess another person's photo address, and ownership is checked from the id without a lookup.
 * Only JPEG is accepted (the app converts), and photos are removed after a week, which is long
 * enough to review and approve a post, and with the rest of the person's data on account deletion.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
/** Per person: the oldest photos make way beyond this, so nobody can fill the disk. */
export const MAX_PHOTOS_PER_OWNER = 20;
const KEEP_MS = 7 * 24 * 3_600_000;
const FILE = /^(u-[a-f0-9]{24})-([a-f0-9]{32})\.jpg$/;

export class MediaError extends Error {}

export class MediaStore {
  constructor(private readonly dir: string, private readonly clock: () => number = () => Date.now()) {}

  /** Saves a base64 JPEG for `owner` (a site id) and returns its id. */
  async save(owner: string, base64: unknown): Promise<string> {
    if (typeof base64 !== "string" || !base64.length) throw new MediaError("Attach a photo.");
    const bytes = Buffer.from(base64, "base64");
    if (bytes.length > MAX_PHOTO_BYTES) throw new MediaError("That photo is too large; use one under 5 MB.");
    // JPEG files start FF D8 FF.
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) throw new MediaError("Photos must be JPEG.");
    await mkdir(this.dir, { recursive: true });
    await this.sweep();
    await this.trim(owner, MAX_PHOTOS_PER_OWNER - 1);
    const id = `${owner}-${randomBytes(16).toString("hex")}`;
    await writeFile(path.join(this.dir, `${id}.jpg`), bytes, { mode: 0o600 });
    return id;
  }

  /** True when `id` belongs to `owner` and the photo is still here. */
  async owns(owner: string, id: string): Promise<boolean> {
    const m = FILE.exec(`${id}.jpg`);
    if (!m || m[1] !== owner) return false;
    return stat(path.join(this.dir, `${id}.jpg`)).then((s) => this.fresh(s.mtimeMs), () => false);
  }

  private fresh(mtimeMs: number): boolean { return this.clock() - mtimeMs <= KEEP_MS; }

  /** Keeps at most `keep` of an owner's photos, removing the oldest. */
  private async trim(owner: string, keep: number): Promise<void> {
    const mine: Array<{ file: string; at: number }> = [];
    for (const name of await readdir(this.dir).catch(() => [] as string[])) {
      if (FILE.exec(name)?.[1] !== owner) continue;
      const s = await stat(path.join(this.dir, name)).catch(() => null);
      if (s) mine.push({ file: path.join(this.dir, name), at: s.mtimeMs });
    }
    mine.sort((a, b) => b.at - a.at);
    for (const old of mine.slice(Math.max(keep, 0))) await rm(old.file, { force: true });
  }

  /** The bytes for a public request, or null. `file` is untrusted, so it must match the pattern exactly. */
  async read(file: string): Promise<Buffer | null> {
    if (!FILE.test(file)) return null;
    // Past its week, a photo isn't served even if the sweep hasn't removed it yet.
    const full = path.join(this.dir, file);
    const s = await stat(full).catch(() => null);
    if (!s || !this.fresh(s.mtimeMs)) return null;
    return readFile(full).catch(() => null);
  }

  /** Account deletion. */
  async removeAll(owner: string): Promise<void> {
    for (const name of await readdir(this.dir).catch(() => [] as string[])) {
      if (FILE.exec(name)?.[1] === owner) await rm(path.join(this.dir, name), { force: true });
    }
  }

  private async sweep(): Promise<void> {
    const now = this.clock();
    for (const name of await readdir(this.dir).catch(() => [] as string[])) {
      if (!FILE.test(name)) continue;
      const file = path.join(this.dir, name);
      const s = await stat(file).catch(() => null);
      if (s && now - s.mtimeMs > KEEP_MS) await rm(file, { force: true });
    }
  }
}
