# Selling on marketplaces

## eBay (built)

Hera writes a fixed-price eBay listing, the person approves the exact listing in Review, and only
then does it go live on their own eBay account. Code: `server/agent/ebay.ts` (eBay's APIs),
`marketplace.listing` in `server/agent/policy.ts` (the rules), the selling tools in
`server/agent/loop.ts`, and Accounts → Selling and Review in the app.

### How it works for the person

"Sell my Canon AE-1, works great, small scratch on top, $180, ships from 95819", with a photo.
Hera finds the category (`ebay_categories`), the details it asks for (`ebay_item_specifics`), and
proposes the listing (`propose_listing`). Before it can be approved it's checked: no links,
emails, phone numbers or payment apps; a photo; a real price; likely banned items or copies of
brands need the person to confirm. The ZIP code must come from the person. Shipping, payment and
returns come from their eBay business policies, never from the model.

### Setup (the owner)

1. **eBay developer account** (free): developer.ebay.com → Join. Create a keyset; start with
   **Sandbox** to test, then **Production**.
2. **Sign-in return address**: in the keyset, User Tokens → Get a Token from eBay via Your
   Application → add an eBay Redirect URL. Set **Auth accepted URL** and **Auth declined URL** to
   `https://<PUBLIC_URL>/oauth/callback/ebay`, and turn on OAuth. The name eBay gives it is the
   **RuName**.
3. **Account deletion notices** (required before eBay issues Production keys): Alerts &
   Notifications → Marketplace Account Deletion. Endpoint:
   `https://<PUBLIC_URL>/notifications/ebay/deletion`. Verification token: any 32 to 80 letters,
   digits, `_` or `-` (make one up). Save, and eBay checks the address.
4. **Railway Variables** (never anywhere else):
   - `EBAY_CLIENT_ID` = App ID (Client ID)
   - `EBAY_CLIENT_SECRET` = Cert ID (Client Secret)
   - `EBAY_RUNAME` = the RuName from step 2
   - `EBAY_VERIFICATION_TOKEN` = the token from step 3
   - `EBAY_ENV` = `sandbox` while testing; remove it for real listings
5. **Database**: run `db/migrations/006_ebay_selling.sql` in Supabase (SQL editor) once.
6. `/health` shows `publishing.ebay: true` and `ebayDeletionNotices: true` when it's all set.

Each seller also needs eBay's **business policies** once: eBay.com → Account settings → Business
policies → opt in, then create a shipping, a payment and a returns policy. Accounts → Selling in
the app explains this.

### Not yet

- One photo per listing (the app sends one photo per request today; eBay allows up to 24).
- Promoted Listings (eBay ads, paid only when an item sells), with the person typing the ad rate.
- Checking the signature on eBay's deletion notices (today any notice for an eBay user id removes
  that connection; the worst case is the person reconnecting).
- Auctions; listings outside eBay US.

## Other sites

| Site | Can Hera post there? |
|---|---|
| eBay | Yes, through the official listing API. First choice. |
| Etsy | Yes, through Etsy's official API, after Etsy approves the app. $0.20 per listing. |
| Shopify | Yes, for businesses with a Shopify store. |
| Amazon | Possible, for Professional sellers only ($39.99/month), with a heavy developer sign-up. |
| Facebook Marketplace, Craigslist, Mercari, Poshmark, OfferUp | No public way for apps to post. Hera writes the listing in each site's style and the person pastes it in, as with LinkedIn today. |
| Google Ads, Facebook/Instagram ads | Possible later; each needs Google's or Meta's approval. |

Figures here are from memory and get checked against each site's current documentation before
building.
