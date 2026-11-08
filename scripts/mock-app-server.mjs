/**
 * A stand-in for the server, for working on the app without a database or an AI key.
 * Answers the endpoints the app uses with realistic, fixed data, and keeps proposal state in
 * memory so approving and publishing can be tried end to end.
 *
 *   npm run mock:app        then point the app at http://localhost:4480 with any token
 */
import http from "node:http";

const PORT = Number(process.env.PORT ?? 4480);

const SITE = {
  "index.html": `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Clay Corner</title><link rel="stylesheet" href="style.css"></head>
<body><header><h1>Clay Corner</h1><p>Pottery for beginners, Saturdays at 10am.</p></header>
<main><h2>What you'll make</h2><p>A bowl and a mug in four weeks. All clay and firing included.</p>
<p><a href="about.html">About the studio</a></p></main></body></html>`,
  "about.html": `<!doctype html><html><head><meta charset="utf-8"><title>About</title><link rel="stylesheet" href="style.css"></head>
<body><h1>About the studio</h1><p>A small community studio on Main Street.</p><p><a href="index.html">Home</a></p></body></html>`,
  "style.css": `body{font-family:-apple-system,system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem;color:#3b3127;background:#faf6f0}
h1{color:#8a4b2a}header{border-bottom:2px solid #e3d5c3;margin-bottom:1rem}`,
};

const connections = [
  { id: "c-netlify", kind: "hosting", provider: "netlify", platform: null, label: "Netlify (you@example.com)", publishesTo: null },
  { id: "c-bsky", kind: "social", provider: "bluesky", platform: "bluesky", label: "Bluesky (@claycorner.bsky.social)", publishesTo: null },
];

let proposals = [];
let n = 0;

function proposal(kind, label, summary, payload, checks = []) {
  return {
    id: `p${++n}`, kind, label, summary, payload, payloadHash: `hash${n}`, checks, tainted: false,
    status: checks.some((c) => c.level === "block") ? "blocked" : "pending",
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(), result: null, canBeCarriedOut: true,
  };
}

function run() {
  const site = proposal("site.deploy", "Publish a website", "Publish the Clay Corner website", { connectionId: "c-netlify", siteId: "u-demo", contentHash: "a".repeat(64) });
  const post = proposal("social.post", "Publish a social post", "Announce the Saturday class on Bluesky", {
    connectionId: "c-bsky", text: "Beginner pottery starts this Saturday at 10am at Clay Corner. Four weeks, a bowl and a mug, all materials included.",
    link: "https://claycorner.example/", sponsored: false, mediaRefs: [],
  });
  proposals = [post, site, ...proposals];
  return {
    status: "done",
    text: "I built a two-page website for Clay Corner and wrote posts announcing the class. The website and the Bluesky post are waiting for your approval in Review; nothing has been published. The Instagram and X posts are for you to share yourself.",
    tainted: false,
    proposals: [post, site],
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
  if (req.method === "POST" && p === "/agent/run") {
    await new Promise((r) => setTimeout(r, 1200)); // feel like real work
    return send(res, 200, run());
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
      target.result = target.kind === "site.deploy"
        ? { ok: true, ref: "https://clay-corner.netlify.app", detail: "Published at https://clay-corner.netlify.app" }
        : { ok: true, ref: "https://bsky.app/profile/claycorner.bsky.social/post/3kdemo", detail: "Posted at https://bsky.app/profile/claycorner.bsky.social/post/3kdemo" };
      return send(res, 200, { ok: true, proposal: target });
    }
    target.status = "rejected";
    return send(res, 200, { ok: true });
  }
  if (req.method === "GET" && p === "/agent/site") {
    return send(res, 200, { files: Object.entries(SITE).map(([path, c]) => ({ path, bytes: Buffer.byteLength(c) })), checks: [], contentHash: "a".repeat(64) });
  }
  if (req.method === "GET" && p === "/agent/site/file") {
    const contents = SITE[url.searchParams.get("path") ?? ""];
    return contents ? send(res, 200, { contents }) : send(res, 404, { error: "No such file." });
  }
  send(res, 404, { error: `no route for ${req.method} ${p}` });
}).listen(PORT, () => console.log(`mock app server on http://localhost:${PORT}`));
