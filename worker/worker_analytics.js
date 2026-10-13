/**
 * avbdar: server-side GA4 analytics Worker (Cloudflare Workers)
 *
 * Copyright (c) 2026 MB Atakos vektorius
 * Released under the MIT License
 *
 * Routes (default base path /api/metrics):
 * - POST /api/metrics        consent check via the consent cookie, HttpOnly client/session cookies,
 *                            forward the event to GA4 Measurement Protocol
 * - POST /api/metrics/forget clear the client/session cookies on consent withdrawal
 *
 * No Google script runs in the browser. The visitor ID lives in an HttpOnly cookie set by this
 * (same-origin) server, so Safari ITP does not cap it at 7 days like JavaScript-set _ga cookies.
 * Deploy it on a zone route of the SAME host as the site (e.g. example.com/api/metrics*),
 * not on *.workers.dev or another subdomain.
 *
 * Env (vars / secrets):
 * - DOMAIN             required, e.g. example.com (allowed Origin: https://DOMAIN)
 * - GA_MEASUREMENT_ID  required, e.g. G-XXXXXXXXXX
 * - GA_API_SECRET      required, Measurement Protocol API secret (Worker secret, never in vars)
 * - GA_DEBUG           "true" -> send to /debug/mp/collect and log validation messages
 * - ALLOWED_ORIGINS    comma-separated extra origins (local dev: http://localhost:8787)
 * - ALLOWED_EVENTS     comma-separated event allowlist (default: page_view,generate_lead,click_cta,file_download)
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
};

const CID_MAX_AGE = 34560000; // 400 days, browser maximum
const COOKIE_ATTRS = "Path=/; Secure; SameSite=Lax; HttpOnly";

const MAX_BODY_BYTES = 4096;
const MAX_PARAMS = 15;
const MAX_PARAM_VALUE = 100;
const MAX_URL_LENGTH = 1000;
const MAX_TITLE_LENGTH = 300;
const MAX_ENGAGEMENT_MSEC = 30 * 60 * 1000;

// Reserved in Measurement Protocol, never forwarded even if listed in ALLOWED_EVENTS.
const RESERVED_EVENTS = new Set([
  "ad_activeview", "ad_click", "ad_exposure", "ad_impression", "ad_query", "ad_reward",
  "adunit_exposure", "app_clear_data", "app_exception", "app_install", "app_remove",
  "app_store_refund", "app_update", "app_upgrade", "dynamic_link_app_open",
  "dynamic_link_app_update", "dynamic_link_first_open", "error", "firebase_campaign",
  "first_open", "first_visit", "in_app_purchase", "notification_dismiss",
  "notification_foreground", "notification_open", "notification_receive",
  "notification_send", "os_update", "screen_view", "session_start", "user_engagement",
]);

const EVENT_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;
const PARAM_KEY_RE = /^[a-z_][a-z0-9_]{0,39}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Cloudflare continent codes -> UN M49 codes expected by GA4 user_location.continent_id
const CONTINENT_M49 = { AF: "002", AN: "010", AS: "142", EU: "150", NA: "019", SA: "019", OC: "009" };

/**
 * Resolves configuration from env with defaults.
 */
export function getConfig(env) {
  const events = (env.ALLOWED_EVENTS || DEFAULTS.ALLOWED_EVENTS)
    .split(",")
    .map((e) => e.trim())
    .filter((e) => EVENT_NAME_RE.test(e) && !RESERVED_EVENTS.has(e));
  const timeout = Number(env.SESSION_TIMEOUT);

  return {
    metricsPath: (env.METRICS_PATH || DEFAULTS.METRICS_PATH).replace(/\/+$/, ""),
    consentCookie: env.CONSENT_COOKIE || DEFAULTS.CONSENT_COOKIE,
    consentCategory: env.CONSENT_CATEGORY || DEFAULTS.CONSENT_CATEGORY,
    clientCookie: env.CLIENT_COOKIE || DEFAULTS.CLIENT_COOKIE,
    sessionCookie: env.SESSION_COOKIE || DEFAULTS.SESSION_COOKIE,
    sessionTimeout: Number.isFinite(timeout) && timeout > 0 ? Math.round(timeout) : DEFAULTS.SESSION_TIMEOUT,
    allowedEvents: new Set(events),
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
 * Builds GA4 user_location from Cloudflare geo data (MP requests come from Cloudflare IPs).
 */
export function userLocation(cf) {
  if (!cf || !cf.country || cf.country === "XX" || cf.country === "T1") return undefined;
  const location = { country_id: cf.country };
  if (cf.regionCode) location.region_id = `${cf.country}-${cf.regionCode}`;
  if (cf.city) location.city = cf.city;
  if (CONTINENT_M49[cf.continent]) location.continent_id = CONTINENT_M49[cf.continent];
  return location;
}

/**
 * Minimal User-Agent parse for GA4 device fields.
 */
export function deviceInfo(userAgent, acceptLanguage) {
  const ua = userAgent || "";
  const device = {};

  if (/iPad|Tablet|Android(?!.*Mobile)/i.test(ua)) device.category = "tablet";
  else if (/Mobi|iPhone|iPod|Android/i.test(ua)) device.category = "mobile";
  else device.category = "desktop";

  let match;
  if ((match = ua.match(/(?:iPhone|iPad|iPod).*? OS (\d+(?:_\d+)*)/))) {
    device.operating_system = "iOS";
    device.operating_system_version = match[1].replace(/_/g, ".");
  } else if ((match = ua.match(/Android (\d+(?:\.\d+)*)/))) {
    device.operating_system = "Android";
    device.operating_system_version = match[1];
  } else if ((match = ua.match(/Windows NT (\d+\.\d+)/))) {
    device.operating_system = "Windows";
    device.operating_system_version = match[1];
  } else if ((match = ua.match(/Mac OS X (\d+(?:[_.]\d+)*)/))) {
    device.operating_system = "Macintosh";
    device.operating_system_version = match[1].replace(/_/g, ".");
  } else if (/CrOS/.test(ua)) {
    device.operating_system = "Chrome OS";
  } else if (/Linux/.test(ua)) {
    device.operating_system = "Linux";
  }

  const browsers = [
    ["Edge", /Edg(?:e|A|iOS)?\/([\d.]+)/],
    ["Opera", /OPR\/([\d.]+)/],
    ["Samsung Internet", /SamsungBrowser\/([\d.]+)/],
    ["Firefox", /(?:Firefox|FxiOS)\/([\d.]+)/],
    ["Chrome", /(?:Chrome|CriOS)\/([\d.]+)/],
    ["Safari", /Version\/([\d.]+).*Safari/],
  ];
  for (const [name, re] of browsers) {
    if ((match = ua.match(re))) {
      device.browser = name;
      device.browser_version = match[1];
      break;
    }
  }

  const language = (acceptLanguage || "").split(",")[0].split(";")[0].trim();
  if (/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})?$/.test(language)) device.language = language;

  return device;
}

/**
 * Sends the payload to GA4 Measurement Protocol (or the debug endpoint).
 */
async function sendToGA(payload, env) {
  const debug = env.GA_DEBUG === "true";
  const endpoint = debug
    ? "https://www.google-analytics.com/debug/mp/collect"
    : "https://www.google-analytics.com/mp/collect";
  const url =
    `${endpoint}?measurement_id=${encodeURIComponent(env.GA_MEASUREMENT_ID)}` +
    `&api_secret=${encodeURIComponent(env.GA_API_SECRET)}`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (debug) {
      console.log("GA4 MP debug:", res.status, await res.text());
    } else if (!res.ok) {
      console.error("GA4 MP error:", res.status);
    }
  } catch (err) {
    console.error("GA4 MP fetch failed:", err && err.message);
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

  // Identifiers
  let clientId = cookies[config.clientCookie];
  if (!clientId || !UUID_RE.test(clientId)) clientId = crypto.randomUUID();

  const nowSeconds = Math.floor(Date.now() / 1000);
  let sessionId = cookies[config.sessionCookie];
  if (!sessionId || !/^\d{10}$/.test(sessionId)) sessionId = String(nowSeconds);

  const engagement = Number(body.engagement_time_msec);
  const engagementMsec = Number.isFinite(engagement)
    ? Math.min(Math.max(Math.round(engagement), 1), MAX_ENGAGEMENT_MSEC)
    : 1;

  const eventParams = {
    ...params,
    page_location: pageLocation,
    session_id: sessionId,
    engagement_time_msec: engagementMsec,
  };
  if (typeof body.page_title === "string" && body.page_title) {
    eventParams.page_title = body.page_title.slice(0, MAX_TITLE_LENGTH);
  }
  const referrer = anyUrl(body.page_referrer);
  if (referrer) eventParams.page_referrer = referrer;

  const device = deviceInfo(request.headers.get("User-Agent"), request.headers.get("Accept-Language"));
  if (device.language) eventParams.language = device.language.toLowerCase();

  const payload = {
    client_id: clientId,
    timestamp_micros: Date.now() * 1000,
    ip_override: "0.0.0.0",
    device,
    events: [{ name: eventName, params: eventParams }],
  };
  const location = userLocation(request.cf);
  if (location) payload.user_location = location;

  if (env.GA_MEASUREMENT_ID && env.GA_API_SECRET) {
    ctx.waitUntil(sendToGA(payload, env));
  } else {
    console.warn("GA_MEASUREMENT_ID / GA_API_SECRET not configured; event not forwarded");
  }

  const headers = new Headers();
  headers.append("Set-Cookie", `${config.clientCookie}=${clientId}; Max-Age=${CID_MAX_AGE}; ${COOKIE_ATTRS}`);
  headers.append("Set-Cookie", `${config.sessionCookie}=${sessionId}; Max-Age=${config.sessionTimeout}; ${COOKIE_ATTRS}`);
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
