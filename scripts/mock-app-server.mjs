/**
 * A stand-in for the server, for working on the app without a database or an AI key.
 * Answers the endpoints the app uses with realistic, fixed data, and keeps proposal state in
 * memory so approving and publishing can be tried end to end.
 *
 *   npm run mock:app        then point the app at http://localhost:4480 with any token
 */
import http from "node:http";
import crypto from "node:crypto";

const PORT = Number(process.env.PORT ?? 4480);

const connections = [
  { id: "c-bsky", kind: "social", provider: "bluesky", platform: "bluesky", label: "Bluesky (@claycorner.bsky.social)" },
];

let proposals = [];
let n = 0;
const runs = new Map();

function proposal(kind, label, summary, payload, checks = []) {
  return {
    id: `p${++n}`, kind, label, summary, payload, payloadHash: `hash${n}`, checks, tainted: false,
    status: checks.some((c) => c.level === "block") ? "blocked" : "pending",
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(), result: null, canBeCarriedOut: true,
  };
}

function run() {
  const post = proposal("social.post", "Publish a social post", "Announce the Saturday class on Bluesky", {
    connectionId: "c-bsky", text: "Beginner pottery starts this Saturday at 10am at Clay Corner. Four weeks, a bowl and a mug, all materials included.",
    link: "https://claycorner.example/", sponsored: false, mediaRefs: [],
  });
  proposals = [post, ...proposals];
  return {
    status: "done",
    text: "I wrote posts announcing the class. The Bluesky post is waiting for your approval in Review; nothing has been posted. The Instagram and X posts are for you to share yourself.",
    tainted: false,
    proposals: [post],
    drafts: [
      { id: "d1", connectionId: "c-bsky", platform: "bluesky", text: post.payload.text, link: post.payload.link, sponsored: false, problems: [] },
      { id: "d2", connectionId: null, platform: "instagram", text: "Ever wanted to try the wheel? 🏺 Our beginner pottery class starts this Saturday at 10am. Four weeks, one bowl, one mug, all clay and firing included. Link in bio to sign up.", link: null, sponsored: false,
        problems: [{ id: "needs_media", level: "warn", message: "Add an image or video when you post this on Instagram." }] },
      { id: "d3", connectionId: null, platform: "x", text: "Beginner pottery at Clay Corner, Saturdays at 10am. Make a bowl and a mug in four weeks.", link: "https://claycorner.example/", sponsored: false, problems: [] },
    ],
  };
}

const send = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  console.log(req.method, url.pathname + url.search);
  if (!/^Bearer \S+/.test(req.headers.authorization ?? "")) return send(res, 401, { error: "Not signed in." });

  const p = url.pathname;
  const m = p.match(/^\/agent\/proposals\/([^/]+)\/(approve|execute|reject)$/);
  if (req.method === "GET" && p === "/consent/ai") return send(res, 200, { granted: true, at: new Date().toISOString() });
  if (req.method === "POST" && p === "/consent/ai") return send(res, 200, { ok: true, granted: body.granted });
  if (req.method === "GET" && p === "/agent/connections") return send(res, 200, { connections });
  // Website building was removed: an app that still asks for it is told to update, as the server does.
  if (req.method === "POST" && (p === "/agent/run" || p === "/agent/runs") && body.mode === "site") {
    return send(res, 410, { error: "Building websites was removed from Hera. Update the app to the latest version.", code: "mode_removed" });
  }
  if (req.method === "POST" && p === "/agent/run") {
    await new Promise((r) => setTimeout(r, 1200)); // feel like real work
    return send(res, 200, run());
  }
  // Background runs: finished 1.2 seconds after they start. ?wait= holds the check until then.
  if (req.method === "POST" && p === "/agent/runs") {
    const id = crypto.randomUUID();
    runs.set(id, { readyAt: Date.now() + 1200, result: run() });
    return send(res, 200, { run_id: id });
  }
  const r = p.match(/^\/agent\/runs\/([^/]+)$/);
  if (req.method === "GET" && r) {
    const job = runs.get(r[1]);
    if (!job) return send(res, 404, { error: "Hera lost track of that request. Please send it again.", code: "run_lost" });
    const wait = Math.min(25, Math.max(0, Math.floor(Number(url.searchParams.get("wait")) || 0))) * 1000;
    const left = job.readyAt - Date.now();
    if (left > 0 && wait > 0) await new Promise((done) => setTimeout(done, Math.min(left, wait)));
    return Date.now() >= job.readyAt ? send(res, 200, { status: "finished", result: job.result }) : send(res, 200, { status: "running" });
  }
  if (req.method === "GET" && p === "/agent/proposals") return send(res, 200, { proposals });
  if (m) {
    const target = proposals.find((x) => x.id === m[1]);
    if (!target) return send(res, 404, { error: "No such proposal.", code: "not_found" });
    if (m[2] === "approve") {
      if (body.payload_hash !== target.payloadHash) return send(res, 409, { error: "What you approved differs from the proposal.", code: "hash_mismatch" });
      target.status = "approved";
      return send(res, 200, { ok: true, token: "approval-token", expires_at: new Date(Date.now() + 900_000).toISOString() });
    }
    if (m[2] === "execute") {
      target.status = "executed";
      target.result = { ok: true, ref: "https://bsky.app/profile/claycorner.bsky.social/post/3kdemo", detail: "Posted at https://bsky.app/profile/claycorner.bsky.social/post/3kdemo" };
      return send(res, 200, { ok: true, proposal: target });
    }
    target.status = "rejected";
    return send(res, 200, { ok: true });
  }
  send(res, 404, { error: `no route for ${req.method} ${p}` });
}).listen(PORT, () => console.log(`mock app server on http://localhost:${PORT}`));
