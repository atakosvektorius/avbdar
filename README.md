# avbdar

**Server-side GA4 analytics on Cloudflare Workers with no Google scripts in the browser.**
A first-party HttpOnly cookie survives Safari ITP, and consent is checked on the server (GDPR / BDAR).

[Lietuviškai](README.lt.md)

```
Browser                         Your domain (Cloudflare)                       Google
───────                         ────────────────────────                       ──────
analytics.js ── POST /api/metrics ──► Worker
 (no gtag.js)                          ├─ consent cookie has "analytics"? no ─► 204, nothing stored or sent
                                       ├─ Set-Cookie: __av_cid (400 d, HttpOnly)
                                       ├─ Set-Cookie: __av_sid (30 min, HttpOnly)
                                       └─ waitUntil(fetch) ─────────────────────► GA4 /g/collect
                                                                                 (same endpoint as gtag.js,
                                                                                  _uip 0.0.0.0)
```

## Why

- **Safari ITP caps cookies set by JavaScript at 7 days** (24 hours when arriving via a decorated link such as `?gclid=`).
  `gtag.js` creates `_ga` with `document.cookie`, so a returning Safari visitor becomes a "new user" after a week.
  Proxying `gtag.js` through your domain (for example Google Tag Gateway) does **not** change this, because `_ga` is still written by JavaScript.
- A cookie set by the **server** in an HTTP `Set-Cookie` header, from the **same IP as the site**, is not subject to that cap.
  Making it `HttpOnly` also means no script can overwrite it, which would bring the 7-day cap back.
- No third-party script in the page: no blockable `googletagmanager.com` requests, a simpler CSP (`connect-src 'self'`), and less JavaScript.

## Features

- Consent is verified **server-side** from the CookieConsent cookie (`cc_cookie`). A client-sent `consent: true` is ignored.
  Without consent the Worker sets no cookie, sends nothing and returns `204`.
- `POST /api/metrics/forget` clears the HttpOnly cookies when consent is withdrawn. JavaScript cannot delete them.
- **Standard GA4 reports**, not Measurement Protocol: hits go to the same `/g/collect` endpoint `gtag.js` uses, so GA4 attributes sessions (source / medium / campaign from the referrer and UTM tags instead of "Unassigned") and counts new users, landing pages and engaged sessions.
  The Worker keeps the state `gtag.js` would keep in `_ga` / `_ga_*` in its HttpOnly cookies and sets the `first_visit` / `session_start` flags itself.
- Engagement like `gtag.js`: the client measures time only while the page is visible and sends `user_engagement` when the page is hidden or left.
  A session is engaged after 10 seconds, 2 page views or a key event (`KEY_EVENTS`).
- Privacy: the visitor's IP is not forwarded (`_uip=0.0.0.0`, so GA4 shows no location). `IP_MODE=truncated` forwards an IP with the last IPv4 octet / IPv6 bits after /48 zeroed, which keeps country and city.
  GA4 gets the `User-Agent` header (device, OS, browser), `Accept-Language` and the screen size.
- Input hardening:
  - only allowed events (`ALLOWED_EVENTS`); `session_start` and `first_visit` are always dropped, because GA4 derives them;
  - flat params only, at most 15 keys, values up to 100 characters;
  - `page_location` must be on your domain;
  - `Origin` / `Referer` check;
  - request body up to 4 KB.
- A lazy-loaded CookieConsent v2 banner (EN + LT) that is already wired to the analytics client.
- Removes leftover `_ga`, `_ga_*`, `_gid`, `_clck` and `_clsk` cookies after migrating from gtag.js or Microsoft Clarity.
- No dependencies. Tests run on plain Node.

## Layout

| Path | Purpose |
|---|---|
| `worker/worker_analytics.js` | Cloudflare Worker (ES module) |
| `worker/wrangler.jsonc.example` | Wrangler config template |
| `wrangler.jsonc` | Local demo config (`npx wrangler dev` from the repo root) |
| `.dev.vars.example` | Local secrets template |
| `public/avbdar/analytics.js` | Browser client (`window.avAnalytics`) |
| `public/avbdar/cookieconsent-loader.js` | Loads the consent banner on the first interaction |
| `public/avbdar/cookieconsent-config.js` | CookieConsent config wired to `avAnalytics` |
| `public/avbdar/cookieconsent.js`, `public/avbdar/cookieconsent.css` | CookieConsent v2.8.9 (MIT, Orest Bida) |
| `public/index.html` | Demo page |
| `test/worker.test.mjs` | Worker tests |

## Quick start

### 1. GA4

Note the measurement ID (`G-…`) of your web stream (**Admin → Data streams**). No API secret is needed.
To count leads, mark `generate_lead` as a key event (**Admin → Key events → New key event**) and register the parameters you send (for example `form`) as event-scoped custom dimensions.

### 2. Worker

```sh
cd worker
cp wrangler.jsonc.example wrangler.jsonc   # set DOMAIN, GA_MEASUREMENT_ID and the route
npx wrangler deploy
```

> **The route must be on the same host as your site** (`example.com/api/metrics*`), not `*.workers.dev` and not a subdomain.
> Safari 16.4+ also caps server-set cookies at 7 days when the responding server's IP does not match the site's.
> If another Worker already serves `example.com/api/*`, the more specific `/api/metrics*` route takes precedence for these paths.

### 3. Website

Copy `public/avbdar/` to your site as `/avbdar/` and add before `</body>`:

```html
<script defer src="/avbdar/analytics.js"></script>
<script defer src="/avbdar/cookieconsent-loader.js"></script>
```

Then remove every `gtag.js`, GTM, `dataLayer` and `gtag('consent', …)` snippet. Without `gtag.js` they serve no purpose.

Custom events:

```js
avAnalytics.trackEvent('generate_lead', { form: 'contact' });
```

The event name must be listed in the Worker's `ALLOWED_EVENTS`. `user_engagement` is always allowed.

### 4. Verify

- Locally: run `npx wrangler dev` from the repo root and open `http://localhost:8787/`.
  `GA_DEBUG` is already `true` in the demo config. Put your real `GA_MEASUREMENT_ID` in `.dev.vars` (copy `.dev.vars.example`) and the hits appear in GA4 **Admin → DebugView**; the terminal logs GA's response status.
  Use Chrome or Firefox for this; older Safari versions reject `Secure` cookies on `http://localhost`.
- In the browser DevTools Network tab you should see only `/api/metrics`, with `Set-Cookie: __av_cid` in the response, and no requests to `google*` domains.
- Without consent, `/api/metrics` must not return `Set-Cookie`, and nothing should appear in GA4 Realtime.
- With consent, GA4 Realtime should show the session's source (for example `google / organic` or your UTM tags), not "Unassigned".
- Long-term check in Safari: note the value of `__av_cid` and come back after 8 or more days. The value must be the same.
  Do not rely on the "Expires" column in Web Inspector, because ITP applies its cap separately.

## Configuration

### Worker (env)

| Variable | Default | |
|---|---|---|
| `DOMAIN` | — | **Required.** Allowed origin is `https://DOMAIN`. |
| `GA_MEASUREMENT_ID` | — | **Required.** `G-XXXXXXXXXX` |
| `GA_DEBUG` | `false` | `"true"` marks hits for GA4 DebugView and logs GA's response status. |
| `IP_MODE` | `none` | `none`: GA4 gets `0.0.0.0` (no location). `truncated`: IPv4 /24, IPv6 /48 (country and city kept). |
| `ALLOWED_ORIGINS` | — | Extra origins, comma-separated (local dev). |
| `ALLOWED_EVENTS` | `page_view,generate_lead,click_cta,file_download` | Event allowlist. `user_engagement` is always allowed. |
| `KEY_EVENTS` | `generate_lead` | Events that mark the session engaged. Also mark them as key events in GA4. |
| `METRICS_PATH` | `/api/metrics` | Base path. `/forget` is appended. |
| `CONSENT_COOKIE` | `cc_cookie` | Consent cookie name (CookieConsent v2 `level`, v3 `categories`). |
| `CONSENT_CATEGORY` | `analytics` | Category that must be granted. |
| `CLIENT_COOKIE` | `__av_cid` | Client ID and session count (400 days). |
| `SESSION_COOKIE` | `__av_sid` | Session ID, page views, engagement time and the engaged flag. |
| `SESSION_TIMEOUT` | `1800` | Session inactivity timeout in seconds. |

### Client (`<script>` data attributes on `analytics.js`)

| Attribute | Default | |
|---|---|---|
| `data-endpoint` | `/api/metrics` | Must match `METRICS_PATH`. |
| `data-consent-cookie` | `cc_cookie` | |
| `data-consent-category` | `analytics` | |
| `data-auto-pageview` | `true` | `"false"` turns off the automatic `page_view`. |
| `data-legacy-cookies` | `_ga,_ga_*,_gid,_clck,_clsk` | Erased on load. `""` turns the cleanup off. |

The loader resolves `cookieconsent.css`, `cookieconsent.js` and `cookieconsent-config.js` next to itself.
You can override them with `data-css`, `data-lib` and `data-config`.
In `cookieconsent-config.js`, set `PRIVACY_URL` and adapt the texts. The language follows `<html lang>`.

## Notes and limitations

- **Consent is still required.** Server-side collection does not remove the need for prior consent under the GDPR / ePrivacy rules (in Lithuania, Article 61 of the Law on Electronic Communications). Update your privacy policy: name the `__av_cid` and `__av_sid` cookies and describe the server-side transfer to Google.
- `/g/collect` is the endpoint `gtag.js`, server-side GTM and Cloudflare Zaraz use, but Google does not document it. avbdar 1.x used the documented Measurement Protocol instead, which is meant to supplement `gtag.js`: without it every session lands in "Unassigned" and new users, landing pages and engaged sessions stay empty.
- Cookies written by avbdar 1.x (bare client and session IDs) are read and continued, so upgrading does not reset visitors.
- No automatic enhanced measurement (scrolls, outbound clicks, file downloads). Send those events yourself with `trackEvent`.
- Bots that execute JavaScript and accept consent can still reach the endpoint. Add a rate-limiting rule for `/api/metrics` in Cloudflare WAF.
  If your WAF challenges some countries or ASNs, exempt `/api/metrics`, because a background `fetch` cannot solve a challenge.
- `HttpOnly` cookies can be removed only by the server (`/forget`) or by the user in the browser settings.

## Tests

```sh
npm test   # node test/worker.test.mjs, Node >= 20, no dependencies
```

## License

MIT © 2026 MB Atakos vektorius. CookieConsent © Orest Bida (MIT), see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
The Atakos vektorius name and logo (`public/logo.png`, used only by the demo page) are not covered by the MIT license.
