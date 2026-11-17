import test from "node:test";
import assert from "node:assert/strict";
import { userFromToken, bearer } from "../lib/auth.js";

/** 테스트가 바꾸는 env 를 저장했다가 원래 값으로 (원래 없었으면 지움) — delete 로 남의 설정을 날리지 않게 */
const saveEnv = (...keys) => Object.fromEntries(keys.map((k) => [k, process.env[k]]));
const restoreEnv = (saved) => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };

test("SUPABASE_URL missing → falls back to NEXT_PUBLIC_SUPABASE_URL (same as lib/kv.js)", async () => {
  const prev = saveEnv("SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL");
  delete process.env.SUPABASE_URL;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://pub.supabase.co/";
  let url;
  try {
    await userFromToken("tok", async (u) => { url = u; return { ok: true, json: async () => ({ id: "u1" }) }; });
  } finally { restoreEnv(prev); }
  assert.equal(url, "https://pub.supabase.co/auth/v1/user");
});

test("env helpers restore a pre-existing value instead of deleting it", () => {
  const outer = saveEnv("SUPABASE_URL");
  process.env.SUPABASE_URL = "https://keep.example";
  const prev = saveEnv("SUPABASE_URL");
  process.env.SUPABASE_URL = "https://tmp.example";
  restoreEnv(prev);
  assert.equal(process.env.SUPABASE_URL, "https://keep.example");
  restoreEnv(outer);
});

test("valid token → user", async () => {
  const f = async (url, o) => ({ ok: true, json: async () => ({ id: "u1", email: "a@b.c" }) });
  assert.deepEqual(await userFromToken("t", f), { id: "u1", email: "a@b.c" });
});
test("401 → null", async () => assert.equal(await userFromToken("t", async () => ({ ok: false, status: 401 })), null));
test("empty token → null without fetch", async () => assert.equal(await userFromToken("", () => { throw 1; }), null));
test("bearer parses header", () => assert.equal(bearer({ headers: { authorization: "Bearer abc" } }), "abc"));

test("calls Supabase /auth/v1/user with apikey and bearer token (env read at call time)", async () => {
  const prev = saveEnv("SUPABASE_URL", "SUPABASE_ANON_KEY");
  process.env.SUPABASE_URL = "https://x.supabase.co/";
  process.env.SUPABASE_ANON_KEY = "anon-key";
  let seen;
  const f = async (url, o) => { seen = { url, o }; return { ok: true, json: async () => ({ id: "u1", email: "a@b.c" }) }; };
  try { await userFromToken("tok", f); } finally { restoreEnv(prev); }
  assert.equal(seen.url, "https://x.supabase.co/auth/v1/user");
  assert.equal(seen.o.headers.apikey, "anon-key");
  assert.equal(seen.o.headers.Authorization, "Bearer tok");
  assert.ok(seen.o.signal);
});
test("fetch throws → null", async () => assert.equal(await userFromToken("t", async () => { throw new Error("net"); }), null));
test("response without id → null", async () => assert.equal(await userFromToken("t", async () => ({ ok: true, json: async () => ({}) })), null));
test("bearer missing or malformed → null", () => {
  assert.equal(bearer({ headers: {} }), null);
  assert.equal(bearer({}), null);
  assert.equal(bearer({ headers: { authorization: "Basic abc" } }), null);
  assert.equal(bearer({ headers: { authorization: "Bearer " } }), null);
});

// ---- checkToken: 무효 토큰(INVALID → 401)과 Auth 장애(UNAVAILABLE → 503)를 구분 ----
import { checkToken } from "../lib/auth.js";
test("checkToken: valid → {user}", async () => {
  const f = async () => ({ ok: true, status: 200, json: async () => ({ id: "u1", email: "a@b.c" }) });
  assert.deepEqual(await checkToken("t", f), { user: { id: "u1", email: "a@b.c" } });
});
test("checkToken: missing token → INVALID without fetch", async () => {
  assert.deepEqual(await checkToken("", () => { throw 1; }), { error: "INVALID" });
  assert.deepEqual(await checkToken(null, () => { throw 1; }), { error: "INVALID" });
});
test("checkToken: 401/403/400 → INVALID", async () => {
  for (const status of [400, 401, 403]) assert.deepEqual(await checkToken("t", async () => ({ ok: false, status })), { error: "INVALID" }, String(status));
});
test("checkToken: network error, timeout, 5xx, 429, bad body → UNAVAILABLE", async () => {
  assert.deepEqual(await checkToken("t", async () => { throw new Error("net"); }), { error: "UNAVAILABLE" });
  for (const status of [429, 500, 502, 503]) assert.deepEqual(await checkToken("t", async () => ({ ok: false, status })), { error: "UNAVAILABLE" }, String(status));
  assert.deepEqual(await checkToken("t", async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("x"); } })), { error: "UNAVAILABLE" });
  assert.deepEqual(await checkToken("t", async () => ({ ok: true, status: 200, json: async () => ({}) })), { error: "UNAVAILABLE" });
});

test("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY are accepted as fallbacks (server token check + /api/config)", async () => {
  const prev = saveEnv("SUPABASE_URL", "SUPABASE_ANON_KEY", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY");
  delete process.env.SUPABASE_URL; delete process.env.SUPABASE_ANON_KEY;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://np.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "np-anon";
  let seen;
  try {
    await userFromToken("tok", async (url, o) => { seen = { url, o }; return { ok: true, json: async () => ({ id: "u1" }) }; });
    const { supabasePublic } = await import("../api/config.js");
    assert.deepEqual(supabasePublic(), { url: "https://np.supabase.co", anonKey: "np-anon" });
    assert.deepEqual(supabasePublic({ SUPABASE_URL: "a", NEXT_PUBLIC_SUPABASE_URL: "b", SUPABASE_ANON_KEY: "c", NEXT_PUBLIC_SUPABASE_ANON_KEY: "d" }), { url: "a", anonKey: "c" });
    assert.deepEqual(supabasePublic({}), { url: null, anonKey: null });
  } finally { restoreEnv(prev); }
  assert.equal(seen.url, "https://np.supabase.co/auth/v1/user");
  assert.equal(seen.o.headers.apikey, "np-anon");
});
