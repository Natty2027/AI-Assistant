# Safe actions: how the assistant acts for people without hurting them

The assistant can now build a small website and draft promotion for a person's own activities.
This document explains how it does that safely, and why each rule exists.

**The short version: the model proposes, the person approves the exact content, and the server
executes it once after checking every rule again.** The model has no tool that publishes, posts,
sends or spends. Everything it can do on its own stays inside the app.

## Who can get hurt, and how

| Who | How an assistant that acts can hurt them |
|---|---|
| **The person using it** | Accounts banned for spam or automation; fines for deceptive advertising or illegal texting; surprise charges; content published that they never meant. |
| **Their audience** | Spam; phishing pages; fake reviews; visitor data sent to strangers. |
| **The platforms** | Automated abuse that breaks their rules (and gets our whole app cut off). |
| **Us** | Liability for all of the above. |

The design treats the model as capable but not trustworthy. It can be wrong, and anything it reads
(a web page, a document) can try to steer it. OWASP's guidance for LLM applications says prompt
injection "exploits LLM design itself" and can't be patched away, and that a system prompt "should
not be treated as a security control". So every rule below is enforced in code, outside the model.

## The rules

### 1. The model proposes; the person approves; the server executes
- The model's tools: edit files in one website folder, check the site, draft posts, propose,
  and ask a question. Nothing else. (`server/agent/loop.ts`)
- A proposal is only a record. It becomes real through `ActionStore` (`server/agent/approvals.ts`)
  and only after the person approves it in the app.
- The model cannot propose email, texts, ads or domain purchases at all. A person can start those
  themselves; an assistant building a website and a post does not need them. This follows OWASP's
  "excessive agency" guidance: limit functionality, permissions and autonomy.

### 2. Approval is bound to exactly what the person saw
- The approval names a hash of the exact payload. If anything differs, approval is refused, and
  execution re-verifies it. The stored payload is a frozen copy.
- Approval returns a single-use secret token that expires in 15 minutes. The model never sees it.
  A replay, a second click or two simultaneous requests run the action once.
- Facts only the person can vouch for must be confirmed one by one: "these reviews are real",
  "I can back up this claim", "my site has a privacy policy". A generic OK does not cover them.
- Spending requires the amount typed back exactly.
- Every rule is evaluated again at the moment of execution, because limits and spending may have
  changed since the proposal.
- A failed execution is recorded and never retried automatically, because it may have partly
  happened. The person proposes it again.

### 3. Least privilege everywhere
- **Destinations are ids, never free text.** A post goes to "connection x1", one of the person's
  connected accounts; an email to "list news". The model cannot type a handle, address or URL to
  send something to, so injected text cannot redirect it.
- **Spending is off** until the person sets a monthly limit.
- **Daily limits per account sit below the platforms' own limits** (5 posts, 1 email campaign,
  1 text campaign per day), because volume alone reads as spam.

### 4. Outside content is data, never instructions
- Web search is off unless the person turns it on, since it is the main way hostile instructions
  get in.
- Once anything from the web enters a session, the session is marked **tainted**. Every proposal
  after that is flagged, and approving it requires the person to confirm they have read exactly
  what it will do.
- The system prompt also tells the model this, but that is a second line, not the defence.

### 5. Deterministic checks drawn from the actual rules (`server/agent/policy.ts`)

| Check | What it enforces | Source |
|---|---|---|
| Reviews and testimonials | Anything that looks like a review, rating or attributed quote needs the person to attest it is real and used with permission. The assistant never writes them. | FTC Consumer Reviews and Testimonials rule, 16 CFR 465 (AI-written reviews are covered; civil penalties per violation) |
| Strong claims | "Guaranteed", "risk-free", "cures" and similar need attestation. | FTC deceptive advertising principles |
| Sponsorship | Sponsored posts must say so (#ad, Sponsored, Paid partnership). | FTC endorsement disclosure |
| Spam | No more than 2 mentions; the same post may not go to two accounts in a week or twice in a day. | X automation rules |
| Platform fit | Length limits; Instagram needs media. | X, Instagram |
| Email | Unsubscribe link, physical postal address, no fake "RE:" subject, no purchased or scraped lists. | CAN-SPAM |
| Texts | Recorded written consent for every recipient, "Reply STOP" in the message, no sends before 8 AM or after 9 PM in the recipients' time zone. | TCPA |
| Money | A monthly spending limit, checked at proposal and at execution. | — |

### 6. Websites must not hurt their visitors (`server/agent/sandbox.ts`)
- Static sites only. Writes are confined to the site's folder: no `..`, absolute paths, hidden
  files or symlink tricks, only static file types, bounded sizes.
- Before a site can be published it is scanned. These **block**:
  - scripts from other websites;
  - forms that send answers to other websites;
  - password fields (phishing);
  - automatic redirects;
  - `javascript:` links.

  Embedded outside pages are a **warning**. Visitor tracking needs the owner to **attest** they
  have a privacy policy.
- Every published page carries a Content-Security-Policy, so the visitor's browser enforces the
  same rules.

### 7. Never automated, whoever asks
Direct messages to people who have not made contact; automated likes, follows, reposts or replies
to strangers; writing reviews or testimonials; posting the same content across several accounts;
buying followers or engagement; emailing purchased or scraped lists; texting without written
consent; logging into a platform through a browser to get around its official API. These have no
action type, so they cannot be proposed, approved or executed.

## Platform notes for when connectors are built
- **X:** automation must use the official API (browser automation leads to permanent
  suspension), automated accounts must enable the "Automated" label, and write access needs a paid
  API tier. Automate content and scheduling, never engagement.
- **Instagram (Meta):** publishing needs a Business or Creator account and, for accounts we don't
  own, Meta App Review, which third-party guides put at weeks. Published sources disagree on the daily
  post cap (25, 50 or 100); query `content_publishing_limit` per account rather than hard-coding it.
- **Email and texts:** honour opt-outs (CAN-SPAM: within 10 business days) and keep consent records
  (TCPA allows $500 to $1,500 per message in private suits).

## What is built and verified
- `server/agent/policy.ts`, `approvals.ts`, `sandbox.ts`, `loop.ts`: 65 tests covering each rule
  above, including hostile cases (injected web content, foreign destinations, sandbox escapes,
  replayed approvals, tampered payloads, truncated and refused model turns).
- Each core guarantee was deliberately broken and confirmed to fail a test (12 of 12).
- The agent requests `claude-opus-5-5` with adaptive thinking and Anthropic's server-side refusal
  fallback (`fallbacks: "default"`), typed against the official SDK.

- **Websites publish to the person's own Netlify** (`server/agent/netlify.ts`, `service.ts`). They
  paste a personal access token; it is checked with Netlify, encrypted with the same envelope
  scheme as every stored credential (`server/crypto/envelope.ts`), stored in `action_connections`
  (no client access), and deleted on disconnect. Approval is bound to a fingerprint of every file
  (`contentHash`), so a site edited after approval is refused at publish time. Republishing reuses
  the same Netlify site, so the address stays the same. A token Netlify revokes marks the
  connection for reconnection.
- **Posts publish to the person's own Bluesky** (`server/agent/bluesky.ts`) with an app password,
  checked with Bluesky and stored the same way.
- **The app's Create and Review screens** (`app/CyberCompanion/Views/AssistantView.swift`,
  `ReviewView.swift`) take the request, preview the site with scripts and forms off, and show each
  proposal's exact content, checks and confirmations before anything is approved.
- Tests: `test/netlify.test.ts`, `test/bluesky.test.ts` and `test/agentService.test.ts` (against
  real SQL and fake providers).

## What is not built yet
- **Only websites and Bluesky posts can be carried out.** Nothing is wired to X, Instagram, an
  email or SMS provider or an ad platform. Posts for those can be drafted and shared by hand from
  the app, and the server refuses to approve them (`not_connected`). Each platform needs its own
  developer app registration, review and OAuth.
- **Netlify has never been called for real.** The connector follows Netlify's documented API and
  is tested against a fake that behaves the same way, not against Netlify itself.
- **Proposal storage is in memory** and lost on restart (which fails safe; connections and site
  files persist). It needs a database table before more than one server runs.
- **The agent has never run against the live API.** All tests use a scripted model, so prompt
  quality and real behaviour are unmeasured.
- **This is not legal advice.** The compliance checks are guard rails drawn from the rules above,
  not a substitute for a lawyer's review before launch.

## Sources
- OWASP Top 10 for LLM Applications 2025 (prompt injection, excessive agency):
  [genai.owasp.org](https://genai.owasp.org), summarised by [Mend](https://www.mend.io/blog/2025-owasp-top-10-for-llm-applications-a-quick-guide/) and [Invicti](https://www.invicti.com/blog/web-security/owasp-top-10-risks-llm-security-2025)
- FTC final rule on fake reviews and testimonials: [FTC press release](https://www.ftc.gov/news-events/news/press-releases/2024/08/federal-trade-commission-announces-final-rule-banning-fake-reviews-testimonials), [Alston & Bird advisory](https://www.alston.com/en/insights/publications/2024/10/ftc-issues-final-rule-on-fake-reviews-testimonials)
- X automation rules: [help.x.com](https://help.x.com/en/rules-and-policies/x-automation), [X developer guidelines](https://docs.x.com/developer-guidelines)
- Instagram publishing requirements and limits: [Phyllo integration guide](https://www.getphyllo.com/post/instagram-api-integration-101-for-developers-of-the-creator-economy), [Zernio notes on Meta's docs](https://zernio.com/blog/instagram-graph-api)
- CAN-SPAM: [Transcend guide](https://transcend.io/blog/can-spam-act), [UnsubCentral](https://www.unsubcentral.com/can-spam-compliance/)
- TCPA texting consent: [ActiveProspect](https://activeprospect.com/blog/tcpa-text-messages/), [Infobip](https://www.infobip.com/blog/tcpa-compliance-sms)
