/**
 * Where a website the assistant builds lives until the user publishes it.
 *
 * Two jobs:
 *   1. Confine writes. Every path comes from the model, so it is untrusted: it is resolved and
 *      checked against the site's own folder (no `..`, no absolute paths, no symlink escapes),
 *      and only ordinary static-site file types, in bounded sizes, are accepted.
 *   2. Scan before publishing. A generated site can harm its *visitors*, not just its owner: a
 *      password field is a phishing kit, a form that posts elsewhere leaks visitor data, an
 *      outside script is code nobody reviewed. Those block a deploy; tracking needs the owner to
 *      confirm they have a privacy policy.
 *
 * Static sites only. There is no server-side code here to run, which removes a whole class of
 * risk (and of hosting cost) from what the assistant can produce.
 */
import { mkdir, readFile, readdir, realpath, stat, writeFile, lstat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Check } from "./policy.ts";

const ALLOWED_EXT = new Set([".html", ".css", ".js", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico", ".txt", ".xml", ".json", ".webmanifest"]);
export const LIMITS = { fileBytes: 2 * 1024 * 1024, files: 60, totalBytes: 10 * 1024 * 1024 } as const;

/** The policy injected into every published page: only this site's own scripts and styles. */
export const CSP = "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'self'";

export class SandboxError extends Error {
  constructor(readonly code: "path" | "type" | "size" | "count" | "missing", message: string) { super(message); }
}

export class SiteSandbox {
  private constructor(readonly siteId: string, private readonly root: string) {}

  /** `baseDir` holds one folder per site. `siteId` is server-generated, never model-supplied. */
  static async open(baseDir: string, siteId: string): Promise<SiteSandbox> {
    if (!/^[a-z0-9-]{1,64}$/.test(siteId)) throw new SandboxError("path", "bad site id");
    const dir = path.join(baseDir, siteId);
    await mkdir(dir, { recursive: true });
    return new SiteSandbox(siteId, await realpath(dir));
  }

  /** Resolve a model-supplied relative path, refusing anything that leaves the site folder. */
  private resolve(rel: string): string {
    if (typeof rel !== "string" || rel.length === 0 || rel.length > 200) throw new SandboxError("path", "invalid path");
    if (rel.includes("\0") || /%2e|%2f|%5c/i.test(rel) || path.isAbsolute(rel) || rel.includes("\\")) {
      throw new SandboxError("path", "path must be a plain relative path inside the site");
    }
    const target = path.resolve(this.root, rel);
    const relative = path.relative(this.root, target);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new SandboxError("path", "path escapes the site folder");
    }
    if (relative.split(path.sep).some((part) => part.startsWith("."))) {
      throw new SandboxError("path", "hidden files and folders are not allowed");
    }
    return target;
  }

  async write(rel: string, contents: string): Promise<void> {
    const target = this.resolve(rel);
    const ext = path.extname(target).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) throw new SandboxError("type", `file type ${ext || "(none)"} is not allowed on a static site`);
    const bytes = Buffer.byteLength(contents, "utf8");
    if (bytes > LIMITS.fileBytes) throw new SandboxError("size", "file is too large");

    const existing = await this.files();
    const isNew = !existing.some((f) => f.path === path.relative(this.root, target).split(path.sep).join("/"));
    if (isNew && existing.length >= LIMITS.files) throw new SandboxError("count", "too many files in this site");
    const total = existing.reduce((n, f) => n + f.bytes, 0) + bytes;
    if (total > LIMITS.totalBytes) throw new SandboxError("size", "the site is too large");

    await mkdir(path.dirname(target), { recursive: true });
    // A symlink planted inside the folder must not redirect a write outside it.
    const parentReal = await realpath(path.dirname(target));
    if (parentReal !== this.root && !parentReal.startsWith(this.root + path.sep)) {
      throw new SandboxError("path", "path escapes the site folder");
    }
    try {
      if ((await lstat(target)).isSymbolicLink()) throw new SandboxError("path", "refusing to write through a link");
    } catch (e) { if (e instanceof SandboxError) throw e; /* does not exist yet: fine */ }
    await writeFile(target, contents, "utf8");
  }

  async read(rel: string): Promise<string> {
    const target = this.resolve(rel);
    const real = await realpath(target).catch(() => { throw new SandboxError("missing", "no such file"); });
    if (real !== this.root && !real.startsWith(this.root + path.sep)) throw new SandboxError("path", "path escapes the site folder");
    return readFile(real, "utf8");
  }

  async files(): Promise<Array<{ path: string; bytes: number }>> {
    const out: Array<{ path: string; bytes: number }> = [];
    const walk = async (dir: string) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile()) out.push({ path: path.relative(this.root, full).split(path.sep).join("/"), bytes: (await stat(full)).size });
      }
    };
    await walk(this.root);
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  /** A fingerprint of every file's path and contents. Any edit, addition or removal changes it. */
  async digest(): Promise<string> {
    const h = createHash("sha256");
    for (const f of await this.files()) {
      const body = createHash("sha256").update(await this.read(f.path), "utf8").digest("hex");
      h.update(`${f.path}\0${body}\n`);
    }
    return h.digest("hex");
  }

  /** Everything that must be true before this site can be shown to the public. */
  async scan(): Promise<Check[]> {
    const checks: Check[] = [];
    const files = await this.files();
    if (!files.some((f) => f.path === "index.html")) {
      checks.push({ id: "no_index", level: "block", message: "The site needs an index.html home page." });
    }
    const seen = new Set<string>();
    const add = (c: Check) => { if (!seen.has(c.id)) { seen.add(c.id); checks.push(c); } };

    for (const f of files.filter((f) => f.path.endsWith(".html"))) {
      const html = await this.read(f.path);
      if (/<script\b[^>]*\bsrc\s*=\s*["']?\s*(https?:)?\/\//i.test(html)) {
        add({ id: "external_script", level: "block", message: `${f.path} loads a script from another website. Only the site's own scripts can be published.` });
      }
      if (/<form\b[^>]*\baction\s*=\s*["']?\s*(https?:)?\/\//i.test(html)) {
        add({ id: "external_form", level: "block", message: `${f.path} has a form that sends visitors' answers to another website.` });
      }
      if (/<input\b[^>]*\btype\s*=\s*["']?password/i.test(html)) {
        add({ id: "password_field", level: "block", message: `${f.path} asks visitors for a password. Generated sites may not collect passwords.` });
      }
      if (/<meta\b[^>]*http-equiv\s*=\s*["']?refresh[^>]*url\s*=/i.test(html)) {
        add({ id: "redirect", level: "block", message: `${f.path} automatically sends visitors to another page.` });
      }
      if (/\b(href|src|action)\s*=\s*["']?\s*javascript:/i.test(html)) {
        add({ id: "javascript_url", level: "block", message: `${f.path} contains a javascript: link.` });
      }
      if (/<iframe\b[^>]*\bsrc\s*=\s*["']?\s*(https?:)?\/\//i.test(html)) {
        add({ id: "external_frame", level: "warn", message: `${f.path} embeds another website.` });
      }
      if (/(google-analytics\.com|googletagmanager\.com|facebook\.com\/tr|connect\.facebook\.net|hotjar\.com|doubleclick\.net)/i.test(html)) {
        add({ id: "tracking", level: "attest", message: "The site tracks visitors. You need a privacy policy that says so." });
      }
    }
    return checks;
  }

  /** The files to publish, with the content-security policy added to every HTML page so a
   *  browser enforces the same rules the scan checked. */
  async bundle(): Promise<Array<{ path: string; contents: string }>> {
    const out: Array<{ path: string; contents: string }> = [];
    for (const f of await this.files()) {
      let contents = await this.read(f.path);
      if (f.path.endsWith(".html")) {
        const meta = `<meta http-equiv="Content-Security-Policy" content="${CSP}">`;
        contents = /<head[^>]*>/i.test(contents)
          ? contents.replace(/<head[^>]*>/i, (m) => `${m}\n${meta}`)
          : `${meta}\n${contents}`;
      }
      out.push({ path: f.path, contents });
    }
    return out;
  }
}
