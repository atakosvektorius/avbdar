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
                                       └─ waitUntil(fetch) ─────────────────────► GA4 /g/collect
                                                                                 (tas pats adresas kaip gtag.js,
                                                                                  _uip 0.0.0.0)
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
- **Įprastos GA4 ataskaitos**, ne Measurement Protocol: įvykiai siunčiami į tą patį `/g/collect` adresą kaip `gtag.js`, todėl GA4 priskiria sesijų šaltinį (šaltinis / kanalas / kampanija pagal referrer ir UTM žymas, o ne „Unassigned“) ir skaičiuoja naujus naudotojus, nukreipimo puslapius bei įsitraukusias sesijas.
  Būseną, kurią `gtag.js` laiko `_ga` / `_ga_*` slapukuose, Worker'is laiko savo `HttpOnly` slapukuose ir pats nustato `first_visit` / `session_start` žymas.
- Įsitraukimas kaip `gtag.js`: klientas skaičiuoja laiką tik kol puslapis matomas ir siunčia `user_engagement`, kai puslapis paslepiamas ar paliekamas.
  Sesija laikoma įsitraukusia po 10 sekundžių, 2 peržiūrų arba pagrindinio įvykio (`KEY_EVENTS`).
- Privatumas: lankytojo IP neperduodamas (`_uip=0.0.0.0`, todėl GA4 vietos nerodo). `IP_MODE=truncated` perduoda IP su išvalytu paskutiniu IPv4 oktetu / IPv6 bitais po /48, todėl šalis ir miestas išlieka.
  GA4 gauna `User-Agent` antraštę (įrenginys, OS, naršyklė), `Accept-Language` ir ekrano dydį.
- Apsauga nuo šiukšlių:
  - leidžiami tik nurodyti įvykiai (`ALLOWED_EVENTS`); `session_start` ir `first_visit` visada atmetami, nes juos sukuria GA4;
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

Užsirašykite web srauto matavimo ID (`G-…`, **Admin → Data streams**). API rakto nereikia.
Kad būtų skaičiuojamos užklausos, pažymėkite `generate_lead` kaip pagrindinį įvykį (**Admin → Key events → New key event**), o siunčiamus parametrus (pvz., `form`) užregistruokite kaip event-scoped custom dimensions.

### 2. Worker

```sh
cd worker
cp wrangler.jsonc.example wrangler.jsonc   # nurodykite DOMAIN, GA_MEASUREMENT_ID ir route
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

Įvykio vardas turi būti įrašytas Worker'io `ALLOWED_EVENTS` sąraše. `user_engagement` leidžiamas visada.

### 4. Patikra

- Vietoje: šakniniame kataloge paleiskite `npx wrangler dev` ir atidarykite `http://localhost:8787/`.
  Demo konfigūracijoje `GA_DEBUG` jau įjungtas (`true`). Įrašius tikrą `GA_MEASUREMENT_ID` į `.dev.vars` (nukopijuokite `.dev.vars.example`), įvykiai matosi GA4 **Admin → DebugView**, o terminale rodomas GA atsakymo statusas.
  Naudokite Chrome arba Firefox: senesnės „Safari“ versijos atmeta `Secure` slapukus `http://localhost` adresu.
- Naršyklės DevTools Network skiltyje turi matytis tik `/api/metrics` su `Set-Cookie: __av_cid` atsakyme, be jokių užklausų į `google*` domenus.
- Be sutikimo `/api/metrics` negrąžina `Set-Cookie`, o GA4 Realtime įvykis neatsiranda.
- Su sutikimu GA4 Realtime turi rodyti sesijos šaltinį (pvz., `google / organic` arba jūsų UTM žymas), o ne „Unassigned“.
- Ilgalaikė patikra „Safari“: užsirašykite `__av_cid` reikšmę ir grįžkite po 8 ar daugiau dienų. Reikšmė turi likti ta pati.
  Web Inspector stulpeliu „Expires“ nepasitikėkite, nes ITP ribą taiko atskirai.

## Konfigūracija

### Worker (env)

| Kintamasis | Numatyta | |
|---|---|---|
| `DOMAIN` | — | **Privalomas.** Leidžiamas origin yra `https://DOMAIN`. |
| `GA_MEASUREMENT_ID` | — | **Privalomas.** `G-XXXXXXXXXX` |
| `GA_DEBUG` | `false` | `"true"` pažymi įvykius GA4 DebugView ir išveda GA atsakymo statusą į log'ą. |
| `IP_MODE` | `none` | `none`: GA4 gauna `0.0.0.0` (vieta nenustatoma). `truncated`: IPv4 /24, IPv6 /48 (šalis ir miestas išlieka). |
| `ALLOWED_ORIGINS` | — | Papildomi origin, atskirti kableliais (vietinis kūrimas). |
| `ALLOWED_EVENTS` | `page_view,generate_lead,click_cta,file_download` | Leidžiamų įvykių sąrašas. `user_engagement` leidžiamas visada. |
| `KEY_EVENTS` | `generate_lead` | Įvykiai, po kurių sesija laikoma įsitraukusia. GA4 juos taip pat pažymėkite kaip key events. |
| `METRICS_PATH` | `/api/metrics` | Bazinis kelias. Prie jo pridedamas `/forget`. |
| `CONSENT_COOKIE` | `cc_cookie` | Sutikimo slapukas („CookieConsent“ v2 `level`, v3 `categories`). |
| `CONSENT_CATEGORY` | `analytics` | Kategorija, kuriai turi būti duotas sutikimas. |
| `CLIENT_COOKIE` | `__av_cid` | Kliento ID ir sesijų skaičius (400 d.). |
| `SESSION_COOKIE` | `__av_sid` | Sesijos ID, peržiūros, aktyvumo laikas ir įsitraukimo žyma. |
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
- `/g/collect` naudoja `gtag.js`, serverinis GTM ir „Cloudflare Zaraz“, tačiau „Google“ šio adreso nedokumentuoja. avbdar 1.x naudojo dokumentuotą Measurement Protocol, kuris skirtas tik papildyti `gtag.js`: be jo visos sesijos patenka į „Unassigned“, o nauji naudotojai, nukreipimo puslapiai ir įsitraukusios sesijos lieka tušti.
- avbdar 1.x slapukai (vien kliento ir sesijos ID) nuskaitomi ir pratęsiami, todėl atnaujinus lankytojai neprarandami.
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
