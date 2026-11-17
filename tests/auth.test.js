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
