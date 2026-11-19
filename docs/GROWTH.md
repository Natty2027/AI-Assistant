# Selling Hera

## Hera's home page

`https://<PUBLIC_URL>/` is Hera's home page: what Hera does, how it works, and a button to get it.
Use this address in your ads, social posts, email signature and App Store "Marketing URL".

- Before launch, set `TESTFLIGHT_URL` to your public TestFlight link
  (App Store Connect → TestFlight → External Testing → Public Link). The button says
  "Try Hera on TestFlight".
- After launch, set `APP_STORE_ID` to Hera's Apple ID (numbers only; App Store Connect → App
  Information). The button becomes "Download on the App Store", and Safari shows its banner that
  offers to open or install the app.
- With neither, it says "Coming soon to the App Store".

To use your own domain (hera.app or similar), add it as a custom domain in Railway and point
your domain's DNS at it.

## "Made with Hera"

- Posters on the free plan have a small "Made with Hera" in the corner.
- Websites published on the free plan end with "Built with Hera", linking to the home page (or
  the App Store once `APP_STORE_ID` is set). It's added when publishing, so the preview and what
  the person approved are unchanged.
- Hera Pro removes both. `BUILT_WITH_HERA=off` turns the website link off for everyone.

## Ratings

Apple's rating prompt appears right after something goes live, on the 3rd, 10th and 30th time,
once per app version (Apple shows it at most three times a year).

## Upgrade prompts

- On Create, once three quarters of the month's free requests are used (only while `BILLING=on`).
  Closing it hides it for the rest of the month.
- After something goes live on the free plan, a quiet line about Hera Pro.
- At the limit, the plan sheet opens by itself.

## Your growth dashboard

`https://<PUBLIC_URL>/admin/growth`: accounts, how many asked Hera, approved something, and
pay for Pro, plus this week's and this month's numbers. Counts only, no personal data.

Set `ADMIN_TOKEN` in Railway Variables (24+ random characters). The browser asks for a user name
(anything) and a password (the token). Downloads and App Store page views are in App Store
Connect → Analytics.

## Also worth doing (outside the app)

- App Store screenshots: a poster, a website, an eBay listing, Review. Plus a 15–30 second
  preview video.
- A free trial on Hera Pro (an introductory offer in App Store Connect).
- Apple Search Ads for "flyer maker", "small business marketing", "poster maker".
- Use Launch Kit to make Hera's own launch: the posts, the poster and the email.
