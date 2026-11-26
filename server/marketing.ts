/**
 * Selling Hera itself: its public home page and a private growth dashboard for the owner.
 *
 * The home page is plain HTML with inline styles, served under the same strict policy as the
 * other public pages (nothing loads from elsewhere, nothing runs). With APP_STORE_ID set it shows
 * Safari's Smart App Banner and links to the App Store; until then, to TESTFLIGHT_URL if set.
 *
 * The dashboard counts people at each step (signed up, asked Hera, approved something, Pro). Only
 * counts: no names, no content. It's behind ADMIN_TOKEN, asked for by the browser (Basic auth).
 */
import { timingSafeEqual } from "node:crypto";

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export interface StoreLinks { appStoreId?: string; testflightUrl?: string }

/** Where "Get Hera" goes: the App Store once Hera is there, TestFlight before. */
export function getHeraUrl(links: StoreLinks): string | null {
  if (links.appStoreId && /^\d{6,12}$/.test(links.appStoreId)) return `https://apps.apple.com/app/id${links.appStoreId}`;
  if (links.testflightUrl?.startsWith("https://testflight.apple.com/")) return links.testflightUrl;
  return null;
}

const FEATURES: Array<[string, string, string]> = [
  ["🎨", "Posters and posts", "A poster in every size (Instagram, Stories, a printable flyer) and posts for each platform, in your brand's colors."],
  ["⏰", "Scheduled posts", "Say when, and your approved posts go out on time, even a whole series: every Monday for a month."],
  ["🏷️", "Sell on eBay", "Snap a photo, say the price. Hera writes the listing, picks the category and fills in the details."],
  ["🚀", "Launch Kit", "One request for an event or a sale: the posts, the countdown, the poster, the email and the calendar, all ready."],
  ["💬", "Emails and texts", "Hera writes them in your voice and reads them to you. You press Send."],
  ["📅", "Your schedule", "Hera plans around your calendar and reminds you before every event, out loud."],
];

/** Hera's public home page. */
export function homePage(links: StoreLinks, supportEmail: string): string {
  const url = getHeraUrl(links);
  const banner = links.appStoreId && /^\d{6,12}$/.test(links.appStoreId) ? `<meta name="apple-itunes-app" content="app-id=${links.appStoreId}" />` : "";
  const cta = url
    ? `<a class="cta" href="${escape(url)}">${links.appStoreId ? "Download on the App Store" : "Try Hera on TestFlight"}</a>`
    : `<span class="cta soon">Coming soon to the App Store</span>`;
  const mail = escape(supportEmail);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Hera: your marketing assistant, by voice</title>
<meta name="description" content="Hera makes posters, posts, emails and eBay listings for your small business. Say what you need; nothing goes out until you approve it." />
<meta property="og:title" content="Hera: your marketing assistant, by voice" />
<meta property="og:description" content="Posters, posts, emails and eBay listings for your small business. You approve everything." />
${banner}
<style>
  :root { color-scheme: light dark; --ink: #0f172a; --muted: #64748b; --bg: #f8fafc; --card: #ffffff; --accent: #5b4bdb; }
  @media (prefers-color-scheme: dark) { :root { --ink: #e2e8f0; --muted: #94a3b8; --bg: #0b1026; --card: #141a38; --accent: #8b7dff; } }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; color: var(--ink); background: var(--bg); line-height: 1.55; }
  main { max-width: 980px; margin: 0 auto; padding: 56px 24px 32px; }
  .hero { text-align: center; padding: 24px 0 40px; }
  h1 { font-size: clamp(2.2rem, 6vw, 3.6rem); line-height: 1.08; margin: 0 0 16px; letter-spacing: -0.02em;
       background: linear-gradient(90deg, #38bdf8, #5b4bdb 55%, #c084fc); -webkit-background-clip: text; background-clip: text; color: transparent; }
  .lead { font-size: 1.2rem; color: var(--muted); max-width: 640px; margin: 0 auto 28px; }
  .cta { display: inline-block; padding: 14px 26px; border-radius: 999px; background: var(--accent); color: #fff; font-weight: 600; text-decoration: none; }
  .cta.soon { background: transparent; color: var(--muted); border: 1px solid var(--muted); }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; margin: 24px 0 48px; }
  .card { background: var(--card); border-radius: 20px; padding: 22px; box-shadow: 0 8px 30px rgba(15, 23, 42, 0.06); }
  .card .icon { font-size: 1.8rem; }
  .card h3 { margin: 8px 0 6px; font-size: 1.1rem; }
  .card p { margin: 0; color: var(--muted); }
  h2 { text-align: center; font-size: 1.7rem; margin: 48px 0 8px; }
  .steps { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; counter-reset: step; }
  .steps div { padding: 18px; }
  .steps strong { display: block; font-size: 1.05rem; margin-bottom: 4px; }
  .promise { text-align: center; color: var(--muted); max-width: 640px; margin: 8px auto 0; }
  footer { max-width: 980px; margin: 0 auto; padding: 32px 24px 48px; color: var(--muted); font-size: 0.9rem; display: flex; gap: 18px; flex-wrap: wrap; }
  footer a { color: var(--muted); }
</style>
</head>
<body>
<main>
  <section class="hero">
    <h1>Say it. Hera makes it.<br/>You approve it.</h1>
    <p class="lead">Your small business's marketing assistant. Posters, posts, emails and eBay listings, by voice or by typing, in your brand's colors.</p>
    ${cta}
  </section>
  <section class="grid">
    ${FEATURES.map(([icon, title, text]) => `<div class="card"><div class="icon">${icon}</div><h3>${escape(title)}</h3><p>${escape(text)}</p></div>`).join("\n    ")}
  </section>
  <h2>How it works</h2>
  <section class="steps">
    <div><strong>1. Say what you need</strong>"Make a poster and posts for Saturday's open house, 10 to 2."</div>
    <div><strong>2. Hera makes it</strong>The poster, the posts and the email, ready in a minute or two.</div>
    <div><strong>3. You approve</strong>Nothing is posted, published or sent until you've seen it and said yes.</div>
  </section>
  <p class="promise">Your voice is turned into text on your phone. Your contacts and calendar stay on it. You can delete everything at any time.</p>
  <section class="hero">${cta}</section>
</main>
<footer><span>© Hera</span><a href="/support">Support</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="mailto:${mail}">${mail}</a></footer>
</body>
</html>`;
}

/* ------------------------------ the owner's dashboard ------------------------------ */

/** True when the browser sent ADMIN_TOKEN as the password (any user name). */
export function adminAllowed(authorization: string | undefined, token: string | undefined): boolean {
  if (!token || token.length < 24 || !authorization?.startsWith("Basic ")) return false;
  const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
  const given = Buffer.from(decoded.slice(decoded.indexOf(":") + 1));
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

export interface Growth {
  accounts: number; newThisWeek: number; newThisMonth: number;
  askedHera: number; activeThisMonth: number; requestsThisMonth: number;
  approvedSomething: number; pro: number;
}

type Run = (sql: string, params: unknown[]) => Promise<{ rows: any[] }>;

/** The counts. A table from a migration not yet run counts as zero rather than failing. */
export async function growth(run: Run): Promise<Growth> {
  const one = async (sql: string): Promise<number> => {
    try { return Number((await run(sql, [])).rows[0]?.n ?? 0); } catch { return 0; }
  };
  const month = new Date().toISOString().slice(0, 7);
  const [accounts, newThisWeek, newThisMonth, askedHera, activeThisMonth, requestsThisMonth, approvedSomething, pro] = await Promise.all([
    one(`select count(*)::int as n from user_settings`),
    one(`select count(*)::int as n from user_settings where created_at > now() - interval '7 days'`),
    one(`select count(*)::int as n from user_settings where created_at > now() - interval '30 days'`),
    one(`select count(distinct user_id)::int as n from agent_usage`),
    one(`select count(distinct user_id)::int as n from agent_usage where month = '${month}'`),
    one(`select coalesce(sum(requests), 0)::int as n from agent_usage where month = '${month}'`),
    one(`select count(distinct user_id)::int as n from agent_proposals where record->>'status' = 'executed'`),
    one(`select count(*)::int as n from user_plans where expires_at > now()`),
  ]);
  return { accounts, newThisWeek, newThisMonth, askedHera, activeThisMonth, requestsThisMonth, approvedSomething, pro };
}

const pct = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : "–");

export function growthPage(g: Growth): string {
  const row = (label: string, value: number, note = "") => `<tr><td>${label}</td><td class="n">${value}</td><td class="muted">${note}</td></tr>`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="robots" content="noindex" /><title>Hera growth</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 720px; margin: 0 auto; padding: 40px 24px; }
  table { width: 100%; border-collapse: collapse; margin: 16px 0 32px; }
  td { padding: 10px 8px; border-bottom: 1px solid rgba(100,116,139,.25); }
  td.n { text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; }
  .muted { color: #64748b; font-size: .9rem; }
</style></head><body>
<h1>Hera growth</h1>
<p class="muted">Counts only, no personal data. ${new Date().toUTCString()}</p>
<h2>The funnel</h2>
<table>
${row("Accounts", g.accounts)}
${row("Asked Hera at least once", g.askedHera, `${pct(g.askedHera, g.accounts)} of accounts`)}
${row("Approved something (posted or listed)", g.approvedSomething, `${pct(g.approvedSomething, g.askedHera)} of those who asked`)}
${row("Hera Pro now", g.pro, `${pct(g.pro, g.accounts)} of accounts`)}
</table>
<h2>Recently</h2>
<table>
${row("New accounts, last 7 days", g.newThisWeek)}
${row("New accounts, last 30 days", g.newThisMonth)}
${row("Active this month", g.activeThisMonth, "asked Hera at least once")}
${row("Requests this month", g.requestsThisMonth, g.activeThisMonth ? `${(g.requestsThisMonth / g.activeThisMonth).toFixed(1)} per active person` : "")}
</table>
<p class="muted">Downloads, page views and App Store conversion are in App Store Connect → Analytics.</p>
</body></html>`;
}
