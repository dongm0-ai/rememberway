import test from "node:test";
import assert from "node:assert/strict";
import {
  needsRefresh, nextUrl, toSession, sessionFromHash, reasonFromError, reasonText,
  requireLogin, savedEmail, rememberEmail, session, signIn, signUp, signOut, updatePassword, authFetch,
  acceptRecoveryLink, recentlyRejected, resetPassword,
} from "../public/js/auth.js";

// ---- 순수 함수 -------------------------------------------------------------
test("needsRefresh true within 60s of expiry", () => assert.equal(needsRefresh({ expires_at: 1000 }, 950), true));
test("needsRefresh false when far", () => assert.equal(needsRefresh({ expires_at: 1000 }, 100), false));
test("needsRefresh boundary: exactly 60s left refreshes, 61s does not", () => {
  assert.equal(needsRefresh({ expires_at: 1000 }, 940), true);
  assert.equal(needsRefresh({ expires_at: 1000 }, 939), false);
});
test("needsRefresh true when already expired, or expiry unknown, or no session", () => {
  assert.equal(needsRefresh({ expires_at: 1000 }, 2000), true);
  assert.equal(needsRefresh({}, 100), true);
  assert.equal(needsRefresh({ expires_at: "soon" }, 100), true);
  assert.equal(needsRefresh(null, 100), true);
});

test("nextUrl keeps same-site path", () => assert.equal(nextUrl("?next=%2Freport%3Fx%3D1"), "/report?x=1"));
test("nextUrl blocks other origins", () => assert.equal(nextUrl("?next=https%3A%2F%2Fevil.com"), "/"));
test("nextUrl blocks protocol-relative, backslash and scheme tricks", () => {
  for (const bad of ["//evil.com", "/\\evil.com", "/\n/evil.com", "/\t/evil.com", "javascript:alert(1)", "evil.com", "http:evil.com", "///evil.com", " //evil.com"])
    assert.equal(nextUrl("?next=" + encodeURIComponent(bad)), "/", JSON.stringify(bad));
});
test("nextUrl blocks dot-segment tricks that normalize to a protocol-relative URL", () => {
  for (const bad of ["/.//evil.com", "/%2e//evil.com", "/%2E%2E//evil.com", "/a/..//evil.com", "/..//evil.com/x?y=1", "/./\\evil.com", "/%2e%2e/%2e%2e//evil.com"]) {
    const out = nextUrl("?next=" + encodeURIComponent(bad));
    assert.equal(out, "/", JSON.stringify(bad));
  }
  // 안전한 점 경로는 정리된 같은 사이트 경로로
  assert.equal(nextUrl("?next=" + encodeURIComponent("/a/../report?x=1")), "/report?x=1");
});
test("nextUrl defaults to / when missing or empty", () => {
  assert.equal(nextUrl(""), "/");
  assert.equal(nextUrl("?reset=1"), "/");
  assert.equal(nextUrl("?next="), "/");
  assert.equal(nextUrl(undefined), "/");
});
test("nextUrl does not bounce back to the login page", () => {
  assert.equal(nextUrl("?next=%2Flogin"), "/");
  assert.equal(nextUrl("?next=%2Flogin%3Fnext%3D%2Freport"), "/");
  assert.equal(nextUrl("?next=%2Flogin.html"), "/");
  for (const v of ["/LOGIN", "/Login.html", "/login/", "/login.html/", "/a/../login", "/%2e/login", "/./login?next=%2Fx"])
    assert.equal(nextUrl("?next=" + encodeURIComponent(v)), "/", v);
  assert.equal(nextUrl("?next=" + encodeURIComponent("/loginx")), "/loginx", "only the login page itself is excluded");
});
test("nextUrl keeps query and hash of a same-site path (invite link)", () => assert.equal(nextUrl("?next=" + encodeURIComponent("/join?t=abc%20d#x")), "/join?t=abc%20d#x"));

test("toSession fills expires_at from expires_in and keeps only needed fields", () => {
  const s = toSession({ access_token: "a", refresh_token: "r", expires_in: 3600, user: { id: "u1", email: "a@b.c", phone: "010", app_metadata: {} } }, 1000);
  assert.deepEqual(s, { access_token: "a", refresh_token: "r", expires_at: 4600, user: { id: "u1", email: "a@b.c" } });
});
test("toSession: expires_in + local clock wins over the server's expires_at (clock skew); expires_at is the fallback", () => {
  assert.equal(toSession({ access_token: "a", refresh_token: "r", expires_at: 999999, expires_in: 3600 }, 1000).expires_at, 4600);
  assert.equal(toSession({ access_token: "a", refresh_token: "r", expires_at: 5000 }, 1000).expires_at, 5000);
  assert.equal(toSession({ access_token: "a", refresh_token: "r" }, 1000).expires_at, 4600, "neither → one hour");
});
test("toSession falls back to the previous user and rejects tokenless data", () => {
  assert.deepEqual(toSession({ access_token: "a", refresh_token: "r", expires_at: 5000 }, 1000, { id: "old", email: "o@b.c" }).user, { id: "old", email: "o@b.c" });
  assert.equal(toSession({ user: { id: "u1" } }, 1000), null);
  assert.equal(toSession({ access_token: "a" }, 1000), null);
  assert.equal(toSession(null, 1000), null);
});

test("sessionFromHash reads a recovery link", () => {
  const r = sessionFromHash("#access_token=AT&expires_in=3600&refresh_token=RT&token_type=bearer&type=recovery", 1000);
  assert.deepEqual(r, { type: "recovery", tokens: { access_token: "AT", refresh_token: "RT", expires_at: 4600 } });
  assert.equal(sessionFromHash("#access_token=AT&refresh_token=RT&expires_at=999999&expires_in=3600&type=recovery", 1000).tokens.expires_at, 4600, "local clock + expires_in");
  assert.equal(sessionFromHash("#access_token=AT&refresh_token=RT&expires_at=5000&type=recovery", 1000).tokens.expires_at, 5000);
});
test("sessionFromHash reports an expired/invalid link", () => {
  const r = sessionFromHash("#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired", 1000);
  assert.equal(r.error, "LINK_EXPIRED");
  assert.equal(sessionFromHash("", 1000), null);
  assert.equal(sessionFromHash("#foo=bar", 1000), null);
  assert.equal(sessionFromHash(undefined, 1000), null);
});

test("reasonFromError maps Supabase Auth errors", () => {
  const cases = [
    [400, { error_code: "invalid_credentials", msg: "Invalid login credentials" }, "INVALID_CREDENTIALS"],
    [400, { error: "invalid_grant", error_description: "Invalid login credentials" }, "INVALID_CREDENTIALS"],
    [422, { error_code: "user_already_exists", msg: "User already registered" }, "EMAIL_EXISTS"],
    [422, { error_code: "weak_password", msg: "Password should be at least 6 characters." }, "WEAK_PASSWORD"],
    [422, { error_code: "same_password", msg: "New password should be different from the old password." }, "SAME_PASSWORD"],
    [400, { error_code: "email_not_confirmed", msg: "Email not confirmed" }, "EMAIL_NOT_CONFIRMED"],
    [429, { error_code: "over_email_send_rate_limit", msg: "email rate limit exceeded" }, "RATE_LIMITED"],
    [429, {}, "RATE_LIMITED"],
    [422, { error_code: "email_address_invalid", msg: "Email address \"a@b\" is invalid" }, "INVALID_EMAIL"],
    [422, { error_code: "validation_failed", msg: "Unable to validate email address: invalid format" }, "INVALID_EMAIL"],
    [422, { error_code: "signup_disabled", msg: "Signups not allowed for this instance" }, "SIGNUP_DISABLED"],
    [500, {}, "SERVER"],
    [418, { weird: true }, "UNKNOWN"],
  ];
  for (const [status, data, want] of cases) assert.equal(reasonFromError(status, data), want, JSON.stringify([status, data]));
});
test("reasonText: Korean text for every reason, polite, no raw codes", () => {
  for (const r of ["INVALID_CREDENTIALS", "EMAIL_EXISTS", "WEAK_PASSWORD", "INVALID_EMAIL", "EMAIL_NOT_CONFIRMED", "RATE_LIMITED", "SAME_PASSWORD", "SIGNUP_DISABLED", "NETWORK", "TIMEOUT", "NOT_CONFIGURED", "NEED_LOGIN", "SERVER", "UNKNOWN", "SOMETHING_NEW"]) {
    const t = reasonText(r);
    assert.match(t, /[가-힣]/, r);
    assert.ok(!/[A-Z_]{6,}/.test(t), `${r}: ${t}`);
  }
  assert.match(reasonText("INVALID_CREDENTIALS"), /비밀번호/);
  assert.match(reasonText("EMAIL_EXISTS"), /이미 가입/);
  assert.match(reasonText("WEAK_PASSWORD"), /6자 이상/);
  assert.equal(reasonText("NOT_CONFIGURED"), "로그인 서버가 아직 설정되지 않았어요 (관리자 설정 필요)");
});

test("importing the module reads no browser global (getter trap on window/document/localStorage/sessionStorage/location/navigator)", async () => {
  const names = ["window", "document", "localStorage", "sessionStorage", "location", "navigator", "history"];
  const saved = new Map(names.map((n) => [n, Object.getOwnPropertyDescriptor(globalThis, n)]));
  const touched = [];
  for (const n of names) Object.defineProperty(globalThis, n, { configurable: true, get() { touched.push(n); throw new Error("touched " + n + " at import time"); } });
  try {
    const fresh = await import("../public/js/auth.js?trap=" + Date.now()); // 새로 평가된 모듈 (캐시된 것이 아님)
    assert.equal(typeof fresh.nextUrl, "function");
    assert.equal(fresh.needsRefresh({ expires_at: 1000 }, 950), true);
    assert.equal(fresh.nextUrl("?next=%2Freport"), "/report"); // 순수 함수는 브라우저 없이 동작
    assert.deepEqual(touched, []);
  } finally {
    for (const n of names) { const d = saved.get(n); if (d) Object.defineProperty(globalThis, n, d); else delete globalThis[n]; }
  }
});

// ---- 브라우저 흉내 (Map 저장소, 가짜 location·fetch) ------------------------------------
function fakeStorage() {
  const m = new Map();
  return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => void m.set(k, String(v)), removeItem: (k) => void m.delete(k) };
}
const SB = { url: "https://proj.supabase.co", anonKey: "anon-key" };
const nowSec = () => Math.floor(Date.now() / 1000);
const tokens = (over = {}) => ({ access_token: "AT1", refresh_token: "RT1", expires_at: nowSec() + 3000, user: { id: "u1", email: "a@b.c" }, ...over });
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

/** routes: [{match: (url, opts) => bool, reply: (url, opts) => response | throw}] 첫 일치 사용. calls 에 기록 */
function install({ config = { supabase: SB }, routes = [], location } = {}) {
  const calls = [];
  const ls = fakeStorage();
  const ss = fakeStorage();
  globalThis.localStorage = ls;
  globalThis.sessionStorage = ss;
  globalThis.location = location || { origin: "https://rw.example", pathname: "/report", search: "?x=1", href: "https://rw.example/report?x=1" };
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), opts, body: opts.body ? JSON.parse(opts.body) : undefined });
    if (String(url).endsWith("/api/config")) { if (config === null) throw new TypeError("Failed to fetch"); return json(200, config); }
    const r = routes.find((x) => x.match(String(url), opts));
    if (!r) throw new Error("unexpected fetch " + url);
    return r.reply(String(url), opts);
  };
  return { calls, ls, ss, authCalls: () => calls.filter((c) => c.url.includes("/auth/v1/")) };
}
function uninstall() { delete globalThis.localStorage; delete globalThis.sessionStorage; delete globalThis.location; delete globalThis.fetch; }

test("requireLogin goes to /login?next=<current page> and leaves sessionStorage alone", () => {
  const env = install();
  env.ss.setItem("rw_clue", '{"a":1}'); env.ss.setItem("rw_utterance", "아버지가 나가셨어요");
  const guard = new Proxy(env.ss, { get(t, k) { if (["clear", "removeItem", "setItem"].includes(k)) throw new Error("sessionStorage was modified: " + String(k)); return t[k]; } });
  globalThis.sessionStorage = guard;
  try {
    requireLogin();
    assert.equal(globalThis.location.href, "/login?next=" + encodeURIComponent("/report?x=1"));
    assert.equal(env.ss.getItem("rw_clue"), '{"a":1}');
    assert.equal(env.ss.getItem("rw_utterance"), "아버지가 나가셨어요");
    assert.equal(nextUrl("?next=" + encodeURIComponent("/report?x=1")), "/report?x=1"); // 로그인 뒤 같은 화면으로 돌아온다
  } finally { uninstall(); }
});

test("savedEmail / rememberEmail use localStorage rw_email and survive signOut", async () => {
  const env = install({ routes: [{ match: (u) => u.includes("/logout"), reply: () => json(204, null) }] });
  try {
    assert.equal(savedEmail(), "");
    rememberEmail("  Guardian@Example.com ");
    assert.equal(env.ls.getItem("rw_email"), "Guardian@Example.com");
    assert.equal(savedEmail(), "Guardian@Example.com");
    rememberEmail("");
    assert.equal(savedEmail(), "Guardian@Example.com", "empty email does not wipe the remembered one");
    env.ls.setItem("rw_session", JSON.stringify(tokens()));
    env.ls.setItem("rw_profile", '{"honorific":"아버지"}');
    await signOut();
    assert.equal(env.ls.getItem("rw_session"), null);
    assert.equal(env.ls.getItem("rw_email"), "Guardian@Example.com");
    assert.equal(env.ls.getItem("rw_profile"), '{"honorific":"아버지"}');
  } finally { uninstall(); }
});

test("session(): none stored → null without any request", async () => {
  const env = install();
  try { assert.equal(await session(), null); assert.equal(env.calls.length, 0); } finally { uninstall(); }
});

test("session(): fresh token is returned as is (no refresh token leaked to callers)", async () => {
  const env = install();
  env.ls.setItem("rw_session", JSON.stringify(tokens()));
  try {
    const s = await session();
    assert.equal(s.access_token, "AT1");
    assert.deepEqual(s.user, { id: "u1", email: "a@b.c" });
    assert.equal("refresh_token" in s, false);
    assert.equal(env.authCalls().length, 0);
  } finally { uninstall(); }
});

test("session(): token within 60s of expiry is refreshed with the refresh_token grant and stored", async () => {
  const env = install({ routes: [{ match: (u) => u.includes("/auth/v1/token?grant_type=refresh_token"), reply: () => json(200, { access_token: "AT2", refresh_token: "RT2", expires_in: 3600, user: { id: "u1", email: "a@b.c" } }) }] });
  env.ls.setItem("rw_session", JSON.stringify(tokens({ expires_at: nowSec() + 20 })));
  try {
    const s = await session();
    assert.equal(s.access_token, "AT2");
    const c = env.authCalls();
    assert.equal(c.length, 1);
    assert.deepEqual(c[0].body, { refresh_token: "RT1" });
    assert.equal(c[0].opts.headers.apikey, "anon-key");
    assert.equal(JSON.parse(env.ls.getItem("rw_session")).refresh_token, "RT2");
  } finally { uninstall(); }
});

test("session(): two callers at once share one refresh (refresh tokens rotate)", async () => {
  const env = install({ routes: [{ match: (u) => u.includes("grant_type=refresh_token"), reply: async () => { await new Promise((r) => setTimeout(r, 20)); return json(200, { access_token: "AT2", refresh_token: "RT2", expires_in: 3600, user: { id: "u1", email: "a@b.c" } }); } }] });
  env.ls.setItem("rw_session", JSON.stringify(tokens({ expires_at: nowSec() + 5 })));
  try {
    const [a, b] = await Promise.all([session(), session()]);
    assert.equal(a.access_token, "AT2"); assert.equal(b.access_token, "AT2");
    assert.equal(env.authCalls().length, 1);
  } finally { uninstall(); }
});

test("session(): refresh rejected by the server → null and the dead session is removed", async () => {
  const env = install({ routes: [{ match: (u) => u.includes("grant_type=refresh_token"), reply: () => json(400, { error_code: "refresh_token_not_found", msg: "Invalid Refresh Token" }) }] });
  env.ls.setItem("rw_session", JSON.stringify(tokens({ expires_at: nowSec() - 10 })));
  try {
    assert.equal(await session(), null);
    assert.equal(env.ls.getItem("rw_session"), null);
  } finally { uninstall(); }
});

test("session(): network failure on refresh keeps the stored session (null if already expired, still usable if not)", async () => {
  const routes = [{ match: (u) => u.includes("grant_type=refresh_token"), reply: () => { throw new TypeError("Failed to fetch"); } }];
  const env = install({ routes });
  try {
    env.ls.setItem("rw_session", JSON.stringify(tokens({ expires_at: nowSec() - 10 })));
    assert.equal(await session(), null);
    assert.ok(env.ls.getItem("rw_session"), "kept for the next try");
    env.ls.setItem("rw_session", JSON.stringify(tokens({ expires_at: nowSec() + 30 })));
    assert.equal((await session()).access_token, "AT1");
  } finally { uninstall(); }
});

test("session(): refresh rejected because another tab already used the token → adopt that tab's session, do not drop it", async () => {
  const env = install({ routes: [{ match: (u) => u.includes("grant_type=refresh_token"), reply: () => {
    // 다른 탭이 먼저 같은 refresh token 으로 갱신해 저장해 둔 상태에서, 우리 요청은 "이미 쓴 토큰"으로 거부된다
    env.ls.setItem("rw_session", JSON.stringify(tokens({ access_token: "AT7", refresh_token: "RT7", expires_at: nowSec() + 3000 })));
    return json(400, { error_code: "refresh_token_already_used", msg: "Invalid Refresh Token: Already Used" });
  } }] });
  env.ls.setItem("rw_session", JSON.stringify(tokens({ expires_at: nowSec() + 5 })));
  try {
    const s = await session();
    assert.equal(s.access_token, "AT7");
    assert.equal(JSON.parse(env.ls.getItem("rw_session")).refresh_token, "RT7", "the other tab's session is kept");
  } finally { uninstall(); }
});

test("session(): refresh rejected and the stored token is still the one we sent → session dropped", async () => {
  const env = install({ routes: [{ match: (u) => u.includes("grant_type=refresh_token"), reply: () => json(400, { error_code: "refresh_token_already_used" }) }] });
  env.ls.setItem("rw_session", JSON.stringify(tokens({ expires_at: nowSec() + 5 })));
  try {
    assert.equal(await session(), null);
    assert.equal(env.ls.getItem("rw_session"), null);
  } finally { uninstall(); }
});

test("session(): refresh runs inside navigator.locks 'rw_refresh' when available, and re-checks storage once it holds the lock", async () => {
  const orig = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const lockCalls = [];
  const env = install({ routes: [{ match: (u) => u.includes("grant_type=refresh_token"), reply: () => json(200, { access_token: "AT2", refresh_token: "RT2", expires_in: 3600, user: { id: "u1", email: "a@b.c" } }) }] });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks: { request: async (name, fn) => {
    lockCalls.push(name);
    // 잠금을 기다리는 사이 다른 탭이 이미 갱신해 저장했다
    if (lockCalls.length === 2) env.ls.setItem("rw_session", JSON.stringify(tokens({ access_token: "AT5", refresh_token: "RT5", expires_at: nowSec() + 3000 })));
    return fn();
  } } } });
  env.ls.setItem("rw_session", JSON.stringify(tokens({ expires_at: nowSec() + 5 })));
  try {
    assert.equal((await session()).access_token, "AT2");
    assert.deepEqual(lockCalls, ["rw_refresh"]);
    assert.equal(env.authCalls().length, 1);
    // 두 번째: 잠금을 얻은 뒤 보니 다른 탭이 이미 갱신했다 → 요청 없이 그 세션을 쓴다
    env.ls.setItem("rw_session", JSON.stringify(tokens({ access_token: "AT3", refresh_token: "RT3", expires_at: nowSec() + 5 })));
    assert.equal((await session()).access_token, "AT5");
    assert.deepEqual(lockCalls, ["rw_refresh", "rw_refresh"]);
    assert.equal(env.authCalls().length, 1, "no second refresh request");
  } finally { if (orig) Object.defineProperty(globalThis, "navigator", orig); else delete globalThis.navigator; uninstall(); }
});

test("signOut during an in-flight refresh: the late refresh result is not saved (no zombie login)", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const env = install({ routes: [
    { match: (u) => u === "/api/loc", reply: () => json(401, {}) },
    { match: (u) => u.includes("grant_type=refresh_token"), reply: async () => { await gate; return json(200, { access_token: "AT2", refresh_token: "RT2", expires_in: 3600, user: { id: "u1", email: "a@b.c" } }); } },
    { match: (u) => u.includes("/auth/v1/logout"), reply: () => json(204, null) },
  ] });
  env.ls.setItem("rw_session", JSON.stringify(tokens()));
  try {
    const pending = authFetch({ action: "me" }); // 401 → 갱신 시작 (응답을 붙잡아 둠)
    for (let i = 0; i < 50 && !env.authCalls().some((c) => c.url.includes("refresh_token")); i++) await new Promise((r) => setTimeout(r, 5));
    assert.ok(env.authCalls().some((c) => c.url.includes("refresh_token")), "refresh is in flight");
    await signOut();
    assert.equal(env.ls.getItem("rw_session"), null);
    release();
    await pending;
    assert.equal(env.ls.getItem("rw_session"), null, "late refresh result must not bring the session back");
  } finally { uninstall(); }
});

test("signIn: stores the session, returns ok; wrong password → INVALID_CREDENTIALS and nothing stored", async () => {
  let ok = true;
  const env = install({ routes: [{ match: (u) => u.includes("/auth/v1/token?grant_type=password"), reply: () => (ok ? json(200, { access_token: "AT", refresh_token: "RT", expires_in: 3600, user: { id: "u9", email: "x@y.z", identities: [{}] } }) : json(400, { error_code: "invalid_credentials", msg: "Invalid login credentials" })) }] });
  try {
    assert.deepEqual(await signIn("x@y.z", "secret1"), { ok: true });
    assert.equal(env.authCalls()[0].url, "https://proj.supabase.co/auth/v1/token?grant_type=password");
    assert.deepEqual(env.authCalls()[0].body, { email: "x@y.z", password: "secret1" });
    assert.equal(JSON.parse(env.ls.getItem("rw_session")).user.id, "u9");
    env.ls.removeItem("rw_session"); ok = false;
    assert.deepEqual(await signIn("x@y.z", "nope"), { ok: false, reason: "INVALID_CREDENTIALS" });
    assert.equal(env.ls.getItem("rw_session"), null);
  } finally { uninstall(); }
});

test("signUp: ok stores session; existing email → EMAIL_EXISTS; short password → WEAK_PASSWORD", async () => {
  let reply;
  const env = install({ routes: [{ match: (u) => u.endsWith("/auth/v1/signup"), reply: () => reply }] });
  try {
    reply = json(200, { access_token: "AT", refresh_token: "RT", expires_in: 3600, user: { id: "u2", email: "n@e.w" } });
    assert.deepEqual(await signUp("n@e.w", "secret1"), { ok: true });
    assert.equal(JSON.parse(env.ls.getItem("rw_session")).user.email, "n@e.w");
    env.ls.removeItem("rw_session");
    reply = json(422, { error_code: "user_already_exists", msg: "User already registered" });
    assert.deepEqual(await signUp("n@e.w", "secret1"), { ok: false, reason: "EMAIL_EXISTS" });
    reply = json(422, { error_code: "weak_password", msg: "Password should be at least 6 characters." });
    assert.deepEqual(await signUp("n@e.w", "123"), { ok: false, reason: "WEAK_PASSWORD" });
    reply = json(200, { id: "u3", email: "n@e.w", identities: [] }); // 이메일 확인이 켜져 있고 이미 가입된 이메일
    assert.deepEqual(await signUp("n@e.w", "secret1"), { ok: false, reason: "EMAIL_EXISTS" });
    reply = json(200, { id: "u3", email: "n@e.w", identities: [{}] }); // 이메일 확인이 켜져 있어 세션이 아직 없음
    assert.deepEqual(await signUp("n@e.w", "secret1"), { ok: true, confirm: true });
    assert.equal(env.ls.getItem("rw_session"), null);
  } finally { uninstall(); }
});

test("auth calls without Supabase config → NOT_CONFIGURED (no auth request)", async () => {
  const env = install({ config: { ai: {}, supabase: { url: null, anonKey: null } } });
  try {
    assert.deepEqual(await signIn("a@b.c", "secret1"), { ok: false, reason: "NOT_CONFIGURED" });
    assert.equal(env.authCalls().length, 0);
  } finally { uninstall(); }
});

test("Supabase unreachable → NETWORK, request aborted → TIMEOUT, 5xx → SERVER (nothing stored)", async () => {
  let fail;
  const env = install({ routes: [{ match: (u) => u.includes("/auth/v1/"), reply: () => fail() }] });
  try {
    fail = () => { throw new TypeError("Failed to fetch"); };
    assert.deepEqual(await signIn("a@b.c", "secret1"), { ok: false, reason: "NETWORK" });
    assert.deepEqual(await signUp("a@b.c", "secret1"), { ok: false, reason: "NETWORK" });
    fail = () => { const e = new Error("aborted"); e.name = "AbortError"; throw e; };
    assert.deepEqual(await signIn("a@b.c", "secret1"), { ok: false, reason: "TIMEOUT" });
    fail = () => json(502, {});
    assert.deepEqual(await signIn("a@b.c", "secret1"), { ok: false, reason: "SERVER" });
    assert.equal(env.ls.getItem("rw_session"), null);
  } finally { uninstall(); }
});

test("config fetch fails → NETWORK (not 'not configured'); working config is cached for the tab", async () => {
  const env = install({ config: null });
  try {
    assert.deepEqual(await signIn("a@b.c", "secret1"), { ok: false, reason: "NETWORK" });
  } finally { uninstall(); }
  const env2 = install({ routes: [{ match: (u) => u.includes("grant_type=password"), reply: () => json(400, { error_code: "invalid_credentials", msg: "Invalid login credentials" }) }] });
  try {
    await signIn("a@b.c", "x"); await signIn("a@b.c", "y");
    assert.equal(env2.calls.filter((c) => c.url.endsWith("/api/config")).length, 1, "second call reuses the cached config");
  } finally { uninstall(); }
});

test("resetPassword: POST /recover with redirect_to back to /login?reset=1; network failure → reason", async () => {
  let fail = false;
  const env = install({ routes: [{ match: (u) => u.includes("/auth/v1/recover"), reply: () => { if (fail) throw new TypeError("offline"); return json(200, {}); } }] });
  try {
    assert.deepEqual(await resetPassword(" a@b.c "), { ok: true });
    const c = env.authCalls()[0];
    assert.equal(c.url, "https://proj.supabase.co/auth/v1/recover?redirect_to=" + encodeURIComponent("https://rw.example/login?reset=1"));
    assert.deepEqual(c.body, { email: "a@b.c" });
    fail = true;
    assert.deepEqual(await resetPassword("a@b.c"), { ok: false, reason: "NETWORK" });
  } finally { uninstall(); }
});

test("acceptRecoveryLink: tokens from the link become the stored session (user looked up)", async () => {
  const env = install({ routes: [{ match: (u, o) => u.endsWith("/auth/v1/user") && o.method === "GET", reply: (u, o) => (o.headers.Authorization === "Bearer AT" ? json(200, { id: "u1", email: "a@b.c", aud: "x" }) : json(401, {})) }] });
  try {
    const r = await acceptRecoveryLink("#access_token=AT&expires_in=3600&refresh_token=RT&token_type=bearer&type=recovery");
    assert.deepEqual(r, { ok: true });
    const stored = JSON.parse(env.ls.getItem("rw_session"));
    assert.equal(stored.access_token, "AT"); assert.equal(stored.refresh_token, "RT"); assert.deepEqual(stored.user, { id: "u1", email: "a@b.c" });
    assert.deepEqual(await acceptRecoveryLink("#error=access_denied&error_code=otp_expired"), { ok: false, reason: "LINK_EXPIRED" });
    assert.deepEqual(await acceptRecoveryLink(""), { ok: false, reason: "NO_LINK" });
    assert.deepEqual(await acceptRecoveryLink("#access_token=AT&refresh_token=RT&type=signup"), { ok: false, reason: "NO_LINK" }, "only recovery links");
  } finally { uninstall(); }
});

test("recentlyRejected: true only for a fresh marker; cleared by a successful sign in", async () => {
  const env = install({ routes: [{ match: (u) => u.includes("grant_type=password"), reply: () => json(200, { access_token: "AT", refresh_token: "RT", expires_in: 3600, user: { id: "u1", email: "a@b.c" } }) }] });
  try {
    assert.equal(recentlyRejected(), false);
    env.ls.setItem("rw_login_rejected", String(nowSec() - 10));
    assert.equal(recentlyRejected(), true);
    env.ls.setItem("rw_login_rejected", String(nowSec() - 600));
    assert.equal(recentlyRejected(), false);
    env.ls.setItem("rw_login_rejected", String(nowSec()));
    await signIn("a@b.c", "secret1");
    assert.equal(recentlyRejected(), false);
    assert.equal(env.ls.getItem("rw_login_rejected"), null);
  } finally { uninstall(); }
});

test("signOut: local scope by default, global with everywhere; session removed even if the server call fails", async () => {
  const env = install({ routes: [{ match: (u) => u.includes("/auth/v1/logout"), reply: () => { throw new TypeError("offline"); } }] });
  try {
    env.ls.setItem("rw_session", JSON.stringify(tokens()));
    const a = await signOut();
    assert.match(env.authCalls()[0].url, /\/auth\/v1\/logout\?scope=local$/);
    assert.equal(env.authCalls()[0].opts.headers.Authorization, "Bearer AT1");
    assert.equal(env.ls.getItem("rw_session"), null);
    assert.equal(a.revoked, false);
    env.ls.setItem("rw_session", JSON.stringify(tokens()));
    await signOut({ everywhere: true });
    assert.match(env.authCalls()[1].url, /\/auth\/v1\/logout\?scope=global$/);
    assert.equal(env.ls.getItem("rw_session"), null);
  } finally { uninstall(); }
});

test("updatePassword: PUT /auth/v1/user with Bearer; no session → NEED_LOGIN", async () => {
  const env = install({ routes: [{ match: (u, o) => u.endsWith("/auth/v1/user") && o.method === "PUT", reply: () => json(200, { id: "u1", email: "a@b.c" }) }] });
  try {
    assert.deepEqual(await updatePassword("newpass1"), { ok: false, reason: "NEED_LOGIN" });
    env.ls.setItem("rw_session", JSON.stringify(tokens()));
    assert.deepEqual(await updatePassword("newpass1"), { ok: true });
    const c = env.authCalls()[0];
    assert.equal(c.opts.headers.Authorization, "Bearer AT1");
    assert.deepEqual(c.body, { password: "newpass1" });
  } finally { uninstall(); }
});

test("authFetch: POSTs JSON to /api/loc with Bearer; also accepts an explicit path", async () => {
  const env = install({ routes: [{ match: (u) => u.includes("/api/"), reply: () => json(200, { ok: true, items: [] }) }] });
  env.ls.setItem("rw_session", JSON.stringify(tokens()));
  try {
    assert.deepEqual(await authFetch({ action: "me" }), { ok: true, items: [] });
    assert.deepEqual(await authFetch("/api/loc", { action: "me" }), { ok: true, items: [] });
    assert.deepEqual(await authFetch("loc", { action: "me" }), { ok: true, items: [] });
    for (const c of env.calls.filter((x) => x.url.startsWith("/api/loc"))) {
      assert.equal(c.opts.method, "POST");
      assert.equal(c.opts.headers.Authorization, "Bearer AT1");
      assert.deepEqual(c.body, { action: "me" });
    }
    assert.equal(env.calls.filter((x) => x.url === "/api/loc").length, 3);
  } finally { uninstall(); }
});

test("authFetch: 401 → refresh once → retry with the new token", async () => {
  let n = 0;
  const env = install({ routes: [
    { match: (u) => u === "/api/loc", reply: (u, o) => (o.headers.Authorization === "Bearer AT2" ? json(200, { ok: true }) : (n++, json(401, { ok: false, reason: "UNAUTHORIZED" }))) },
    { match: (u) => u.includes("grant_type=refresh_token"), reply: () => json(200, { access_token: "AT2", refresh_token: "RT2", expires_in: 3600, user: { id: "u1", email: "a@b.c" } }) },
  ] });
  env.ls.setItem("rw_session", JSON.stringify(tokens()));
  try {
    assert.deepEqual(await authFetch({ action: "me" }), { ok: true });
    assert.equal(n, 1);
    assert.equal(env.authCalls().length, 1);
    assert.equal(globalThis.location.href, "https://rw.example/report?x=1", "no redirect on success");
  } finally { uninstall(); }
});

test("authFetch: 401 but another tab already refreshed → retry with the stored token, no refresh call", async () => {
  let first = true;
  const env = install({ routes: [{ match: (u) => u === "/api/loc", reply: (u, o) => {
    if (first) { first = false; env.ls.setItem("rw_session", JSON.stringify(tokens({ access_token: "AT9", refresh_token: "RT9", expires_at: nowSec() + 3000 }))); return json(401, {}); }
    return o.headers.Authorization === "Bearer AT9" ? json(200, { ok: true, via: "AT9" }) : json(401, {});
  } }] });
  env.ls.setItem("rw_session", JSON.stringify(tokens()));
  try {
    assert.deepEqual(await authFetch({ action: "me" }), { ok: true, via: "AT9" });
    assert.equal(env.authCalls().length, 0);
  } finally { uninstall(); }
});

test("authFetch: session() is null only because refresh failed transiently → NETWORK, no redirect, no API call", async () => {
  const env = install({ routes: [{ match: (u) => u.includes("grant_type=refresh_token"), reply: () => { throw new TypeError("Failed to fetch"); } }] });
  env.ls.setItem("rw_session", JSON.stringify(tokens({ expires_at: nowSec() - 10 }))); // 만료됨 + 갱신 불가
  try {
    assert.deepEqual(await authFetch({ action: "me" }), { ok: false, reason: "NETWORK" });
    assert.equal(globalThis.location.href, "https://rw.example/report?x=1", "not sent to the login page");
    assert.ok(env.ls.getItem("rw_session"), "session kept");
    assert.equal(env.calls.filter((c) => c.url.startsWith("/api/loc")).length, 0);
  } finally { uninstall(); }
});

test("authFetch: only our own /api/<name> paths — the token never goes to another origin", async () => {
  const env = install({ routes: [{ match: () => true, reply: () => json(200, { ok: true }) }] });
  env.ls.setItem("rw_session", JSON.stringify(tokens()));
  try {
    for (const bad of ["//evil.com/x", "https://evil.com/api/loc", "/api/../x", "/other", "/api/loc?x=1", ""])
      assert.deepEqual(await authFetch(bad, {}), { ok: false, reason: "BAD_PATH" }, bad);
    assert.equal(env.calls.length, 0);
  } finally { uninstall(); }
});

test("authFetch: refresh fails transiently on a 401 → NETWORK, session kept, no redirect", async () => {
  const env = install({ routes: [
    { match: (u) => u === "/api/loc", reply: () => json(401, {}) },
    { match: (u) => u.includes("grant_type=refresh_token"), reply: () => { throw new TypeError("offline"); } },
  ] });
  env.ls.setItem("rw_session", JSON.stringify(tokens()));
  try {
    assert.deepEqual(await authFetch({ action: "me" }), { ok: false, reason: "NETWORK" });
    assert.ok(env.ls.getItem("rw_session"));
    assert.equal(globalThis.location.href, "https://rw.example/report?x=1");
  } finally { uninstall(); }
});

test("authFetch: refresh rejected on a 401 → session removed and sent to login", async () => {
  const env = install({ routes: [
    { match: (u) => u === "/api/loc", reply: () => json(401, {}) },
    { match: (u) => u.includes("grant_type=refresh_token"), reply: () => json(400, { error_code: "refresh_token_not_found" }) },
  ] });
  env.ls.setItem("rw_session", JSON.stringify(tokens()));
  try {
    assert.deepEqual(await authFetch({ action: "me" }), { ok: false, reason: "UNAUTHORIZED" });
    assert.equal(env.ls.getItem("rw_session"), null);
    assert.equal(globalThis.location.href, "/login?next=" + encodeURIComponent("/report?x=1"));
  } finally { uninstall(); }
});

test("authFetch: still 401 after refresh → requireLogin (progress in sessionStorage untouched), session kept", async () => {
  const env = install({ routes: [
    { match: (u) => u === "/api/loc", reply: () => json(401, { ok: false, reason: "UNAUTHORIZED" }) },
    { match: (u) => u.includes("grant_type=refresh_token"), reply: () => json(200, { access_token: "AT2", refresh_token: "RT2", expires_in: 3600, user: { id: "u1", email: "a@b.c" } }) },
  ] });
  env.ls.setItem("rw_session", JSON.stringify(tokens()));
  env.ss.setItem("rw_clue", "{}");
  try {
    const r = await authFetch({ action: "me" });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "UNAUTHORIZED");
    assert.equal(globalThis.location.href, "/login?next=" + encodeURIComponent("/report?x=1"));
    assert.equal(env.ss.getItem("rw_clue"), "{}");
    assert.ok(env.ls.getItem("rw_login_rejected"), "marker so /login does not bounce straight back");
  } finally { uninstall(); }
});

test("authFetch: no session → requireLogin without calling the API", async () => {
  const env = install();
  try {
    const r = await authFetch({ action: "me" });
    assert.deepEqual(r, { ok: false, reason: "NEED_LOGIN" });
    assert.equal(globalThis.location.href, "/login?next=" + encodeURIComponent("/report?x=1"));
    assert.equal(env.calls.filter((c) => c.url.startsWith("/api/loc")).length, 0);
  } finally { uninstall(); }
});

test("authFetch: network failure and server errors come back as {ok:false, reason} without redirect", async () => {
  let mode = "net";
  const env = install({ routes: [{ match: (u) => u === "/api/loc", reply: () => { if (mode === "net") throw new TypeError("Failed to fetch"); return json(503, { ok: false, reason: "SERVER_DOWN" }); } }] });
  env.ls.setItem("rw_session", JSON.stringify(tokens()));
  try {
    assert.deepEqual(await authFetch({ action: "me" }), { ok: false, reason: "NETWORK" });
    mode = "5xx";
    assert.deepEqual(await authFetch({ action: "me" }), { ok: false, reason: "SERVER_DOWN" });
    assert.equal(globalThis.location.href, "https://rw.example/report?x=1");
  } finally { uninstall(); }
});
