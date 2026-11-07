/**
 * Zero-dependency mock backend for local extension testing. Implements exactly the endpoints
 * src/sw.ts calls, with CORS + credentials so the extension service worker can reach it.
 *
 *   npm run mock          # starts http://localhost:4000
 *
 * Pair with `npm run build:mock`, which builds dist/chrome pointed at this server. Then load
 * dist/chrome unpacked and watch the service-worker console (chrome://extensions → the
 * extension → "service worker"). Stop this server to exercise sw.ts's offline fail-quiet
 * fallback: the resolver should stay quiet, never go loud.
 */
import { createServer } from "node:http";

const PORT = 4000;

// One event active *right now*, so GET /events/active drives the resolver to "silent".
function activeEvents() {
  const now = Date.now();
  return [
    {
      title: "Systems lecture",
      category: "class",
      busy: true,
      start: new Date(now - 10 * 60_000).toISOString(),
      end: new Date(now + 40 * 60_000).toISOString(),
    },
  ];
}

const routes = [
  ["GET", "/events/active", () => activeEvents()],
  ["POST", "/settings/automation", (body) => ({ ok: true, enabled: !!body?.enabled })],
  ["POST", "/disclosures", () => ({ ok: true })],
  ["GET", "/oauth/start", (_body, url) => ({ authUrl: `${url.searchParams.get("redirect")}?code=mock` })],
  ["POST", "/oauth/complete", () => ({ ok: true })],
  ["POST", "/capture", (body) => ({
    proposals: [
      {
        title: body?.kind === "image" ? "Event from image" : (body?.text?.slice(0, 40) || "Captured event"),
        start: new Date(Date.now() + 3_600_000).toISOString(),
        end: new Date(Date.now() + 5_400_000).toISOString(),
        needs_review: ["start_time"],
      },
    ],
  })],
];

function setCors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Vary", "Origin");
}

createServer((req, res) => {
  setCors(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const route = routes.find(([m, p]) => m === req.method && p === url.pathname);

  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    let body = null;
    if (chunks.length) {
      try {
        body = JSON.parse(Buffer.concat(chunks).toString());
      } catch {
        body = null;
      }
    }
    if (!route) {
      console.log(`${req.method} ${url.pathname} -> 404`);
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `no mock for ${req.method} ${url.pathname}` }));
      return;
    }
    const payload = route[2](body, url);
    console.log(`${req.method} ${url.pathname} -> 200`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  });
}).listen(PORT, () => console.log(`mock backend on http://localhost:${PORT}`));
