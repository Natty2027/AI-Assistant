/**
 * Create page: connect a hosting account, ask the assistant for a site or a post, preview the
 * result, and approve exactly what will be published. All requests go through the service
 * worker's "agent:call" bridge; this page never holds the sign-in token or a provider token.
 */

import { initAppearance } from "./appearance";

interface Check { id: string; level: "block" | "attest" | "warn"; message: string }
interface Proposal {
  id: string; kind: string; label: string; summary: string; payload: Record<string, any>; payloadHash: string;
  checks: Check[]; tainted: boolean; status: string; expiresAt: string; result: { ref?: string; detail?: string } | null;
  canBeCarriedOut: boolean;
}

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function escapeHtml(s: string): string {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

async function call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const out = await chrome.runtime.sendMessage({ type: "agent:call", method, path, body });
  if (!out?.ok) throw new Error(out?.error ?? "Something went wrong.");
  return out.data as T;
}

function say(id: string, text: string, error = false): void {
  const m = el<HTMLParagraphElement>(id);
  m.textContent = text;
  m.classList.toggle("msg-error", error);
}

/* ---------------- connections ---------------- */

async function renderConnections(): Promise<void> {
  const { connections } = await call<{ connections: Array<{ id: string; label: string }> }>("GET", "/agent/connections");
  el("connList").innerHTML = connections.length
    ? connections.map((c) => `<div class="conn"><span>${escapeHtml(c.label)}</span>
        <button class="btn btn-ghost btn-sm" data-disconnect="${escapeHtml(c.id)}">Remove</button></div>`).join("")
    : `<p class="text-sm text-muted">No account connected. You can still build and preview a site.</p>`;
}

el<HTMLFormElement>("connForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = el<HTMLInputElement>("tokenInput");
  say("connMsg", "Checking the token with Netlify…");
  try {
    await call("POST", "/agent/connections/netlify", { token: input.value.trim() });
    input.value = "";
    say("connMsg", "Connected.");
    await renderConnections();
  } catch (err) {
    say("connMsg", (err as Error).message, true);
  }
});

el("connList").addEventListener("click", async (e) => {
  const id = (e.target as HTMLElement).closest<HTMLElement>("[data-disconnect]")?.dataset.disconnect;
  if (!id) return;
  try {
    await call("DELETE", `/agent/connections/${encodeURIComponent(id)}`);
    say("connMsg", "Removed. The token was deleted.");
    await renderConnections();
  } catch (err) {
    say("connMsg", (err as Error).message, true);
  }
});

/* ---------------- site preview ---------------- */

let siteHash = "";

async function renderSite(): Promise<void> {
  const site = await call<{ files: Array<{ path: string; bytes: number }>; checks: Check[]; contentHash: string }>("GET", "/agent/site");
  siteHash = site.contentHash;
  el("siteSection").hidden = site.files.length === 0;
  if (!site.files.length) return;
  el("fileList").innerHTML = site.files.map((f) => `<li>${escapeHtml(f.path)} · ${f.bytes} bytes</li>`).join("");
  el("siteChecks").innerHTML = site.checks.map((c) => renderCheck(c)).join("");

  const read = (p: string) => call<{ contents: string }>("GET", `/agent/site/file?path=${encodeURIComponent(p)}`).then((r) => r.contents);
  if (!site.files.some((f) => f.path === "index.html")) return;
  let html = await read("index.html");
  // The preview frame has no URL of its own, so inline the site's own stylesheets for display.
  for (const f of site.files.filter((x) => x.path.endsWith(".css"))) {
    const css = (await read(f.path)).replace(/<\/style/gi, "<\\/style");
    html = html.replace(new RegExp(`<link[^>]+href=["']\\.?/?${f.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]*>`, "i"), `<style>${css}</style>`);
  }
  // sandbox="" on the frame: no scripts, no forms, no navigation of this page.
  el<HTMLIFrameElement>("preview").srcdoc = html;
}

/* ---------------- proposals ---------------- */

function renderCheck(c: Check, withBox = false): string {
  const text = escapeHtml(c.message);
  if (withBox && c.level === "attest") {
    return `<div class="check check-attest"><label><input type="checkbox" data-attest="${escapeHtml(c.id)}" /> <span>${text}</span></label></div>`;
  }
  return `<div class="check check-${c.level}">${c.level === "block" ? "Can't publish: " : ""}${text}</div>`;
}

function describe(p: Proposal): string {
  if (p.kind === "site.deploy") {
    const stale = siteHash && p.payload.contentHash !== siteHash
      ? `<div class="check check-block">The site changed after this was proposed. Reject this and ask for a new one.</div>` : "";
    return `<p class="text-sm">Publishes the site shown in the preview above (version <code>${escapeHtml(String(p.payload.contentHash).slice(0, 12))}</code>).</p>${stale}`;
  }
  if (p.kind === "social.post") {
    return `<div class="post-text">${escapeHtml(String(p.payload.text ?? ""))}</div>${p.payload.link ? `<p class="text-sm">Link: ${escapeHtml(String(p.payload.link))}</p>` : ""}`;
  }
  return `<pre class="post-text">${escapeHtml(JSON.stringify(p.payload, null, 2))}</pre>`;
}

function renderProposal(p: Proposal): string {
  const pending = p.status === "pending";
  const live = p.status === "executed" && p.result?.ref && /^https:\/\//.test(p.result.ref)
    ? `<p class="msg">Published: <a href="${escapeHtml(p.result.ref)}" target="_blank" rel="noopener noreferrer">${escapeHtml(p.result.ref)}</a></p>` : "";
  const failed = p.status === "failed" && p.result?.detail ? `<p class="msg msg-error">${escapeHtml(p.result.detail)}</p>` : "";
  const taint = pending && p.tainted
    ? `<div class="check check-attest"><label><input type="checkbox" data-taint /> <span>Parts of this came from web pages. I have read exactly what it will do.</span></label></div>` : "";
  const actions = !pending ? "" : p.canBeCarriedOut
    ? `<div class="row"><button class="btn btn-primary btn-sm" data-approve="${escapeHtml(p.id)}">Approve and publish</button>
       <button class="btn btn-ghost btn-sm" data-reject="${escapeHtml(p.id)}">Reject</button></div>`
    : `<p class="text-sm text-muted">This can't be posted for you yet. Copy it and post it yourself.</p>
       <div class="row"><button class="btn btn-ghost btn-sm" data-reject="${escapeHtml(p.id)}">Dismiss</button></div>`;
  return `<article class="card" data-proposal="${escapeHtml(p.id)}">
    <div class="status">${escapeHtml(p.label)} · ${escapeHtml(p.status)}</div>
    <h3 style="margin:4px 0">${escapeHtml(p.summary)}</h3>
    ${describe(p)}
    ${p.checks.map((c) => renderCheck(c, pending)).join("")}
    ${taint}${actions}${live}${failed}
    <p class="msg" data-msg role="status"></p>
  </article>`;
}

let proposals: Proposal[] = [];

async function renderProposals(): Promise<void> {
  proposals = (await call<{ proposals: Proposal[] }>("GET", "/agent/proposals")).proposals;
  el("proposalList").innerHTML = proposals.length ? proposals.map(renderProposal).join("") : `<p class="text-sm text-muted">Nothing yet.</p>`;
}

el("proposalList").addEventListener("click", async (e) => {
  const target = e.target as HTMLElement;
  const approveId = target.closest<HTMLElement>("[data-approve]")?.dataset.approve;
  const rejectId = target.closest<HTMLElement>("[data-reject]")?.dataset.reject;
  const id = approveId ?? rejectId;
  if (!id) return;
  const card = target.closest<HTMLElement>("[data-proposal]")!;
  const msg = card.querySelector<HTMLElement>("[data-msg]")!;
  const p = proposals.find((x) => x.id === id);
  if (!p) return;
  try {
    if (rejectId) {
      await call("POST", `/agent/proposals/${encodeURIComponent(id)}/reject`);
    } else {
      const attestations = Array.from(card.querySelectorAll<HTMLInputElement>("[data-attest]")).filter((b) => b.checked).map((b) => b.dataset.attest!);
      const acknowledge = card.querySelector<HTMLInputElement>("[data-taint]")?.checked === true;
      (target as HTMLButtonElement).disabled = true;
      msg.textContent = "Publishing…";
      // The hash sent is the one this page showed; the server refuses if anything differs.
      const { token } = await call<{ token: string }>("POST", `/agent/proposals/${encodeURIComponent(id)}/approve`,
        { payload_hash: p.payloadHash, attestations, acknowledge_taint: acknowledge });
      await call("POST", `/agent/proposals/${encodeURIComponent(id)}/execute`, { token });
    }
    await renderProposals();
  } catch (err) {
    (target as HTMLButtonElement).disabled = false;
    msg.textContent = (err as Error).message;
    msg.classList.add("msg-error");
  }
});

/* ---------------- run ---------------- */

el("runBtn").addEventListener("click", async () => {
  const request = el<HTMLTextAreaElement>("requestInput").value.trim();
  if (!request) return say("runMsg", "Describe what you'd like first.", true);
  const btn = el<HTMLButtonElement>("runBtn");
  btn.disabled = true;
  say("runMsg", "Working on it. This can take a minute…");
  try {
    const out = await call<{ status: string; text: string }>("POST", "/agent/run", { request, allow_web_search: el<HTMLInputElement>("webSearch").checked });
    say("runMsg", out.text || (out.status === "done" ? "Done. Review it below." : "It stopped before finishing."), out.status === "refused" || out.status === "stopped");
    await Promise.all([renderSite(), renderProposals()]);
  } catch (err) {
    say("runMsg", (err as Error).message, true);
  } finally {
    btn.disabled = false;
  }
});

/* ---------------- start ---------------- */

void initAppearance();
void Promise.all([renderConnections(), renderSite(), renderProposals()]).catch((err) => say("runMsg", (err as Error).message, true));
