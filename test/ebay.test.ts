/**
 * Selling on eBay, end to end against real SQL (PGlite), a fake eBay and a scripted model: sign in
 * on eBay, attach a photo, Hera finds the category and its details and proposes the listing, the
 * person approves, the listing goes live. Plus the rules a listing must pass, the seller presets
 * eBay requires, and eBay's account-deletion notices.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

process.env.MASTER_KEY = Buffer.alloc(32, 12).toString("base64");
const { makeDb, addUser } = await import("./helpers/db.ts");
const { AgentService } = await import("../server/agent/service.ts");
const { AGENT_MODEL } = await import("../server/agent/loop.ts");
const { challengeResponse, descriptionHtml, freshCredential, hosts } = await import("../server/agent/ebay.ts");
const { listingChecks } = await import("../server/agent/policy.ts");
import type { FetchLike } from "../server/shared.ts";

const U = "00000000-0000-0000-0000-0000000000e1";
const PUBLIC = "https://hera.example";
const EBAY = { clientId: "ebay-id", clientSecret: "ebay-secret" };
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).toString("base64");

let run: Awaited<ReturnType<typeof makeDb>>["run"];
let dir: string;
before(async () => {
  const ctx = await makeDb();
  run = ctx.run;
  await addUser(ctx.db, U);
  dir = await mkdtemp(path.join(tmpdir(), "hera-ebay-"));
});

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });

/** A fake eBay: sign-in, who-am-I, categories, item specifics, seller presets, and listing. */
function fakeEbay(opts: { policies?: boolean; publishError?: string } = {}) {
  const calls: Array<{ method: string; path: string; body: any; auth: string }> = [];
  const f: FetchLike = async (url, init) => {
    const u = new URL(String(url));
    const auth = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "");
    const body = init?.body && String(init.body).startsWith("{") ? JSON.parse(String(init.body)) : String(init?.body ?? "");
    calls.push({ method: init?.method ?? "GET", path: u.pathname, body, auth });
    if (u.pathname === "/identity/v1/oauth2/token") {
      assert.equal(auth, `Basic ${Buffer.from("ebay-id:ebay-secret").toString("base64")}`);
      const b = new URLSearchParams(String(init!.body));
      if (b.get("grant_type") === "client_credentials") return json({ access_token: "app-token", expires_in: 7200 });
      if (b.get("grant_type") === "authorization_code") {
        if (b.get("code") !== "good-code" || b.get("redirect_uri") !== "Hera-RuName") return json({ error: "invalid_grant" }, 400);
        return json({ access_token: "user-1", refresh_token: "refresh-1", expires_in: 7200, refresh_token_expires_in: 47304000 });
      }
      if (b.get("grant_type") === "refresh_token") return json({ access_token: "user-2", expires_in: 7200 });
    }
    if (u.pathname === "/commerce/identity/v1/user/") return json({ userId: "eb-123", username: "claycorner" });
    if (u.pathname.endsWith("/get_category_suggestions")) {
      assert.equal(auth, "Bearer app-token");
      return json({ categorySuggestions: [{ category: { categoryId: "15230", categoryName: "Film Cameras" }, categoryTreeNodeAncestors: [{ categoryName: "Cameras & Photo" }] }] });
    }
    if (u.pathname.endsWith("/get_item_aspects_for_category")) {
      return json({ aspects: [
        { localizedAspectName: "Type", aspectConstraint: { aspectRequired: false }, aspectValues: [{ localizedValue: "SLR" }] },
        { localizedAspectName: "Brand", aspectConstraint: { aspectRequired: true }, aspectValues: [{ localizedValue: "Canon" }] },
      ] });
    }
    if (u.pathname.startsWith("/sell/account/v1/")) {
      if (!opts.policies) return json({ errors: [{ message: "User is not eligible for Business Policy." }] }, 400);
      if (u.pathname.includes("fulfillment")) return json({ fulfillmentPolicies: [{ fulfillmentPolicyId: "ful-1" }] });
      if (u.pathname.includes("payment")) return json({ paymentPolicies: [{ paymentPolicyId: "pay-1" }] });
      if (u.pathname.includes("return")) return json({ returnPolicies: [{ returnPolicyId: "ret-1" }] });
    }
    if (u.pathname === "/sell/inventory/v1/location/hera-default") return new Response(null, { status: 204 });
    if (u.pathname.startsWith("/sell/inventory/v1/inventory_item/")) return new Response(null, { status: 204 });
    if (u.pathname === "/sell/inventory/v1/offer") return json({ offerId: "off-9" }, 201);
    if (u.pathname === "/sell/inventory/v1/offer/off-9/publish") {
      if (opts.publishError) return json({ errors: [{ message: opts.publishError }] }, 400);
      return json({ listingId: "110012345678" });
    }
    return json({}, 404);
  };
  return { f, calls };
}

const msg = (content: any[], stop_reason = "tool_use") =>
  ({ id: "m", type: "message", role: "assistant", model: AGENT_MODEL, content, stop_reason, usage: { input_tokens: 10, output_tokens: 10 } }) as any;
const use = (id: string, name: string, input: Record<string, unknown>) => ({ type: "tool_use", id, name, input });

const LISTING = {
  title: "Canon AE-1 35mm Film Camera Body, Tested", description: "Classic Canon AE-1, shutter and meter work.\n\nSmall scratch on the top plate.",
  category_id: "15230", category_name: "Film Cameras", condition: "USED_GOOD", condition_note: "Small scratch on the top plate",
  price: "180", quantity: 1, item_specifics: [{ name: "Brand", value: "Canon" }, { name: "Model", value: "AE-1" }],
  postal_code: "95819", summary: "Sell the Canon AE-1 for $180",
};

/** A scripted model: finds the category, its details, then proposes the listing. */
function seller(connectionId: () => string, overrides: Record<string, unknown> = {}) {
  const seen: any[] = [];
  let step = 0;
  const client = { beta: { messages: { create: async (params: any) => {
    seen.push(structuredClone(params));
    step++;
    if (step === 1) return msg([use("c1", "ebay_categories", { item: "Canon AE-1 film camera" })]);
    if (step === 2) return msg([use("c2", "ebay_item_specifics", { category_id: "15230" })]);
    if (step === 3) return msg([use("c3", "propose_listing", { connection_id: connectionId(), ...LISTING, ...overrides })]);
    return msg([{ type: "text", text: "Your listing is ready to review." }], "end_turn");
  } } } };
  return { client, seen };
}

function service(f: FetchLike, client: any = null) {
  return new AgentService({
    run, fetch: f, sitesDir: path.join(dir, "sites"), mediaDir: path.join(dir, "media"), client, sleep: async () => {},
    oauth: { publicUrl: PUBLIC, ebay: EBAY, ebayRuName: "Hera-RuName" },
  });
}

async function connectEbay(svc: InstanceType<typeof AgentService>) {
  const authUrl = new URL(svc.beginOAuth(U, "ebay"));
  const next = new URL(await svc.finishOAuth("ebay", new URLSearchParams({ state: authUrl.searchParams.get("state")!, code: "good-code" })));
  await svc.confirmOAuth(U, next.searchParams.get("pending"));
  return { authUrl, connection: (await svc.connections(U)).find((c) => c.provider === "ebay")! };
}

test("sign in with eBay: its own page, the RuName as the return address, saved as a marketplace connection", async () => {
  await run(`delete from action_connections where user_id = $1`, [U]);
  const svc = service(fakeEbay().f);
  assert.equal(svc.oauthAvailable().ebay, true);
  const { authUrl, connection } = await connectEbay(svc);
  assert.equal(authUrl.origin + authUrl.pathname, "https://auth.ebay.com/oauth2/authorize");
  assert.equal(authUrl.searchParams.get("redirect_uri"), "Hera-RuName");
  assert.match(authUrl.searchParams.get("scope")!, /sell\.inventory/);
  assert.equal(connection.kind, "marketplace");
  assert.equal(connection.label, "eBay (claycorner)");
});

test("Hera writes the listing, the person approves, and it goes live on eBay with the photo", async () => {
  await run(`delete from action_connections where user_id = $1`, [U]);
  const ebay = fakeEbay({ policies: true });
  let connId = "";
  const { client, seen } = seller(() => connId);
  const svc = service(ebay.f, client);
  connId = (await connectEbay(svc)).connection.id;
  const photoId = await svc.savePhoto(U, JPEG);

  const out = await svc.run(U, "Sell my Canon AE-1 for $180, small scratch on top, ships from 95819", { mode: "posts", photoId });
  assert.ok(seen[0].tools.some((t: any) => t.name === "propose_listing"), "selling tools are offered when eBay is set up");
  assert.match(seen[0].system, /eBay \(claycorner\)/, "Hera sees the connected eBay account");
  assert.match(seen[1].messages.at(-1).content[0].content, /Film Cameras/);
  assert.equal(ebay.calls.filter((c) => c.path.startsWith("/sell/inventory")).length, 0, "nothing is listed before approval");

  const p = out.proposals[0];
  assert.equal(p.kind, "marketplace.listing");
  assert.equal(p.payload.price, "180.00");
  assert.deepEqual(p.payload.policies, { fulfillment: "ful-1", payment: "pay-1", returns: "ret-1" });
  assert.deepEqual(p.payload.aspects, { Brand: ["Canon"], Model: ["AE-1"] });

  const { token } = svc.approve(U, p.id, { payloadHash: p.payloadHash });
  const done = await svc.execute(U, p.id, token);
  assert.equal(done.result?.ok, true);
  assert.equal(done.result?.ref, "https://www.ebay.com/itm/110012345678");

  const item = ebay.calls.find((c) => c.path.startsWith("/sell/inventory/v1/inventory_item/"))!;
  assert.deepEqual(item.body.product.imageUrls, [`${PUBLIC}/media/${photoId}.jpg`]);
  assert.equal(item.body.condition, "USED_GOOD");
  assert.match(item.body.product.description, /<p>Classic Canon AE-1/);
  const offer = ebay.calls.find((c) => c.path === "/sell/inventory/v1/offer")!;
  assert.equal(offer.body.format, "FIXED_PRICE");
  assert.equal(offer.body.listingDuration, "GTC");
  assert.deepEqual(offer.body.pricingSummary.price, { value: "180.00", currency: "USD" });
  assert.equal(offer.body.merchantLocationKey, "hera-default");
  const location = ebay.calls.find((c) => c.path === "/sell/inventory/v1/location/hera-default")!;
  assert.deepEqual(location.body.location.address, { postalCode: "95819", country: "US" });
});

test("without the seller's shipping, payment and returns presets, Hera explains how to set them up", async () => {
  await run(`delete from action_connections where user_id = $1`, [U]);
  let connId = "";
  const { client, seen } = seller(() => connId);
  const svc = service(fakeEbay({ policies: false }).f, client);
  connId = (await connectEbay(svc)).connection.id;
  const out = await svc.run(U, "Sell my Canon AE-1 for $180 from 95819", { mode: "posts", photoId: await svc.savePhoto(U, JPEG) });
  assert.equal(out.proposals.length, 0);
  const result = seen[3].messages.at(-1).content[0];
  assert.equal(result.is_error, true);
  assert.match(result.content, /Business policies/);
});

test("the ZIP code must come from the person", async () => {
  await run(`delete from action_connections where user_id = $1`, [U]);
  let connId = "";
  const { client, seen } = seller(() => connId);
  const svc = service(fakeEbay({ policies: true }).f, client);
  connId = (await connectEbay(svc)).connection.id;
  const out = await svc.run(U, "Sell my Canon AE-1 for $180", { mode: "posts", photoId: await svc.savePhoto(U, JPEG) });
  assert.equal(out.proposals.length, 0);
  assert.match(seen[3].messages.at(-1).content[0].content, /ZIP code/);
});

test("eBay's reason for refusing a listing reaches the person", async () => {
  await run(`delete from action_connections where user_id = $1`, [U]);
  let connId = "";
  const { client } = seller(() => connId);
  const svc = service(fakeEbay({ policies: true, publishError: "The item condition is invalid for this category." }).f, client);
  connId = (await connectEbay(svc)).connection.id;
  const out = await svc.run(U, "Sell my Canon AE-1 for $180 from 95819", { mode: "posts", photoId: await svc.savePhoto(U, JPEG) });
  const p = out.proposals[0];
  const { token } = svc.approve(U, p.id, { payloadHash: p.payloadHash });
  const done = await svc.execute(U, p.id, token);
  assert.equal(done.result?.ok, false);
  assert.match(done.result!.detail, /condition is invalid/);
});

test("selling tools aren't offered when eBay isn't set up", async () => {
  const seen: any[] = [];
  const client = { beta: { messages: { create: async (p: any) => { seen.push(p); return msg([{ type: "text", text: "ok" }], "end_turn"); } } } };
  const svc = new AgentService({ run, fetch: fakeEbay().f, sitesDir: path.join(dir, "sites"), mediaDir: path.join(dir, "media"), client });
  await svc.run(U, "hi", { mode: "posts" });
  assert.ok(!seen[0].tools.some((t: any) => t.name.startsWith("ebay_") || t.name === "propose_listing"));
  assert.equal(svc.oauthAvailable().ebay, false);
});

/* ---------------- the rules ---------------- */

const listing = (over: Record<string, unknown> = {}) => ({
  connectionId: "eb", sku: "hera-0123456789abcdef", title: "Canon AE-1 35mm Film Camera", description: "Works well.",
  categoryId: "15230", categoryName: "Film Cameras", condition: "USED_GOOD" as const, conditionNote: "Light wear",
  price: "180.00", quantity: 1, aspects: { Brand: ["Canon"] }, mediaRefs: ["u-1-2"], postalCode: "95819",
  policies: { fulfillment: "f", payment: "p", returns: "r" }, ...over,
}) as any;
const ids = (checks: Array<{ id: string; level: string }>) => checks.map((c) => `${c.id}:${c.level}`);

test("a clean listing passes", () => {
  assert.deepEqual(listingChecks(listing()), []);
});

test("links, emails, phone numbers and payment apps are refused; years and model numbers aren't phone numbers", () => {
  assert.ok(ids(listingChecks(listing({ description: "Questions? Text me at (916) 555-0134" }))).includes("contact_details:block"));
  assert.ok(ids(listingChecks(listing({ description: "Pay with Venmo for a discount" }))).includes("contact_details:block"));
  assert.ok(ids(listingChecks(listing({ description: "More photos at www.mysite.com" }))).includes("contact_details:block"));
  assert.deepEqual(listingChecks(listing({ description: "Made 1976-1984. Model 4200-77." })), []);
});

test("likely banned items and copies ask for confirmation; a listing needs a photo and a real price", () => {
  assert.ok(ids(listingChecks(listing({ title: "Set of 4 wine glasses" }))).includes("prohibited_item:attest"));
  assert.ok(ids(listingChecks(listing({ title: "Replica designer watch" }))).includes("knockoff:attest"));
  assert.ok(ids(listingChecks(listing({ mediaRefs: [] }))).includes("needs_photo:block"));
  assert.ok(ids(listingChecks(listing({ price: "0.50" }))).includes("price:block"));
  assert.ok(ids(listingChecks(listing({ price: "30000.00" }))).includes("high_price:attest"));
  assert.ok(ids(listingChecks(listing({ conditionNote: null }))).includes("condition_note:warn"));
});

test("descriptions are escaped into simple HTML", () => {
  assert.equal(descriptionHtml("A <b> & \"C\"\nline two\n\nNext"), "<p>A &lt;b&gt; &amp; &quot;C&quot;<br>line two</p><p>Next</p>");
});

/* ---------------- tokens and deletion notices ---------------- */

test("an access token about to expire is refreshed; an expired sign-in asks to reconnect", async () => {
  const h = hosts(false);
  const cred = { accessToken: "user-1", refreshToken: "refresh-1", expiresAt: 1000, refreshExpiresAt: 10_000_000, userId: "eb-1", username: "x" };
  const fresh = await freshCredential(EBAY, cred, fakeEbay().f, h, 900);
  assert.equal(fresh.accessToken, "user-2");
  await assert.rejects(freshCredential(EBAY, { ...cred, refreshExpiresAt: 500 }, fakeEbay().f, h, 900), { kind: "unauthorized" });
});

test("the deletion-notice challenge is answered the way eBay checks it", () => {
  const expected = createHash("sha256").update("abc" + "token-token-token-token-token-token" + "https://hera.example/notifications/ebay/deletion").digest("hex");
  assert.equal(challengeResponse("abc", "token-token-token-token-token-token", "https://hera.example/notifications/ebay/deletion"), expected);
});

test("when someone deletes their eBay account, their connection goes", async () => {
  await run(`delete from action_connections where user_id = $1`, [U]);
  const svc = service(fakeEbay().f);
  await connectEbay(svc);
  await svc.ebayAccountDeleted("eb-123");
  assert.equal((await svc.connections(U)).filter((c) => c.provider === "ebay").length, 0);
});
