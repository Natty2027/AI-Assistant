/**
 * The public pages App Store Connect requires: a Support URL, a Marketing URL and a Privacy
 * Policy URL must all resolve to real pages during review (Cognivate was rejected once for a 404
 * at its root). Plain HTML with inline styles, served under a CSP that allows nothing else.
 *
 * The policy and terms are a starting draft that describes what this code actually does. Have
 * them reviewed before launch, and update them whenever a new provider or data type is added.
 */

const UPDATED = "November 7, 2026";

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function layout(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escape(title)} · Cyber Companion</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; max-width: 720px; margin: 0 auto; padding: 48px 24px; line-height: 1.6; color: #1e293b; background: #f8fafc; }
  @media (prefers-color-scheme: dark) { body { color: #e2e8f0; background: #0b1026; } a { color: #7dd3fc; } .muted { color: #94a3b8; } }
  h1 { font-size: 2rem; margin-bottom: 0.25rem; letter-spacing: -0.01em; }
  h2 { font-size: 1.2rem; margin-top: 2rem; }
  a { color: #4f46e5; }
  .muted { color: #64748b; font-size: 0.9rem; }
  nav { margin-top: 3rem; padding-top: 1.5rem; border-top: 1px solid rgba(100,116,139,0.3); }
  nav a { margin-right: 1rem; }
</style>
</head>
<body>
${body}
<nav><a href="/support">Support</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a></nav>
</body>
</html>`;
}

export function supportPage(email: string): string {
  const mail = escape(email);
  return layout("Support", `
<h1>Cyber Companion</h1>
<p>Speak or type what you'd like, and Cyber Companion builds a website and writes social posts for it. You review the exact content, and nothing is published until you approve it.</p>
<h2>Get help</h2>
<p>Email <a href="mailto:${mail}">${mail}</a>. If something went wrong, include the request ID the app showed you, if any.</p>
<h2>Common questions</h2>
<p><strong>Is my voice recorded?</strong> No. Speech is turned into text on your device by Apple's speech recognition. Only the text you choose to send leaves your device.</p>
<p><strong>Can it post without me?</strong> No. Every website and post waits in Review until you approve that exact content.</p>
<p><strong>How do I delete my account?</strong> In the app, open Settings and choose Delete account. Your data and your sign-in account are deleted.</p>`);
}

export function privacyPage(email: string): string {
  const mail = escape(email);
  return layout("Privacy Policy", `
<h1>Privacy Policy</h1>
<p class="muted">Last updated: ${UPDATED}</p>
<p>This policy explains what Cyber Companion ("we") collects, why, and the choices you have.</p>

<h2>What we collect</h2>
<p><strong>Account.</strong> When you sign in with Apple we receive an account identifier and, if you choose to share it, your email address (which may be an Apple private relay address). Sign-in is handled by Supabase.</p>
<p><strong>What you ask for and what we make.</strong> The requests you type or dictate, the websites and posts the assistant creates, and your approvals.</p>
<p><strong>Connected accounts.</strong> If you connect Netlify or Bluesky, we store the token or app password you provide, encrypted, only to publish what you approve. You can disconnect at any time, which deletes it.</p>
<p><strong>Voice.</strong> Speech is recognized on your device. We never receive audio.</p>
<p>We do not use tracking, advertising identifiers or third-party analytics, and we do not sell data.</p>

<h2>Who processes it</h2>
<ul>
  <li><strong>Anthropic</strong> (the maker of Claude) receives your requests and the content the assistant works on, to write your website and posts. We ask for your consent before any AI processing and you can withdraw it in Settings. Your email address is not sent to Anthropic.</li>
  <li><strong>Supabase</strong>: sign-in and our database.</li>
  <li><strong>Our hosting provider</strong> runs the server.</li>
  <li><strong>Netlify</strong> and <strong>Bluesky</strong>, only when you connect them and approve publishing to your own account.</li>
</ul>

<h2>Retention and deletion</h2>
<p>We keep your data while your account is active. Delete your account in the app (Settings, then Delete account) and we delete your data and your sign-in account. A minimal record of safety events, which contains no content, may be kept where needed to prevent abuse.</p>

<h2>Children</h2>
<p>Cyber Companion is not intended for children under 13, and we do not knowingly collect their data.</p>

<h2>Contact</h2>
<p><a href="mailto:${mail}">${mail}</a></p>`);
}

export function termsPage(email: string): string {
  const mail = escape(email);
  return layout("Terms of Use", `
<h1>Terms of Use</h1>
<p class="muted">Last updated: ${UPDATED}</p>
<p>By using Cyber Companion you agree to these terms.</p>
<h2>Your content</h2>
<p>You own what you create. You're responsible for what you approve and publish, including that it's accurate and that you have the right to publish it. The assistant can make mistakes; review everything before approving.</p>
<h2>What's not allowed</h2>
<p>Spam, deceptive or fake reviews and testimonials, impersonation, harassment, or anything unlawful. The app enforces some of these rules automatically and may refuse a request.</p>
<h2>Third-party platforms</h2>
<p>Publishing to Netlify or Bluesky is subject to their terms. Posting to other platforms happens through your own apps, under their terms.</p>
<h2>The service</h2>
<p>The service is provided as is. We may change or end features, and we may suspend accounts that break these terms.</p>
<h2>Contact</h2>
<p><a href="mailto:${mail}">${mail}</a></p>`);
}
