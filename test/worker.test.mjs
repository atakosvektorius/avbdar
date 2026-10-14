// avbdar Worker tests. Run: node test/worker.test.mjs (Node >= 20, no dependencies)
import worker, { getConfig, parseClient, parseSession, truncateIp } from "../worker/worker_analytics.js";

const ORIGIN = "https://example.com";
const ENV = { DOMAIN: "example.com", GA_MEASUREMENT_ID: "G-TEST123" };
const CONSENT = 'cc_cookie={"categories":["necessary","analytics"],"level":["necessary","analytics"],"revision":0}';
const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";
const EVENT = {
  event_name: "page_view",
  page_location: `${ORIGIN}/blog/?utm_source=newsletter&utm_medium=email`,
  page_title: "Blog",
  page_referrer: "https://www.google.com/",
  engagement_time_msec: 0,
  hit_sequence: 1,
  screen_resolution: "390x844",
  params: {},
};

// Capture outgoing GA4 requests
const sent = [];
globalThis.fetch = async (url, opts) => {
  const parsed = new URL(url);
  sent.push({ url: parsed, q: parsed.searchParams, opts });
  return new Response(null, { status: 204 });
};
console.warn = () => {};
console.log = ((log) => (...args) => (String(args[0]).startsWith("GA4") ? undefined : log(...args)))(console.log);

function request(path, { method = "POST", headers = {}, body } = {}) {
  const h = { Origin: ORIGIN, "Content-Type": "application/json", "User-Agent": UA, ...headers };
  for (const key of Object.keys(h)) if (h[key] === null) delete h[key];
  return new Request(ORIGIN + path, { method, headers: h, body: method === "GET" ? undefined : body });
}

async function call(req, env = ENV) {
  sent.length = 0;
  const waits = [];
  const res = await worker.fetch(req, env, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  const cookies = res.headers.getSetCookie();
  return { res, waits, cookies, jar: cookies.map((c) => c.split(";")[0]).join("; "), q: sent[0] && sent[0].q };
}

// POST an event with consent plus the given cookie jar
const collect = (event, jar = "", env = ENV) =>
  call(request("/api/metrics", { headers: { Cookie: jar ? `${CONSENT}; ${jar}` : CONSENT }, body: JSON.stringify(event) }), env);

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

test("first page_view: new visitor + session start, HttpOnly cookies, /g/collect hit", async () => {
  const { res, cookies, q } = await call(
    request("/api/metrics", {
      headers: { Cookie: CONSENT, "Accept-Language": "lt-LT,lt;q=0.9" },
      body: JSON.stringify(EVENT),
    })
  );
  assert(res.status === 204, `status ${res.status}`);
  assert(/^__av_cid=[0-9a-f-]{36}\.1; Max-Age=34560000; Path=\/; Secure; SameSite=Lax; HttpOnly$/.test(cookies[0]), cookies[0]);
  assert(/^__av_sid=\d{10}\.1\.0\.0; Max-Age=1800; Path=\/; Secure; SameSite=Lax; HttpOnly$/.test(cookies[1]), cookies[1]);

  const { url, opts } = sent[0];
  assert(url.origin + url.pathname === "https://www.google-analytics.com/g/collect", url.href);
  assert(opts.method === "POST" && opts.headers["User-Agent"] === UA);
  const expected = {
    v: "2", tid: "G-TEST123", en: "page_view", _fv: "1", _ss: "1", _nsi: "1", sct: "1", seg: "0",
    _uip: "0.0.0.0", dt: "Blog", dr: "https://www.google.com/", ul: "lt-lt", sr: "390x844", _s: "1",
    dl: `${ORIGIN}/blog/?utm_source=newsletter&utm_medium=email`,
  };
  for (const [key, value] of Object.entries(expected)) assert(q.get(key) === value, `${key}=${q.get(key)}`);
  assert(q.get("_p") === q.get("sid") && q.get("ir") === null && q.get("_et") === null && q.get("_dbg") === null);
});

test("session flow: engagement, second page view, internal referrer", async () => {
  const first = await collect(EVENT);
  const cid = first.q.get("cid");
  const sid = first.q.get("sid");

  const engagement = await collect({ ...EVENT, event_name: "user_engagement", engagement_time_msec: 4000 }, first.jar);
  let q = engagement.q;
  assert(q.get("en") === "user_engagement" && q.get("_et") === "4000" && q.get("seg") === "0");
  assert(q.get("cid") === cid && q.get("sid") === sid && q.get("_fv") === null && q.get("_ss") === null);
  assert(/__av_sid=\d{10}\.1\.4000\.0$/.test(engagement.jar), engagement.jar);

  const second = await collect({ ...EVENT, page_location: `${ORIGIN}/about/`, page_referrer: `${ORIGIN}/blog/` }, engagement.jar);
  q = second.q;
  assert(q.get("seg") === "1" && q.get("ir") === "1" && q.get("dr") === `${ORIGIN}/blog/` && q.get("sct") === "1");
  assert(/__av_sid=\d{10}\.2\.4000\.1$/.test(second.jar), second.jar);
});

test("10 s of engagement marks the session engaged; engagement is capped", async () => {
  const cid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const { q, jar } = await collect(
    { ...EVENT, event_name: "user_engagement", engagement_time_msec: 99999999 },
    `__av_cid=${cid}.1; __av_sid=1760000000.1.0.0`
  );
  assert(q.get("seg") === "1" && q.get("_et") === "1800000");
  assert(jar.endsWith("__av_sid=1760000000.1.1800000.1"), jar);
});

test("key event engages a new session of a returning visitor", async () => {
  const cid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const { q, jar } = await collect(
    { ...EVENT, event_name: "generate_lead", params: { form: "contact", value: 5, ok: true } },
    `__av_cid=${cid}.3`
  );
  assert(q.get("seg") === "1" && q.get("_ss") === "1" && q.get("_fv") === null && q.get("sct") === "4" && q.get("cid") === cid);
  assert(q.get("ep.form") === "contact" && q.get("epn.value") === "5" && q.get("ep.ok") === "true");
  assert(jar.startsWith(`__av_cid=${cid}.4;`), jar);
});

test("user_engagement without a running session is dropped", async () => {
  const { res, waits, cookies } = await collect(
    { ...EVENT, event_name: "user_engagement", engagement_time_msec: 20000 },
    "__av_cid=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.1"
  );
  assert(res.status === 204 && waits.length === 0 && cookies.length === 0);
});

test("avbdar 1.x cookies (uuid only, session id only) are continued", async () => {
  const { q, jar } = await collect(EVENT, "__av_cid=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee; __av_sid=1760000000");
  assert(q.get("cid") === "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" && q.get("sid") === "1760000000");
  assert(q.get("_fv") === null && q.get("_ss") === null && q.get("sct") === "1" && q.get("seg") === "1");
  assert(jar === "__av_cid=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.1; __av_sid=1760000000.2.0.1", jar);
});

test("malformed cookies start a new visitor", async () => {
  const { q } = await collect(EVENT, "__av_cid=../etc; __av_sid=abc.1.2.3");
  assert(q.get("_fv") === "1" && q.get("_ss") === "1");
});

test("IP_MODE=truncated forwards a truncated IP, default forwards 0.0.0.0", async () => {
  const headers = { Cookie: CONSENT, "CF-Connecting-IP": "203.0.113.57" };
  let { q } = await call(request("/api/metrics", { headers, body: JSON.stringify(EVENT) }), { ...ENV, IP_MODE: "truncated" });
  assert(q.get("_uip") === "203.0.113.0", q.get("_uip"));
  ({ q } = await call(request("/api/metrics", { headers, body: JSON.stringify(EVENT) })));
  assert(q.get("_uip") === "0.0.0.0");
});

test("GA_DEBUG marks hits for DebugView", async () => {
  const { q } = await collect(EVENT, "", { ...ENV, GA_DEBUG: "true" });
  assert(q.get("_dbg") === "1" && q.get("ep.debug_mode") === "true");
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
    [{ headers: { Cookie: CONSENT }, body: JSON.stringify({ ...EVENT, event_name: "session_start" }) }, 400],
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
  const { q } = await collect({ ...EVENT, screen_resolution: "1x1<script>" });
  assert(q.get("sr") === null);
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

test("missing measurement ID: cookies set, nothing forwarded", async () => {
  const { waits, cookies } = await collect(EVENT, "", { ...ENV, GA_MEASUREMENT_ID: undefined });
  assert(waits.length === 0 && cookies.length === 2);
});

test("custom config: path, cookie names, events, key events, derived events dropped", async () => {
  const env = {
    ...ENV,
    METRICS_PATH: "/m/",
    CLIENT_COOKIE: "cid",
    SESSION_COOKIE: "sid",
    SESSION_TIMEOUT: "600",
    ALLOWED_EVENTS: "page_view, signup, session_start",
    KEY_EVENTS: "signup",
  };
  const config = getConfig(env);
  assert(config.metricsPath === "/m" && config.allowedEvents.has("signup") && !config.allowedEvents.has("session_start"));
  assert(config.allowedEvents.has("user_engagement") && config.keyEvents.has("signup") && !config.keyEvents.has("generate_lead"));
  const { cookies, q } = await call(
    request("/m", { headers: { Cookie: CONSENT }, body: JSON.stringify({ ...EVENT, event_name: "signup" }) }),
    env
  );
  assert(cookies[0].startsWith("cid=") && cookies[1].startsWith("sid=") && cookies[1].includes("Max-Age=600"));
  assert(q.get("seg") === "1");
});

test("cookie parsers and truncateIp helper", async () => {
  assert(parseClient("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.7").sessionCount === 7);
  assert(parseClient("not-a-uuid") === null && parseSession("123") === null);
  const s = parseSession("1760000000.3.12000.1");
  assert(s.pageViews === 3 && s.engagementMsec === 12000 && s.engaged === true);
  assert(truncateIp("198.51.100.23") === "198.51.100.0");
  assert(truncateIp("2001:db8:85a3:8d3:1319:8a2e:370:7348") === "2001:db8:85a3::");
  assert(truncateIp("2001:db8::1") === "2001:db8:0::");
  assert(truncateIp("1::2::3") === null && truncateIp("garbage") === null && truncateIp(null) === null);
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
