# Selling on marketplaces (plan)

Not built yet. This is the plan for letting Hera create listings and ads on sites like eBay,
in the same way she handles posts: she writes it, the person approves the exact listing in
Review, and only then is it published.

## eBay first

eBay has an official way for apps to list for a seller, so it's the place to start.

### What the person sees

"Sell my Canon AE-1 camera, works great, small scratch on the top, $180", with photos. Hera:

1. Writes a title (eBay allows 80 characters) and a description.
2. Picks the category and fills in the details it asks for (brand, model, condition and so on).
3. Suggests a price, and uses the shipping, payment and returns presets from their eBay account.
4. Checks it against eBay's rules: nothing eBay bans, no copied brand claims, an honest
   condition, and no outside contact details (eBay forbids them).
5. Puts it in Review. Once approved it goes live, and the person gets the link.

**Promoted Listings** (eBay's ads) can be added too. eBay charges only when the item sells, but
it is still spending, so the person types the ad rate to approve it, as amounts already work.

### Setup (the owner, about 30 minutes, free)

1. Create an eBay Developer Program account at developer.ebay.com and get the app's keys
   (a test set and a live set).
2. Set the eBay sign-in return address (the exact value comes with the build).
3. Add to Railway Variables, never anywhere else: `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`,
   `EBAY_RUNAME`, `EBAY_VERIFICATION_TOKEN`.
4. Each seller needs eBay's shipping, payment and returns presets (business policies) set up on
   their account, once. Hera walks them through it.

### The build

- **Connect eBay** in Accounts, through eBay's own sign-in page (like X and Facebook).
- **Account deletion notices:** eBay won't issue live keys until the app has an address that
  receives a notice when a user deletes their eBay account. Built on the server.
- **A listing tool for Hera:** category suggestions, each category's required details, price,
  condition, and the rule checks above.
- **Several photos per request** (up to 12; the app takes one today).
- **Publishing** after approval: create the listing on eBay and return its link.
- A listing card in the app, Promoted Listings with typed confirmation, and tests, tried on
  eBay's test site before going live.

**Cost:** eBay's API is free. Sellers pay eBay's normal listing and selling fees, and Promoted
Listings fees only if they choose them.

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
