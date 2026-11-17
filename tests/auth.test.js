import test from "node:test";
import assert from "node:assert/strict";
import { userFromToken, bearer } from "../lib/auth.js";

test("valid token → user", async () => {
  const f = async (url, o) => ({ ok: true, json: async () => ({ id: "u1", email: "a@b.c" }) });
  assert.deepEqual(await userFromToken("t", f), { id: "u1", email: "a@b.c" });
});
test("401 → null", async () => assert.equal(await userFromToken("t", async () => ({ ok: false, status: 401 })), null));
test("empty token → null without fetch", async () => assert.equal(await userFromToken("", () => { throw 1; }), null));
test("bearer parses header", () => assert.equal(bearer({ headers: { authorization: "Bearer abc" } }), "abc"));

test("calls Supabase /auth/v1/user with apikey and bearer token (env read at call time)", async () => {
  process.env.SUPABASE_URL = "https://x.supabase.co/";
  process.env.SUPABASE_ANON_KEY = "anon-key";
  let seen;
  const f = async (url, o) => { seen = { url, o }; return { ok: true, json: async () => ({ id: "u1", email: "a@b.c" }) }; };
  await userFromToken("tok", f);
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_ANON_KEY;
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
