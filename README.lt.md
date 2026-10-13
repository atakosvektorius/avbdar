# avbdar

**Serverinė „Google Analytics 4“ analitika per „Cloudflare Workers“, be jokių „Google“ skriptų naršyklėje.**
Pirmosios šalies `HttpOnly` slapuko „Safari“ ITP nesutrumpina, o sutikimas tikrinamas serveryje (BDAR).

[English](README.md)

```
Naršyklė                        Jūsų domenas (Cloudflare)                       Google
────────                        ─────────────────────────                       ──────
analytics.js ── POST /api/metrics ──► Worker
 (be gtag.js)                          ├─ sutikimo slapuke nėra "analytics"? ─► 204, nieko nesaugoma ir nesiunčiama
                                       ├─ Set-Cookie: __av_cid (400 d., HttpOnly)
                                       ├─ Set-Cookie: __av_sid (30 min., HttpOnly)
                                       └─ waitUntil(fetch) ─────────────────────► GA4 Measurement Protocol
                                                                                 (ip_override 0.0.0.0,
                                                                                  user_location iš cf)
```

## Kam to reikia

- **„Safari“ ITP JavaScript sukurtų slapukų galiojimą riboja iki 7 dienų** (iki 24 val., jei atvykstama per dekoruotą nuorodą, pvz., `?gclid=`).
  `gtag.js` slapuką `_ga` kuria per `document.cookie`, todėl po savaitės sugrįžęs „Safari“ lankytojas tampa „nauju naudotoju“.
  `gtag.js` nukreipimas per savo domeną (pvz., „Google Tag Gateway“) šios ribos **nepanaikina**, nes `_ga` vis tiek rašo JavaScript.
- **Serverio** HTTP antrašte `Set-Cookie` nustatytam slapukui ši riba netaikoma, jei atsakymas ateina iš **to paties IP kaip svetainė**.
  Kadangi slapukas yra `HttpOnly`, jo neperrašys joks skriptas (toks perrašymas vėl įjungtų 7 dienų ribą).
- Puslapyje nėra trečiųjų šalių skriptų: nėra blokuojamų `googletagmanager.com` užklausų, CSP paprastesnė (`connect-src 'self'`), mažiau JavaScript.

## Galimybės

- Sutikimas tikrinamas **serveryje** pagal „CookieConsent“ slapuką (`cc_cookie`). Kliento siunčiamu `consent: true` nepasitikima.
  Be sutikimo Worker'is slapukų nenustato, nieko nesiunčia ir grąžina `204`.
- `POST /api/metrics/forget` atšaukus sutikimą ištrina `HttpOnly` slapukus, kurių JavaScript ištrinti negali.
- Sesijos: kiekviename įvykyje siunčiami `session_id` (iš `__av_sid`, 30 min. slenkantis langas) ir `engagement_time_msec`, todėl GA4 rodo sesijas ir aktyvius naudotojus.
- Privatumas: `ip_override: "0.0.0.0"`. Apytikslė `user_location` (šalis / regionas / miestas) imama iš „Cloudflare“ `request.cf`, o `device` (tipas, OS, naršyklė, kalba) – iš užklausos antraščių.
- Apsauga nuo šiukšlių:
  - leidžiami tik nurodyti įvykiai (`ALLOWED_EVENTS`), o Measurement Protocol rezervuoti vardai visada atmetami;
  - tik plokšti parametrai: iki 15 raktų, reikšmės iki 100 simbolių;
  - `page_location` turi būti jūsų domene;
  - tikrinamas `Origin` / `Referer`;
  - užklausos kūnas iki 4 KB.
- Tingiai įkeliamas „CookieConsent v2“ baneris (EN + LT), jau sujungtas su analitikos klientu.
- Po perėjimo nuo gtag.js ar „Microsoft Clarity“ ištrinami likę `_ga`, `_ga_*`, `_gid`, `_clck` ir `_clsk` slapukai.
- Jokių priklausomybių. Testai veikia su paprastu Node.

## Struktūra

| Kelias | Paskirtis |
|---|---|
| `worker/worker_analytics.js` | „Cloudflare Worker“ (ES modulis) |
| `worker/wrangler.jsonc.example` | „Wrangler“ konfigūracijos šablonas |
| `wrangler.jsonc` | Vietinio demo konfigūracija (`npx wrangler dev` iš šakninio katalogo) |
| `.dev.vars.example` | Vietinių paslapčių šablonas |
| `public/avbdar/analytics.js` | Naršyklės klientas (`window.avAnalytics`) |
| `public/avbdar/cookieconsent-loader.js` | Sutikimo banerį įkelia po pirmos sąveikos |
| `public/avbdar/cookieconsent-config.js` | „CookieConsent“ konfigūracija, sujungta su `avAnalytics` |
| `public/avbdar/cookieconsent.js`, `public/avbdar/cookieconsent.css` | „CookieConsent v2.8.9“ (MIT, Orest Bida) |
| `public/index.html` | Demonstracinis puslapis |
| `test/worker.test.mjs` | Worker'io testai |

## Greita pradžia

### 1. GA4

GA4 eikite į **Admin → Data streams → (web srautas) → Measurement Protocol API secrets → Create**.
Užsirašykite matavimo ID (`G-…`) ir slaptą raktą.

### 2. Worker

```sh
cd worker
cp wrangler.jsonc.example wrangler.jsonc   # nurodykite DOMAIN, GA_MEASUREMENT_ID ir route
npx wrangler secret put GA_API_SECRET
npx wrangler deploy
```

> **Route turi būti tame pačiame hoste kaip svetainė** (`example.com/api/metrics*`), ne `*.workers.dev` ir ne subdomene.
> „Safari 16.4+“ serverio nustatytus slapukus taip pat riboja iki 7 dienų, jei atsakančio serverio IP nesutampa su svetainės IP.
> Jei `example.com/api/*` jau aptarnauja kitas Worker'is, šiems keliams pirmenybę gauna konkretesnis `/api/metrics*` route.

### 3. Svetainė

Nukopijuokite `public/avbdar/` į svetainę kaip `/avbdar/` ir prieš `</body>` įdėkite:

```html
<script defer src="/avbdar/analytics.js"></script>
<script defer src="/avbdar/cookieconsent-loader.js"></script>
```

Tada pašalinkite visus `gtag.js`, GTM, `dataLayer` ir `gtag('consent', …)` fragmentus. Be `gtag.js` jie neturi prasmės.

Savi įvykiai:

```js
avAnalytics.trackEvent('generate_lead', { form: 'kontaktai' });
```

Įvykio vardas turi būti įrašytas Worker'io `ALLOWED_EVENTS` sąraše.

### 4. Patikra

- Vietoje: šakniniame kataloge paleiskite `npx wrangler dev` ir atidarykite `http://localhost:8787/`.
  Demo konfigūracijoje `GA_DEBUG` jau įjungtas (`true`). Įrašius `GA_API_SECRET` į `.dev.vars` (nukopijuokite `.dev.vars.example`), įvykiai siunčiami į `/debug/mp/collect`, o GA4 validacijos pranešimai rodomi terminale.
  Naudokite Chrome arba Firefox: senesnės „Safari“ versijos atmeta `Secure` slapukus `http://localhost` adresu.
- Naršyklės DevTools Network skiltyje turi matytis tik `/api/metrics` su `Set-Cookie: __av_cid` atsakyme, be jokių užklausų į `google*` domenus.
- Be sutikimo `/api/metrics` negrąžina `Set-Cookie`, o GA4 Realtime įvykis neatsiranda.
- Ilgalaikė patikra „Safari“: užsirašykite `__av_cid` reikšmę ir grįžkite po 8 ar daugiau dienų. Reikšmė turi likti ta pati.
  Web Inspector stulpeliu „Expires“ nepasitikėkite, nes ITP ribą taiko atskirai.

## Konfigūracija

### Worker (env)

| Kintamasis | Numatyta | |
|---|---|---|
| `DOMAIN` | — | **Privalomas.** Leidžiamas origin yra `https://DOMAIN`. |
| `GA_MEASUREMENT_ID` | — | **Privalomas.** `G-XXXXXXXXXX` |
| `GA_API_SECRET` | — | **Privalomas, kaip secret.** Be jo Worker'is grąžina `204`, bet nieko nepersiunčia. |
| `GA_DEBUG` | `false` | `"true"` siunčia į validacijos endpoint'ą ir išveda atsakymą į log'ą. |
| `ALLOWED_ORIGINS` | — | Papildomi origin, atskirti kableliais (vietinis kūrimas). |
| `ALLOWED_EVENTS` | `page_view,generate_lead,click_cta,file_download` | Leidžiamų įvykių sąrašas. |
| `METRICS_PATH` | `/api/metrics` | Bazinis kelias. Prie jo pridedamas `/forget`. |
| `CONSENT_COOKIE` | `cc_cookie` | Sutikimo slapukas („CookieConsent“ v2 `level`, v3 `categories`). |
| `CONSENT_CATEGORY` | `analytics` | Kategorija, kuriai turi būti duotas sutikimas. |
| `CLIENT_COOKIE` | `__av_cid` | Kliento ID slapukas (400 d.). |
| `SESSION_COOKIE` | `__av_sid` | Sesijos slapukas. |
| `SESSION_TIMEOUT` | `1800` | Sesijos neaktyvumo riba sekundėmis. |

### Klientas (`analytics.js` `<script>` data atributai)

| Atributas | Numatyta | |
|---|---|---|
| `data-endpoint` | `/api/metrics` | Turi sutapti su `METRICS_PATH`. |
| `data-consent-cookie` | `cc_cookie` | |
| `data-consent-category` | `analytics` | |
| `data-auto-pageview` | `true` | `"false"` išjungia automatinį `page_view`. |
| `data-legacy-cookies` | `_ga,_ga_*,_gid,_clck,_clsk` | Ištrinami užkrovus puslapį. `""` išjungia valymą. |

Loader'is `cookieconsent.css`, `cookieconsent.js` ir `cookieconsent-config.js` ieško tame pačiame kataloge, kuriame yra jis pats.
Juos galima pakeisti atributais `data-css`, `data-lib` ir `data-config`.
Faile `cookieconsent-config.js` nurodykite `PRIVACY_URL` ir pritaikykite tekstus. Kalba parenkama pagal `<html lang>`.

## Pastabos ir apribojimai

- **Sutikimo vis tiek reikia.** Serverinis duomenų rinkimas neatleidžia nuo išankstinio sutikimo pagal BDAR / ePrivacy (Lietuvoje – Elektroninių ryšių įstatymo 61 str.). Atnaujinkite privatumo politiką: nurodykite slapukus `__av_cid` ir `__av_sid` bei aprašykite serverinį duomenų perdavimą „Google“.
- Measurement Protocol pats sesijų nekuria, o `session_start` yra rezervuotas, todėl jis nesiunčiamas. GA4 sesijas skaičiuoja pagal `session_id`.
- Nėra automatinio „enhanced measurement“ (slinkimas, išeinantys paspaudimai, failų atsisiuntimai). Tokius įvykius siųskite patys per `trackEvent`.
- Botai, kurie vykdo JavaScript ir paspaudžia sutikimą, endpoint'ą vis tiek pasieks. „Cloudflare WAF“ sukurkite užklausų ribojimo (rate limit) taisyklę keliui `/api/metrics`.
  Jei WAF tikrina tam tikras šalis ar ASN, `/api/metrics` padarykite išimtį, nes fone siunčiamas `fetch` patikros (challenge) išspręsti negali.
- `HttpOnly` slapukus gali ištrinti tik serveris (`/forget`) arba pats naudotojas naršyklės nustatymuose.

## Testai

```sh
npm test   # node test/worker.test.mjs, Node >= 20, be priklausomybių
```

## Licencija

MIT © 2026 MB Atakos vektorius. „CookieConsent“ © Orest Bida (MIT), žr. [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
„Atakos vektorius“ pavadinimas ir logotipas (`public/logo.png`, naudojamas tik demo puslapyje) MIT licencija nepadengti.
