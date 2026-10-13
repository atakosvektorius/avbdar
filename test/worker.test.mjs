// avbdar Worker tests. Run: node test/worker.test.mjs (Node >= 20, no dependencies)
import worker, { getConfig, deviceInfo, userLocation } from "../worker/worker_analytics.js";

const ORIGIN = "https://example.com";
const ENV = { DOMAIN: "example.com", GA_MEASUREMENT_ID: "G-TEST123", GA_API_SECRET: "secret" };
const CONSENT = 'cc_cookie={"categories":["necessary","analytics"],"level":["necessary","analytics"],"revision":0}';
const EVENT = {
  event_name: "page_view",
  page_location: `${ORIGIN}/blog/`,
  page_title: "Blog",
  engagement_time_msec: 120,
  params: {},
};

// Capture outgoing GA4 requests
const sent = [];
globalThis.fetch = async (url, opts) => {
  sent.push({ url, body: JSON.parse(opts.body) });
  return new Response('{"validationMessages":[]}', { status: 200 });
};
console.warn = () => {};

function request(path, { method = "POST", headers = {}, body, cf } = {}) {
  const h = { Origin: ORIGIN, "Content-Type": "application/json", ...headers };
  for (const key of Object.keys(h)) if (h[key] === null) delete h[key];
  const req = new Request(ORIGIN + path, { method, headers: h, body: method === "GET" ? undefined : body });
  Object.defineProperty(req, "cf", { value: cf ?? { country: "LT", regionCode: "VL", city: "Vilnius", continent: "EU" } });
  return req;
}

async function call(req, env = ENV) {
  const waits = [];
  const res = await worker.fetch(req, env, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  return { res, waits, cookies: res.headers.getSetCookie() };
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
function assert(condition, message) {
  if (!condition) throw new Error(message || "assertion failed");
}

test("no consent: 204, no cookies, nothing forwarded", async () => {
  const { res, waits, cookies } = await call(request("/api/metrics", { body: JSON.stringify(EVENT) }));
  assert(res.status === 204 && cookies.length === 0 && waits.length === 0);
});

test("client-sent consent:true is ignored", async () => {
  const { waits, cookies } = await call(request("/api/metrics", { body: JSON.stringify({ ...EVENT, consent: true }) }));
  assert(cookies.length === 0 && waits.length === 0);
});

test("necessary-only consent is rejected", async () => {
  const { cookies, waits } = await call(
    request("/api/metrics", { headers: { Cookie: 'cc_cookie={"level":["necessary"]}' }, body: JSON.stringify(EVENT) })
  );
  assert(cookies.length === 0 && waits.length === 0);
});

test("consent: HttpOnly cookies set and event forwarded", async () => {
  sent.length = 0;
  const { res, cookies } = await call(
    request("/api/metrics", {
      headers: {
        Cookie: CONSENT,
        "User-Agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
        "Accept-Language": "lt-LT,lt;q=0.9",
      },
      body: JSON.stringify(EVENT),
    })
  );
  assert(res.status === 204, `status ${res.status}`);
  assert(/^__av_cid=[0-9a-f-]{36}; Max-Age=34560000; Path=\/; Secure; SameSite=Lax; HttpOnly$/.test(cookies[0]), cookies[0]);
  assert(/^__av_sid=\d{10}; Max-Age=1800; Path=\/; Secure; SameSite=Lax; HttpOnly$/.test(cookies[1]), cookies[1]);

  const { url, body } = sent[0];
  assert(url.startsWith("https://www.google-analytics.com/mp/collect?measurement_id=G-TEST123&api_secret=secret"), url);
  assert(body.ip_override === "0.0.0.0");
  assert(body.user_location.country_id === "LT" && body.user_location.region_id === "LT-VL");
  assert(body.user_location.continent_id === "150");
  assert(body.device.category === "mobile" && body.device.operating_system === "iOS" && body.device.browser === "Safari");
  const params = body.events[0].params;
  assert(body.events[0].name === "page_view");
  assert(params.session_id && params.engagement_time_msec === 120 && params.page_location === `${ORIGIN}/blog/`);
});

test("existing client/session IDs are reused", async () => {
  sent.length = 0;
  const { cookies } = await call(
    request("/api/metrics", {
      headers: { Cookie: `${CONSENT}; __av_cid=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee; __av_sid=1760000000` },
      body: JSON.stringify(EVENT),
    })
  );
  assert(cookies[0].startsWith("__av_cid=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee;"));
  assert(cookies[1].startsWith("__av_sid=1760000000;"));
  assert(sent[0].body.client_id === "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
  assert(sent[0].body.events[0].params.session_id === "1760000000");
});

test("URI-encoded and v3-style consent cookies are accepted", async () => {
  const encoded = "cc_cookie=" + encodeURIComponent('{"categories":["necessary","analytics"]}');
  const { cookies } = await call(request("/api/metrics", { headers: { Cookie: encoded }, body: JSON.stringify(EVENT) }));
  assert(cookies.length === 2);
});

test("Referer is accepted when Origin is missing", async () => {
  const { res } = await call(
    request("/api/metrics", { headers: { Origin: null, Referer: `${ORIGIN}/x`, Cookie: CONSENT }, body: JSON.stringify(EVENT) })
  );
  assert(res.status === 204);
});

test("validation errors", async () => {
  const cases = [
    [{ headers: { Origin: "https://evil.example", Cookie: CONSENT }, body: JSON.stringify(EVENT) }, 403],
    [{ headers: { Cookie: CONSENT }, body: JSON.stringify({ ...EVENT, event_name: "purchase" }) }, 400],
    [{ headers: { Cookie: CONSENT }, body: JSON.stringify({ ...EVENT, page_location: "https://evil.example/" }) }, 400],
    [{ headers: { Cookie: CONSENT }, body: JSON.stringify({ ...EVENT, params: { nested: { a: 1 } } }) }, 400],
    [{ headers: { Cookie: CONSENT }, body: "x".repeat(5000) }, 413],
    [{ headers: { Cookie: CONSENT, "Content-Type": "text/plain" }, body: JSON.stringify(EVENT) }, 415],
    [{ method: "GET" }, 405],
  ];
  for (const [opts, status] of cases) {
    const { res } = await call(request("/api/metrics", opts));
    assert(res.status === status, `expected ${status}, got ${res.status} for ${JSON.stringify(opts).slice(0, 80)}`);
  }
});

test("forget clears both cookies", async () => {
  const { res, cookies } = await call(request("/api/metrics/forget", { headers: { "Content-Type": null } }));
  assert(res.status === 204 && cookies.length === 2);
  assert(cookies.every((c) => c.includes("Max-Age=0; Path=/; Secure; SameSite=Lax; HttpOnly")));
});

test("forget rejects foreign origin", async () => {
  const { res } = await call(request("/api/metrics/forget", { headers: { Origin: "https://evil.example" } }));
  assert(res.status === 403);
});

test("unknown path returns 404", async () => {
  const { res } = await call(request("/api/metrics/other"));
  assert(res.status === 404);
});

test("missing secret: cookies set, nothing forwarded", async () => {
  const { waits, cookies } = await call(
    request("/api/metrics", { headers: { Cookie: CONSENT }, body: JSON.stringify(EVENT) }),
    { ...ENV, GA_API_SECRET: undefined }
  );
  assert(waits.length === 0 && cookies.length === 2);
});

test("custom config: path, cookie names, events, reserved events dropped", async () => {
  const env = {
    ...ENV,
    METRICS_PATH: "/m/",
    CLIENT_COOKIE: "cid",
    SESSION_COOKIE: "sid",
    SESSION_TIMEOUT: "600",
    ALLOWED_EVENTS: "page_view, signup, session_start",
  };
  const config = getConfig(env);
  assert(config.metricsPath === "/m" && config.allowedEvents.has("signup") && !config.allowedEvents.has("session_start"));
  const { cookies } = await call(
    request("/m", { headers: { Cookie: CONSENT }, body: JSON.stringify({ ...EVENT, event_name: "signup" }) }),
    env
  );
  assert(cookies[0].startsWith("cid=") && cookies[1].startsWith("sid=") && cookies[1].includes("Max-Age=600"));
});

test("deviceInfo and userLocation helpers", async () => {
  const win = deviceInfo("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0", "en-US");
  assert(win.category === "desktop" && win.operating_system === "Windows" && win.browser === "Edge" && win.language === "en-US");
  assert(userLocation({ country: "XX" }) === undefined);
  assert(userLocation({ country: "US", continent: "NA" }).continent_id === "019");
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}: ${err.message}`);
  }
}
console.log(failed ? `\n${failed} of ${tests.length} failed` : `\nall ${tests.length} passed`);
if (failed && typeof process !== "undefined") process.exitCode = 1;
