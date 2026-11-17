/**
 * Listing items for sale on the person's own eBay account, through eBay's official APIs.
 *
 *   sign-in     https://auth.ebay.com/oauth2/authorize  ->  POST /identity/v1/oauth2/token
 *   who         GET  apiz.ebay.com/commerce/identity/v1/user/
 *   categories  GET  /commerce/taxonomy/v1/category_tree/0/get_category_suggestions   (app token)
 *   specifics   GET  /commerce/taxonomy/v1/category_tree/0/get_item_aspects_for_category
 *   policies    GET  /sell/account/v1/{fulfillment,payment,return}_policy
 *   listing     POST /sell/inventory/v1/location/{key}       (once: where items ship from)
 *               PUT  /sell/inventory/v1/inventory_item/{sku}  (the item: title, condition, photos)
 *               POST /sell/inventory/v1/offer                 (price, category, policies)
 *               POST /sell/inventory/v1/offer/{id}/publish    (goes live: returns the listing id)
 *
 * The person signs in on ebay.com; this server never sees their password, only tokens for the
 * scopes below, stored encrypted. Access tokens last two hours and are refreshed with the refresh
 * token (which eBay doesn't replace). eBay requires the seller's shipping, payment and returns
 * presets ("business policies") for listings made through the API; their ids come from the
 * seller's account, never from the model. Errors carry a status and a kind, never a body.
 */
import { createHash, randomBytes } from "node:crypto";
import { ProviderError, type FetchLike } from "../shared.ts";
import type { OAuthClient } from "../config.ts";

const TIMEOUT_MS = 20_000;
export const MARKETPLACE_ID = "EBAY_US";
/** Where items ship from, made once per seller from the ZIP code they give. */
export const LOCATION_KEY = "hera-default";

export const EBAY_SCOPES = [
  "https://api.ebay.com/oauth/api_scope",
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.account",
  "https://api.ebay.com/oauth/api_scope/commerce.identity.readonly",
];

/** eBay's item conditions. Which ones a category accepts varies; eBay has the final say. */
export const CONDITIONS = [
  "NEW", "LIKE_NEW", "NEW_OTHER", "NEW_WITH_DEFECTS", "CERTIFIED_REFURBISHED", "SELLER_REFURBISHED",
  "USED_EXCELLENT", "USED_VERY_GOOD", "USED_GOOD", "USED_ACCEPTABLE", "FOR_PARTS_OR_NOT_WORKING",
] as const;
export type Condition = (typeof CONDITIONS)[number];

export interface EbayHosts { auth: string; api: string; apiz: string; web: string }

/** EBAY_ENV=sandbox points everything at eBay's test site, where nothing is really sold. */
export function hosts(sandbox: boolean): EbayHosts {
  return sandbox
    ? { auth: "https://auth.sandbox.ebay.com", api: "https://api.sandbox.ebay.com", apiz: "https://apiz.sandbox.ebay.com", web: "https://www.sandbox.ebay.com" }
    : { auth: "https://auth.ebay.com", api: "https://api.ebay.com", apiz: "https://apiz.ebay.com", web: "https://www.ebay.com" };
}

export interface EbayCredential {
  accessToken: string; refreshToken: string; expiresAt: number; refreshExpiresAt: number;
  userId: string; username: string;
}

/** eBay's sign-in page. `ruName` is the app's "RuName" from the eBay developer portal, which eBay
 *  maps to this server's callback address; it goes where other platforms take a redirect URL. */
export function authorizeUrl(client: OAuthClient, ruName: string, state: string, h: EbayHosts): string {
  const q = new URLSearchParams({ client_id: client.clientId, redirect_uri: ruName, response_type: "code", scope: EBAY_SCOPES.join(" "), state });
  return `${h.auth}/oauth2/authorize?${q}`;
}

function classify(status: number): ProviderError {
  if (status === 401) return new ProviderError("unauthorized", `eBay refused access (${status})`, status);
  if (status === 429) return new ProviderError("unavailable", "eBay's limit for now was reached; try again later", status);
  if (status >= 400 && status < 500) return new ProviderError("rejected", `eBay didn't accept the request (${status})`, status);
  return new ProviderError("unavailable", `eBay is unavailable (${status})`, status);
}

/** eBay explains a refused listing in `errors[].message` ("The item condition is invalid for this
 *  category"). That text is about the listing, not the request, so it's safe and useful to show. */
async function call(f: FetchLike, url: string, init: RequestInit): Promise<any> {
  let res: Response;
  try {
    res = await f(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new ProviderError("unavailable", "Could not reach eBay");
  }
  if (res.status === 204) return {};
  if (!res.ok) {
    const err = classify(res.status);
    if (res.status === 400 || res.status === 409) {
      const body = await res.json().catch(() => null) as { errors?: Array<{ message?: string }> } | null;
      const why = body?.errors?.map((e) => e.message).filter(Boolean).slice(0, 2).join(" ");
      if (why) return Promise.reject(new ProviderError("rejected", `eBay: ${why.slice(0, 300)}`, res.status));
    }
    throw err;
  }
  return res.json().catch(() => ({}));
}

async function token(client: OAuthClient, body: Record<string, string>, f: FetchLike, h: EbayHosts): Promise<any> {
  const basic = Buffer.from(`${client.clientId}:${client.clientSecret}`).toString("base64");
  return call(f, `${h.api}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
}

/** Trades the sign-in code for tokens, and finds out whose account it is. */
export async function exchangeCode(client: OAuthClient, code: string, ruName: string, f: FetchLike, h: EbayHosts, now = Date.now()): Promise<EbayCredential> {
  const out = await token(client, { grant_type: "authorization_code", code, redirect_uri: ruName }, f, h);
  if (typeof out.access_token !== "string" || typeof out.refresh_token !== "string") throw new ProviderError("unavailable", "eBay didn't return a sign-in");
  const me = await call(f, `${h.apiz}/commerce/identity/v1/user/`, { headers: { Authorization: `Bearer ${out.access_token}` } });
  if (typeof me.userId !== "string") throw new ProviderError("unavailable", "eBay didn't say whose account this is");
  return {
    accessToken: out.access_token, refreshToken: out.refresh_token,
    expiresAt: now + Number(out.expires_in ?? 7200) * 1000,
    refreshExpiresAt: now + Number(out.refresh_token_expires_in ?? 47_304_000) * 1000,
    userId: me.userId, username: typeof me.username === "string" ? me.username : "eBay seller",
  };
}

/** The same credential if its access token has five minutes left, otherwise a refreshed one. */
export async function freshCredential(client: OAuthClient, cred: EbayCredential, f: FetchLike, h: EbayHosts, now = Date.now()): Promise<EbayCredential> {
  if (cred.expiresAt - now > 5 * 60_000) return cred;
  if (cred.refreshExpiresAt <= now) throw new ProviderError("unauthorized", "The eBay sign-in has expired");
  const out = await token(client, { grant_type: "refresh_token", refresh_token: cred.refreshToken, scope: EBAY_SCOPES.join(" ") }, f, h);
  if (typeof out.access_token !== "string") throw new ProviderError("unavailable", "eBay didn't refresh the sign-in");
  return { ...cred, accessToken: out.access_token, expiresAt: now + Number(out.expires_in ?? 7200) * 1000 };
}

/** An application token (no person), for eBay's public category data. Kept until near expiry. */
export class AppTokens {
  private cached: { token: string; expiresAt: number } | null = null;
  constructor(private readonly client: OAuthClient, private readonly f: FetchLike, private readonly h: EbayHosts, private readonly clock = () => Date.now()) {}

  async get(): Promise<string> {
    if (this.cached && this.cached.expiresAt - this.clock() > 60_000) return this.cached.token;
    const out = await token(this.client, { grant_type: "client_credentials", scope: EBAY_SCOPES[0] }, this.f, this.h);
    if (typeof out.access_token !== "string") throw new ProviderError("unavailable", "eBay didn't return an app token");
    this.cached = { token: out.access_token, expiresAt: this.clock() + Number(out.expires_in ?? 7200) * 1000 };
    return this.cached.token;
  }
}

export interface CategorySuggestion { id: string; name: string; path: string }

/** eBay's best categories for what the item is, e.g. "Canon AE-1 film camera". */
export async function suggestCategories(appToken: string, query: string, f: FetchLike, h: EbayHosts): Promise<CategorySuggestion[]> {
  const q = new URLSearchParams({ q: query.slice(0, 350) });
  const out = await call(f, `${h.api}/commerce/taxonomy/v1/category_tree/0/get_category_suggestions?${q}`, {
    headers: { Authorization: `Bearer ${appToken}`, "Accept-Language": "en-US" },
  });
  return ((out.categorySuggestions ?? []) as any[]).slice(0, 6).map((s) => ({
    id: String(s.category?.categoryId ?? ""), name: String(s.category?.categoryName ?? ""),
    path: [...((s.categoryTreeNodeAncestors ?? []) as any[]).map((a) => String(a.categoryName ?? "")).reverse(), String(s.category?.categoryName ?? "")].filter(Boolean).join(" > "),
  })).filter((s) => /^\d+$/.test(s.id));
}

export interface ItemSpecific { name: string; required: boolean; values: string[] }

/** The details a category asks for (Brand, Model, Size…), required ones first. */
export async function itemSpecifics(appToken: string, categoryId: string, f: FetchLike, h: EbayHosts): Promise<ItemSpecific[]> {
  if (!/^\d{1,12}$/.test(categoryId)) throw new ProviderError("rejected", "That isn't an eBay category id");
  const out = await call(f, `${h.api}/commerce/taxonomy/v1/category_tree/0/get_item_aspects_for_category?category_id=${categoryId}`, {
    headers: { Authorization: `Bearer ${appToken}`, "Accept-Language": "en-US" },
  });
  return ((out.aspects ?? []) as any[])
    .map((a) => ({
      name: String(a.localizedAspectName ?? ""),
      required: a.aspectConstraint?.aspectRequired === true,
      values: ((a.aspectValues ?? []) as any[]).slice(0, 12).map((v) => String(v.localizedValue ?? "")).filter(Boolean),
    }))
    .filter((a) => a.name)
    .sort((a, b) => Number(b.required) - Number(a.required))
    .slice(0, 25);
}

export interface SellerPolicies { fulfillment: string | null; payment: string | null; returns: string | null }

/** The seller's shipping, payment and returns presets: the first of each (eBay lists the default
 *  first). Missing ones mean the seller hasn't set them up in eBay yet. */
export async function sellerPolicies(cred: EbayCredential, f: FetchLike, h: EbayHosts): Promise<SellerPolicies> {
  const get = (kind: string) => call(f, `${h.api}/sell/account/v1/${kind}_policy?marketplace_id=${MARKETPLACE_ID}`, {
    headers: { Authorization: `Bearer ${cred.accessToken}` },
  }).catch((e) => {
    // Not opted in to business policies yet: eBay answers 400. That's "none", not a failure.
    if (e instanceof ProviderError && e.kind === "rejected") return {};
    throw e;
  });
  const [ful, pay, ret] = await Promise.all([get("fulfillment"), get("payment"), get("return")]);
  return {
    fulfillment: ful.fulfillmentPolicies?.[0]?.fulfillmentPolicyId ?? null,
    payment: pay.paymentPolicies?.[0]?.paymentPolicyId ?? null,
    returns: ret.returnPolicies?.[0]?.returnPolicyId ?? null,
  };
}

export interface Listing {
  sku: string; title: string; description: string; categoryId: string; condition: Condition;
  conditionNote: string | null; price: string; quantity: number; aspects: Record<string, string[]>;
  imageUrls: string[]; postalCode: string;
  policies: { fulfillment: string; payment: string; returns: string };
}

/** Plain text to the simple HTML eBay shows: escaped, with paragraphs and line breaks kept. */
export function descriptionHtml(text: string): string {
  const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return esc.split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`).join("");
}

/** Makes the listing live. Returns the listing's address on eBay. */
export async function publishListing(cred: EbayCredential, l: Listing, f: FetchLike, h: EbayHosts): Promise<{ listingId: string; url: string }> {
  const auth = { Authorization: `Bearer ${cred.accessToken}` };
  const json = { ...auth, "Content-Type": "application/json", "Content-Language": "en-US" };
  const inv = `${h.api}/sell/inventory/v1`;

  // Where items ship from: made once; eBay answers 409 if it already exists.
  try {
    await call(f, `${inv}/location/${LOCATION_KEY}`, {
      method: "POST", headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ location: { address: { postalCode: l.postalCode, country: "US" } }, locationTypes: ["WAREHOUSE"], name: "Ships from", merchantLocationStatus: "ENABLED" }),
    });
  } catch (e) {
    if (!(e instanceof ProviderError && e.status === 409)) throw e;
  }

  await call(f, `${inv}/inventory_item/${encodeURIComponent(l.sku)}`, {
    method: "PUT", headers: json,
    body: JSON.stringify({
      availability: { shipToLocationAvailability: { quantity: l.quantity } },
      condition: l.condition,
      ...(l.conditionNote ? { conditionDescription: l.conditionNote } : {}),
      product: { title: l.title, description: descriptionHtml(l.description), aspects: l.aspects, imageUrls: l.imageUrls },
    }),
  });

  const offer = await call(f, `${inv}/offer`, {
    method: "POST", headers: json,
    body: JSON.stringify({
      sku: l.sku, marketplaceId: MARKETPLACE_ID, format: "FIXED_PRICE", listingDuration: "GTC",
      availableQuantity: l.quantity, categoryId: l.categoryId, listingDescription: descriptionHtml(l.description),
      listingPolicies: { fulfillmentPolicyId: l.policies.fulfillment, paymentPolicyId: l.policies.payment, returnPolicyId: l.policies.returns },
      pricingSummary: { price: { value: l.price, currency: "USD" } },
      merchantLocationKey: LOCATION_KEY,
    }),
  });
  if (typeof offer.offerId !== "string") throw new ProviderError("unavailable", "eBay didn't create the offer");

  const out = await call(f, `${inv}/offer/${encodeURIComponent(offer.offerId)}/publish`, { method: "POST", headers: json, body: "{}" });
  if (typeof out.listingId !== "string") throw new ProviderError("unavailable", "eBay didn't publish the listing");
  return { listingId: out.listingId, url: `${h.web}/itm/${out.listingId}` };
}

/** A fresh SKU for each listing, so a new listing never overwrites an old one. */
export function newSku(): string {
  return `hera-${randomBytes(8).toString("hex")}`;
}

/** eBay's check that this server owns the deletion-notice address: SHA-256 of the challenge code,
 *  the verification token and the address, in that order, as hex. */
export function challengeResponse(challengeCode: string, verificationToken: string, endpoint: string): string {
  return createHash("sha256").update(challengeCode).update(verificationToken).update(endpoint).digest("hex");
}
