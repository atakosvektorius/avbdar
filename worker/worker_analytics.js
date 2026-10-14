/**
 * avbdar: server-side GA4 analytics Worker (Cloudflare Workers)
 *
 * Copyright (c) 2026 MB Atakos vektorius
 * Released under the MIT License
 *
 * Routes (default base path /api/metrics):
 * - POST /api/metrics        consent check via the consent cookie, HttpOnly client/session cookies,
 *                            forward the event to GA4 (/g/collect)
 * - POST /api/metrics/forget clear the client/session cookies on consent withdrawal
 *
 * No Google script runs in the browser. The visitor ID lives in an HttpOnly cookie set by this
 * (same-origin) server, so Safari ITP does not cap it at 7 days like JavaScript-set _ga cookies.
 * Deploy it on a zone route of the SAME host as the site (e.g. example.com/api/metrics*),
 * not on *.workers.dev or another subdomain.
 *
 * Hits go to the same /g/collect endpoint gtag.js uses (as Cloudflare Zaraz and server-side GTM do),
 * not to the Measurement Protocol: GA4 derives session source / medium, first_visit, session_start,
 * landing page and engaged sessions only from these hits, so MP-only traffic lands in "Unassigned".
 * The endpoint is undocumented; parameters follow gtag.js and Zaraz's open-source GA4 component.
 *
 * Cookie values:
 * - client cookie   <client uuid>.<session count>
 * - session cookie  <session id (start, unix s)>.<page views>.<engagement ms>.<engaged 0|1>
 *
 * Env (vars):
 * - DOMAIN             required, e.g. example.com (allowed Origin: https://DOMAIN)
 * - GA_MEASUREMENT_ID  required, e.g. G-XXXXXXXXXX
 * - GA_DEBUG           "true" -> hits show up in GA4 DebugView, GA response status is logged
 * - IP_MODE            "none" (default): GA4 gets 0.0.0.0, no geolocation
 *                      "truncated": last IPv4 octet / IPv6 bits after /48 zeroed, country / city kept
 * - ALLOWED_ORIGINS    comma-separated extra origins (local dev: http://localhost:8787)
 * - ALLOWED_EVENTS     comma-separated event allowlist (default: page_view,generate_lead,click_cta,file_download);
 *                      user_engagement (sent by the client on page hide) is always allowed
 * - KEY_EVENTS         comma-separated events that mark the session engaged (default: generate_lead)
 * - METRICS_PATH       base path (default: /api/metrics)
 * - CONSENT_COOKIE     consent cookie name (default: cc_cookie, CookieConsent v2)
 * - CONSENT_CATEGORY   consent category required (default: analytics)
 * - CLIENT_COOKIE      client ID cookie name (default: __av_cid)
 * - SESSION_COOKIE     session cookie name (default: __av_sid)
 * - SESSION_TIMEOUT    session inactivity timeout in seconds (default: 1800)
 */

const DEFAULTS = {
  METRICS_PATH: "/api/metrics",
  CONSENT_COOKIE: "cc_cookie",
  CONSENT_CATEGORY: "analytics",
  CLIENT_COOKIE: "__av_cid",
  SESSION_COOKIE: "__av_sid",
  SESSION_TIMEOUT: 1800,
  ALLOWED_EVENTS: "page_view,generate_lead,click_cta,file_download",
  KEY_EVENTS: "generate_lead",
};

const GA_ENDPOINT = "https://www.google-analytics.com/g/collect";

const CID_MAX_AGE = 34560000; // 400 days, browser maximum
const COOKIE_ATTRS = "Path=/; Secure; SameSite=Lax; HttpOnly";

const MAX_BODY_BYTES = 4096;
const MAX_PARAMS = 15;
const MAX_PARAM_VALUE = 100;
const MAX_URL_LENGTH = 1000;
const MAX_TITLE_LENGTH = 300;
const MAX_ENGAGEMENT_MSEC = 30 * 60 * 1000;
const MAX_HIT_SEQUENCE = 1000;
const MAX_PAGE_VIEWS = 9999;

// GA4 engaged session: 10 s of engagement, 2+ page views or a key event.
const ENGAGED_MSEC = 10000;

// Derived by GA4 from the _ss / _fv flags; never accepted from the client even if listed in ALLOWED_EVENTS.
const DERIVED_EVENTS = new Set(["session_start", "first_visit"]);

const EVENT_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;
const PARAM_KEY_RE = /^[a-z_][a-z0-9_]{0,39}$/;
const CID_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\.(\d{1,6}))?$/;
const SID_RE = /^(\d{10})(?:\.(\d{1,4})\.(\d{1,7})\.([01]))?$/;
const SCREEN_RE = /^\d{2,5}x\d{2,5}$/;

function eventList(value) {
  return value
    .split(",")
    .map((e) => e.trim())
    .filter((e) => EVENT_NAME_RE.test(e) && !DERIVED_EVENTS.has(e));
}

/**
 * Resolves configuration from env with defaults.
 */
export function getConfig(env) {
  const events = eventList(env.ALLOWED_EVENTS || DEFAULTS.ALLOWED_EVENTS);
  const timeout = Number(env.SESSION_TIMEOUT);

  return {
    metricsPath: (env.METRICS_PATH || DEFAULTS.METRICS_PATH).replace(/\/+$/, ""),
    consentCookie: env.CONSENT_COOKIE || DEFAULTS.CONSENT_COOKIE,
    consentCategory: env.CONSENT_CATEGORY || DEFAULTS.CONSENT_CATEGORY,
    clientCookie: env.CLIENT_COOKIE || DEFAULTS.CLIENT_COOKIE,
    sessionCookie: env.SESSION_COOKIE || DEFAULTS.SESSION_COOKIE,
    sessionTimeout: Number.isFinite(timeout) && timeout > 0 ? Math.round(timeout) : DEFAULTS.SESSION_TIMEOUT,
    allowedEvents: new Set([...events, "user_engagement"]),
    keyEvents: new Set(eventList(env.KEY_EVENTS ?? DEFAULTS.KEY_EVENTS)),
    truncateIp: env.IP_MODE === "truncated",
  };
}

/**
 * Creates a standard JSON Response.
 */
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

/**
 * Parses the Cookie header into a plain object.
 */
export function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    if (name && !(name in cookies)) cookies[name] = part.slice(idx + 1).trim();
  }
  return cookies;
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Server-side consent check: CookieConsent v2 stores JSON in cc_cookie with a `level` array
 * (v3 uses `categories`). The client-sent `consent` field is never trusted.
 */
export function hasConsent(cookies, cookieName, category) {
  const raw = cookies[cookieName];
  if (!raw) return false;
  for (const candidate of [raw, safeDecode(raw)]) {
    try {
      const value = JSON.parse(candidate);
      const level = Array.isArray(value.level) ? value.level : value.categories;
      return Array.isArray(level) && level.includes(category);
    } catch {
      // try next candidate
    }
  }
  return false;
}

/**
 * Returns the request origin if it is allowed, otherwise null.
 */
function allowedOrigin(request, env) {
  const allowed = new Set();
  if (env.DOMAIN) allowed.add(`https://${env.DOMAIN}`);
  for (const extra of (env.ALLOWED_ORIGINS || "").split(",")) {
    if (extra.trim()) allowed.add(extra.trim());
  }

  let origin = request.headers.get("Origin");
  if (!origin) {
    const referer = request.headers.get("Referer");
    if (referer) {
      try {
        origin = new URL(referer).origin;
      } catch {
        origin = null;
      }
    }
  }
  return origin && allowed.has(origin) ? origin : null;
}

/**
 * Validates a URL string belonging to the allowed origin.
 */
function sameOriginUrl(value, origin) {
  if (typeof value !== "string" || value.length > MAX_URL_LENGTH) return null;
  try {
    const url = new URL(value);
    return url.origin === origin ? url.href : null;
  } catch {
    return null;
  }
}

function anyUrl(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_URL_LENGTH) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Validates custom event params: flat object, limited keys, primitive values only.
 */
export function sanitizeParams(params) {
  if (params === undefined || params === null) return {};
  if (typeof params !== "object" || Array.isArray(params)) return null;

  const entries = Object.entries(params);
  if (entries.length > MAX_PARAMS) return null;

  const clean = {};
  for (const [key, value] of entries) {
    if (!PARAM_KEY_RE.test(key)) return null;
    if (typeof value === "string") {
      clean[key] = value.slice(0, MAX_PARAM_VALUE);
    } else if (typeof value === "number" && Number.isFinite(value)) {
      clean[key] = value;
    } else if (typeof value === "boolean") {
      clean[key] = value;
    } else {
      return null;
    }
  }
  return clean;
}

/**
 * Integer in [min, max], or `fallback` when the value is missing or not a finite number.
 */
function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (value === undefined || value === null || !Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.round(number), min), max);
}

/**
 * Client cookie -> { id, sessionCount } or null. Cookies from avbdar 1.x hold only the uuid.
 */
export function parseClient(value) {
  const match = value && CID_RE.exec(value);
  if (!match) return null;
  return { id: match[1], sessionCount: Number(match[2] || 0) };
}

/**
 * Session cookie -> session state or null. Cookies from avbdar 1.x hold only the session id,
 * set by a page_view, so they count as one page view.
 */
export function parseSession(value) {
  const match = value && SID_RE.exec(value);
  if (!match) return null;
  if (match[2] === undefined) return { id: match[1], pageViews: 1, engagementMsec: 0, engaged: false };
  return {
    id: match[1],
    pageViews: Number(match[2]),
    engagementMsec: Number(match[3]),
    engaged: match[4] === "1",
  };
}

/**
 * Zeroes the host part of an IP: IPv4 -> /24, IPv6 -> /48. Returns null for anything unparseable.
 */
export function truncateIp(ip) {
  if (typeof ip !== "string") return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ip.replace(/\.\d+$/, ".0");
  if (!ip.includes(":")) return null;
  const [head, tail, extra] = ip.toLowerCase().split("::");
  if (extra !== undefined) return null;
  const front = head ? head.split(":") : [];
  const back = tail ? tail.split(":") : [];
  const fill = tail === undefined ? 0 : 8 - front.length - back.length;
  if (fill < 0) return null;
  const groups = [...front, ...Array(fill).fill("0"), ...back];
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return `${groups.slice(0, 3).join(":")}::`;
}

function primaryLanguage(acceptLanguage) {
  const language = (acceptLanguage || "").split(",")[0].split(";")[0].trim();
  return /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})?$/.test(language) ? language.toLowerCase() : undefined;
}

/**
 * Sends one hit to GA4 /g/collect. The visitor's User-Agent is forwarded so GA4 can
 * derive device category, browser and operating system.
 */
async function sendToGA(hit, userAgent, env) {
  const headers = userAgent ? { "User-Agent": userAgent } : {};
  try {
    const res = await fetch(`${GA_ENDPOINT}?${hit}`, { method: "POST", headers });
    if (env.GA_DEBUG === "true") {
      console.log("GA4 collect:", res.status, hit.get("en"));
    } else if (!res.ok) {
      console.error("GA4 collect error:", res.status);
    }
  } catch (err) {
    console.error("GA4 collect fetch failed:", err && err.message);
  }
}

function noContent(headers = new Headers()) {
  headers.set("Cache-Control", "no-store");
  return new Response(null, { status: 204, headers });
}

async function handleCollect(request, env, ctx, config) {
  const origin = allowedOrigin(request, env);
  if (!origin) return jsonResponse({ error: "Forbidden" }, 403);

  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return jsonResponse({ error: "Unsupported Media Type" }, 415);
  }

  const declaredLength = Number(request.headers.get("Content-Length") || 0);
  if (declaredLength > MAX_BODY_BYTES) return jsonResponse({ error: "Payload Too Large" }, 413);

  const rawBody = await request.text();
  if (new TextEncoder().encode(rawBody).length > MAX_BODY_BYTES) {
    return jsonResponse({ error: "Payload Too Large" }, 413);
  }

  const cookies = parseCookies(request.headers.get("Cookie"));

  // No consent: no cookie, nothing sent to GA4.
  if (!hasConsent(cookies, config.consentCookie, config.consentCategory)) {
    return noContent();
  }

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonResponse({ error: "Invalid body" }, 400);
  }

  const eventName = body.event_name;
  if (typeof eventName !== "string" || !config.allowedEvents.has(eventName)) {
    return jsonResponse({ error: "Unknown event" }, 400);
  }

  const pageLocation = sameOriginUrl(body.page_location, origin);
  if (!pageLocation) return jsonResponse({ error: "Invalid page_location" }, 400);

  const params = sanitizeParams(body.params);
  if (!params) return jsonResponse({ error: "Invalid params" }, 400);

  const client = parseClient(cookies[config.clientCookie]);
  const session = parseSession(cookies[config.sessionCookie]);

  // user_engagement only closes out a page of a running session; it never starts one.
  if (eventName === "user_engagement" && (!client || !session)) return noContent();

  // Identifiers and session state
  const clientId = client ? client.id : crypto.randomUUID();
  const state = session || {
    id: String(Math.floor(Date.now() / 1000)),
    pageViews: 0,
    engagementMsec: 0,
    engaged: false,
  };
  const sessionCount = Math.max((client ? client.sessionCount : 0) + (session ? 0 : 1), 1);

  const engagementMsec = clampInt(body.engagement_time_msec, 0, MAX_ENGAGEMENT_MSEC, 0);
  if (eventName === "page_view") state.pageViews = Math.min(state.pageViews + 1, MAX_PAGE_VIEWS);
  state.engagementMsec = Math.min(state.engagementMsec + engagementMsec, MAX_ENGAGEMENT_MSEC);
  if (state.pageViews >= 2 || state.engagementMsec >= ENGAGED_MSEC || config.keyEvents.has(eventName)) {
    state.engaged = true;
  }

  const ip = config.truncateIp ? truncateIp(request.headers.get("CF-Connecting-IP")) : null;
  const hit = new URLSearchParams({
    v: "2",
    tid: env.GA_MEASUREMENT_ID || "",
    cid: clientId,
    sid: state.id,
    sct: String(sessionCount),
    seg: state.engaged ? "1" : "0",
    _p: state.id,
    en: eventName,
    dl: pageLocation,
    _uip: ip || "0.0.0.0",
  });
  if (!client) hit.set("_fv", "1");
  if (!session) {
    hit.set("_ss", "1");
    hit.set("_nsi", "1");
  }

  const hitSequence = clampInt(body.hit_sequence, 1, MAX_HIT_SEQUENCE, undefined);
  if (hitSequence !== undefined) hit.set("_s", String(hitSequence));
  if (engagementMsec > 0) hit.set("_et", String(engagementMsec));

  if (typeof body.page_title === "string" && body.page_title) {
    hit.set("dt", body.page_title.slice(0, MAX_TITLE_LENGTH));
  }
  const referrer = anyUrl(body.page_referrer);
  if (referrer) {
    hit.set("dr", referrer);
    // Internal navigation keeps page_referrer but must not become a "referral" traffic source.
    if (new URL(referrer).origin === origin) hit.set("ir", "1");
  }

  const language = primaryLanguage(request.headers.get("Accept-Language"));
  if (language) hit.set("ul", language);
  if (typeof body.screen_resolution === "string" && SCREEN_RE.test(body.screen_resolution)) {
    hit.set("sr", body.screen_resolution);
  }

  // Custom event params: ep.* for text, epn.* for numbers (as gtag.js sends them).
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "number") hit.set(`epn.${key}`, String(value));
    else hit.set(`ep.${key}`, String(value));
  }

  if (env.GA_DEBUG === "true") {
    hit.set("_dbg", "1");
    hit.set("ep.debug_mode", "true");
  }

  if (env.GA_MEASUREMENT_ID) {
    ctx.waitUntil(sendToGA(hit, request.headers.get("User-Agent"), env));
  } else {
    console.warn("GA_MEASUREMENT_ID not configured; event not forwarded");
  }

  const cidValue = `${clientId}.${sessionCount}`;
  const sidValue = `${state.id}.${state.pageViews}.${state.engagementMsec}.${state.engaged ? 1 : 0}`;
  const headers = new Headers();
  headers.append("Set-Cookie", `${config.clientCookie}=${cidValue}; Max-Age=${CID_MAX_AGE}; ${COOKIE_ATTRS}`);
  headers.append("Set-Cookie", `${config.sessionCookie}=${sidValue}; Max-Age=${config.sessionTimeout}; ${COOKIE_ATTRS}`);
  return noContent(headers);
}

function handleForget(request, env, config) {
  if (!allowedOrigin(request, env)) return jsonResponse({ error: "Forbidden" }, 403);

  const headers = new Headers();
  headers.append("Set-Cookie", `${config.clientCookie}=; Max-Age=0; ${COOKIE_ATTRS}`);
  headers.append("Set-Cookie", `${config.sessionCookie}=; Max-Age=0; ${COOKIE_ATTRS}`);
  return noContent(headers);
}

export default {
  async fetch(request, env, ctx) {
    const config = getConfig(env);
    const { pathname } = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204 });
    }

    if (pathname === config.metricsPath || pathname === `${config.metricsPath}/`) {
      if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
      return handleCollect(request, env, ctx, config);
    }

    if (pathname === `${config.metricsPath}/forget`) {
      if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
      return handleForget(request, env, config);
    }

    return jsonResponse({ error: "Not found" }, 404);
  },
};
