import test from "node:test";
import assert from "node:assert/strict";
import { route } from "../api/loc.js";
import { deviceHashOf } from "../lib/family.js";

const U1 = { id: "11111111-1111-4111-8111-111111111111", email: "a@b.c" };
const U2 = { id: "22222222-2222-4222-8222-222222222222", email: "d@e.f" };
const E1 = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const KEY = "ABCDEFGHIJKLMNOP";
const DEV = deviceHashOf(KEY);
const P = { latitude: 37.5, longitude: 127.0, fix_age_ms: 100, gps_time: "2026-11-17T00:00:00Z" };

// 가짜 db: (method, path) 를 기록하고, rules 의 첫 일치 항목으로 답한다
function fakeDb(rules = []) {
  const calls = [];
  const db = async (method, path, body, prefer) => {
    calls.push({ method, path, body, prefer });
    for (const [m, re, out] of rules) {
      if (m === method && re.test(path)) return typeof out === "function" ? out(path, body) : out;
    }
    return method === "GET" ? [] : null;
  };
  db.calls = calls;
  return db;
}
/** 테스트가 바꾼 env 를 원래 값으로 (원래 없었으면 지움) */
const restoreEnv = (k, v) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
const throwingFam = new Proxy({}, { get: () => async () => { throw new Error("fam must not be called"); } });
const membership = (role) => [
  ["GET", new RegExp(`^elder_members\\?elder_id=eq\\.${E1}&user_id=eq\\.${U1.id}`), [{ role }]],
  ["GET", new RegExp(`^elders\\?id=eq\\.${E1}`), [{ device_hash: DEV }]],
];

test("revoked device push → 410 GONE, nothing stored", async () => {
  const db = fakeDb([["GET", /^revoked_devices\?device_hash=eq\./, [{ device_hash: DEV }]]]);
  const r = await route({ action: "push", key: KEY, p: P }, { db, fam: throwingFam });
  assert.equal(r.status, 410);
  assert.deepEqual(r.body, { ok: false, reason: "GONE" });
  assert.ok(db.calls[0].path.includes(DEV));
  assert.ok(!db.calls.some((c) => c.method === "POST"));
});

test("unknown device push → 201 and stored under the hash", async () => {
  const db = fakeDb([["POST", /^loc_events$/, [{ id: 7, received_at: "2026-11-17T00:00:01Z" }]]]);
  const r = await route({ action: "push", key: KEY, p: P }, { db, fam: throwingFam });
  assert.equal(r.status, 201);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.event_id, 7);
  const post = db.calls.find((c) => c.method === "POST");
  assert.equal(post.body.dev, DEV);
});

test("push with bad fix → 422, bad key → 400", async () => {
  const db = fakeDb();
  assert.equal((await route({ action: "push", key: KEY, p: { latitude: 99 } }, { db, fam: throwingFam })).status, 422);
  assert.equal((await route({ action: "push", key: "x", p: P }, { db, fam: throwingFam })).body.reason, "BAD_KEY");
});

test("push store failure → 503 so the phone keeps its queue", async () => {
  const db = async () => { throw Object.assign(new Error("down"), { reason: "STORE_ERROR" }); };
  const r = await route({ action: "push", key: KEY, p: P }, { db, fam: throwingFam });
  assert.equal(r.status, 503);
  assert.equal(r.body.reason, "STORE_ERROR");
});

test("data.load without user → 401 AUTH", async () => {
  const r = await route({ action: "data.load", elderId: E1 }, { db: fakeDb(), fam: throwingFam });
  assert.equal(r.status, 401);
  assert.deepEqual(r.body, { ok: false, reason: "AUTH" });
});

test("Auth unreachable → 503 AUTH_UNAVAILABLE (not 401)", async () => {
  const r = await route({ action: "me" }, { db: fakeDb(), fam: throwingFam, auth: async () => ({ error: "UNAVAILABLE" }) });
  assert.equal(r.status, 503);
  assert.equal(r.body.reason, "AUTH_UNAVAILABLE");
  const r2 = await route({ action: "me" }, { db: fakeDb(), fam: throwingFam, auth: async () => ({ error: "INVALID" }) });
  assert.equal(r2.status, 401);
});

test("auth function resolving to user is used", async () => {
  const fam = { me: async (u) => ({ ok: true, elders: [{ id: E1, label: "엄마", role: "owner", who: u.id }] }) };
  const r = await route({ action: "me" }, { db: fakeDb(), fam, auth: async () => ({ user: U1 }) });
  assert.equal(r.status, 200);
  assert.equal(r.body.elders[0].who, U1.id);
});

test("latest by key without user → limit forced to 1", async () => {
  const db = fakeDb([["GET", /^loc_events\?/, [{ lat: 1, lng: 2 }]]]);
  const r = await route({ action: "latest", key: KEY, limit: 500 }, { db, fam: throwingFam });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  const get = db.calls.find((c) => c.method === "GET" && c.path.startsWith("loc_events"));
  assert.match(get.path, new RegExp(`dev=eq\\.${DEV}`));
  assert.match(get.path, /limit=1$/);
});

test("latest by elderId requires membership", async () => {
  // 로그인 안 함 → 401
  assert.equal((await route({ action: "latest", elderId: E1 }, { db: fakeDb(), fam: throwingFam })).status, 401);
  // member 아님 → 404 GONE, 위치는 읽지 않음
  const db = fakeDb([["GET", /^elders\?/, [{ device_hash: DEV }]]]);
  const r = await route({ action: "latest", elderId: E1, limit: 5 }, { user: U2, db, fam: throwingFam });
  assert.equal(r.status, 404);
  assert.equal(r.body.reason, "GONE");
  assert.ok(!db.calls.some((c) => c.method === "GET" && c.path.startsWith("loc_events")));
  // member → 그 어르신 해시로 읽음, limit 그대로
  const db2 = fakeDb([...membership("member"), ["GET", /^loc_events\?/, [{ lat: 1 }, { lat: 2 }]]]);
  const r2 = await route({ action: "latest", elderId: E1, limit: 5 }, { user: U1, db: db2, fam: throwingFam });
  assert.equal(r2.status, 200);
  assert.equal(r2.body.points.length, 2);
  const get = db2.calls.find((c) => c.method === "GET" && c.path.startsWith("loc_events"));
  assert.match(get.path, new RegExp(`dev=eq\\.${DEV}.*limit=5$`));
});

test("member whose elder is gone → 404 GONE", async () => {
  const db = fakeDb([membership("member")[0]]);
  const r = await route({ action: "places", elderId: E1 }, { user: U1, db, fam: throwingFam });
  assert.equal(r.status, 404);
  assert.equal(r.body.reason, "GONE");
});

test("latest with key and logged-in elderId takes elderId path; malformed elderId → 400", async () => {
  // key 와 유효한 elderId 를 같이 보내면 key 는 무시되고 member 확인 → 그 어르신 해시로 여러 개(limit 기본 200)
  const OTHER = "QRSTUVWXYZ234567";
  const db = fakeDb([...membership("member"), ["GET", /^loc_events\?/, [{ lat: 1, lng: 2 }]]]);
  const ok = await route({ action: "latest", key: OTHER, elderId: E1 }, { user: U1, db, fam: throwingFam });
  assert.equal(ok.status, 200);
  assert.ok(db.calls.some((c) => c.path.startsWith(`elder_members?elder_id=eq.${E1}&user_id=eq.${U1.id}`)), "membership checked");
  const get = db.calls.find((c) => c.method === "GET" && c.path.startsWith("loc_events?dev"));
  assert.match(get.path, new RegExp(`dev=eq\\.${DEV}.*limit=200$`));
  assert.ok(!db.calls.some((c) => c.path.includes(deviceHashOf(OTHER))), "key's hash never read");
  // 로그인 안 했으면 key+elderId 도 key 흐름(마지막 1개)으로 가지 않는다 → 401
  assert.equal((await route({ action: "latest", key: OTHER, elderId: E1 }, { db: fakeDb(), fam: throwingFam })).status, 401);
  const r = await route({ action: "latest", key: KEY, elderId: "nope" }, { user: U1, db: fakeDb(), fam: throwingFam });
  assert.equal(r.status, 400);
  assert.equal(r.body.reason, "BAD_INPUT");
});

test("places by elderId (member) computes from that elder's points only", async () => {
  const db = fakeDb([...membership("member"), ["GET", /^loc_events\?/, []]]);
  const r = await route({ action: "places", elderId: E1 }, { user: U1, db, fam: throwingFam });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.places));
  assert.ok(db.calls.filter((c) => c.path.startsWith("loc_events?dev")).every((c) => c.path.includes(DEV)));
  assert.ok(db.calls.some((c) => c.method === "DELETE" && /^loc_events\?received_at=lt\./.test(c.path)), "30-day purge kept");
});

test("places/clear by key alone no longer work without login", async () => {
  assert.equal((await route({ action: "places", key: KEY }, { db: fakeDb(), fam: throwingFam })).status, 401);
  assert.equal((await route({ action: "clear", key: KEY }, { db: fakeDb(), fam: throwingFam })).status, 401);
});

test("clear is owner only", async () => {
  const db = fakeDb(membership("member"));
  const r = await route({ action: "clear", elderId: E1 }, { user: U1, db, fam: throwingFam });
  assert.equal(r.status, 403);
  assert.equal(r.body.reason, "NOT_OWNER");
  assert.ok(!db.calls.some((c) => c.method === "DELETE" && c.path.startsWith("loc_events?dev")));
  const db2 = fakeDb(membership("owner"));
  const r2 = await route({ action: "clear", elderId: E1 }, { user: U1, db: db2, fam: throwingFam });
  assert.equal(r2.status, 200);
  assert.ok(db2.calls.some((c) => c.method === "DELETE" && c.path === `loc_events?dev=eq.${DEV}`));
});

test("unknown action → 400 BAD_ACTION", async () => {
  const r = await route({ action: "nope" }, { db: fakeDb(), fam: throwingFam });
  assert.equal(r.status, 400);
  assert.equal(r.body.reason, "BAD_ACTION");
  assert.equal((await route(null, { db: fakeDb(), fam: throwingFam })).body.reason, "BAD_ACTION");
});

test("family actions pass the right arguments", async () => {
  const seen = {};
  const rec = (name, out = { ok: true }) => async (...a) => { seen[name] = a; return out; };
  const fam = {
    createElder: rec("createElder", { ok: true, elder: { id: E1 }, deviceCode: KEY }),
    load: rec("load", { ok: true, data: { profile: null } }),
    save: rec("save", { ok: true, updated_at: "t" }),
    inviteCreate: rec("inviteCreate", { ok: true, token: "tok" }),
    inviteAccept: rec("inviteAccept", { ok: true, elderId: E1 }),
    members: rec("members", { ok: true, members: [] }),
    removeMember: rec("removeMember"),
    leave: rec("leave", { ok: true, deleted: true }),
    deleteElder: rec("deleteElder"),
    resetDevice: rec("resetDevice", { ok: true, deviceCode: KEY }),
    importDevice: rec("importDevice"),
  };
  const ctx = { user: U1, db: fakeDb(), fam };
  assert.equal((await route({ action: "elder.create", label: "엄마" }, ctx)).body.deviceCode, KEY);
  assert.deepEqual(seen.createElder, [U1, { label: "엄마" }]);
  await route({ action: "data.load", elderId: E1 }, ctx);
  assert.deepEqual(seen.load, [U1, E1]);
  await route({ action: "data.save", elderId: E1, diary: [1], base: "b", extra: 1 }, ctx);
  assert.deepEqual(seen.save, [U1, E1, { profile: undefined, diary: [1], incidents: undefined, base: "b" }]);
  await route({ action: "invite.create", elderId: E1 }, ctx);
  assert.deepEqual(seen.inviteCreate, [U1, E1]);
  await route({ action: "invite.accept", token: "tok" }, ctx);
  assert.deepEqual(seen.inviteAccept, [U1, "tok"]);
  await route({ action: "members.list", elderId: E1 }, ctx);
  assert.deepEqual(seen.members, [U1, E1]);
  await route({ action: "members.remove", elderId: E1, userId: U2.id }, ctx);
  assert.deepEqual(seen.removeMember, [U1, E1, U2.id]);
  assert.equal((await route({ action: "elder.leave", elderId: E1 }, ctx)).body.deleted, true);
  await route({ action: "elder.delete", elderId: E1 }, ctx);
  assert.deepEqual(seen.deleteElder, [U1, E1]);
  await route({ action: "device.reset", elderId: E1 }, ctx);
  assert.deepEqual(seen.resetDevice, [U1, E1]);
  await route({ action: "device.import", elderId: E1, key: KEY }, ctx);
  assert.deepEqual(seen.importDevice, [U1, E1, KEY]);
});

test("family reasons map to HTTP status", async () => {
  const cases = { BAD_INPUT: 400, GONE: 404, NOT_OWNER: 403, INVITE_USED: 409, INVITE_EXPIRED: 409, INVITE_NOT_FOUND: 400,
    DEVICE_TAKEN: 409, DEVICE_REVOKED: 409, USE_LEAVE: 400, NO_SUCH_MEMBER: 409 };
  for (const [reason, status] of Object.entries(cases)) {
    const r = await route({ action: "data.load", elderId: E1 }, { user: U1, db: fakeDb(), fam: { load: async () => ({ ok: false, reason }) } });
    assert.equal(r.status, status, reason);
    assert.deepEqual(r.body, { ok: false, reason });
  }
  const c = await route({ action: "data.save", elderId: E1 }, { user: U1, db: fakeDb(), fam: { save: async () => ({ ok: false, reason: "CONFLICT", data: { diary: [] } }) } });
  assert.equal(c.status, 409);
  assert.deepEqual(c.body.data, { diary: [] });
});

test("store error thrown by family → 503 STORE_ERROR; no store → 503 NO_STORE", async () => {
  const fam = { me: async () => { throw Object.assign(new Error("x"), { reason: "STORE_ERROR" }); } };
  const r = await route({ action: "me" }, { user: U1, db: fakeDb(), fam });
  assert.equal(r.status, 503);
  assert.deepEqual(r.body, { ok: false, reason: "STORE_ERROR" });
  const r2 = await route({ action: "me" }, { user: U1, db: fakeDb(), fam: throwingFam, storeReady: false });
  assert.equal(r2.status, 503);
  assert.equal(r2.body.reason, "NO_STORE");
  // 로그인 확인이 먼저: 저장소가 없어도 토큰 없으면 AUTH
  const r3 = await route({ action: "me" }, { db: fakeDb(), fam: throwingFam, storeReady: false });
  assert.equal(r3.body.reason, "AUTH");
});

test("account.withdraw: family withdraw then Auth delete; Auth failure → 503 after data is gone", async () => {
  const order = [];
  const fam = { withdraw: async (u) => { order.push("fam:" + u.id); return { ok: true, deleteAuthUser: true }; } };
  const ok = await route({ action: "account.withdraw" }, { user: U1, db: fakeDb(), fam, deleteAuthUser: async (id) => { order.push("auth:" + id); } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { ok: true });
  assert.deepEqual(order, ["fam:" + U1.id, "auth:" + U1.id]);
  const bad = await route({ action: "account.withdraw" }, { user: U1, db: fakeDb(), fam, deleteAuthUser: async () => { throw new Error("down"); } });
  assert.equal(bad.status, 503);
  assert.equal(bad.body.reason, "AUTH_DELETE_FAILED");
  // family 쪽이 실패하면 Auth 는 지우지 않는다
  let called = false;
  const famFail = { withdraw: async () => ({ ok: false, reason: "NOT_OWNER" }) };
  const r = await route({ action: "account.withdraw" }, { user: U1, db: fakeDb(), fam: famFail, deleteAuthUser: async () => { called = true; } });
  assert.equal(r.status, 403);
  assert.equal(called, false);
});

test("default Auth admin delete calls DELETE /auth/v1/admin/users/{id} with service_role", async () => {
  const { deleteAuthUser } = await import("../api/loc.js");
  const prev = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
  process.env.SUPABASE_URL = "https://x.supabase.co/";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "srv";
  let seen;
  try {
    await deleteAuthUser(U1.id, async (url, o) => { seen = { url, o }; return { ok: true, status: 200 }; });
    assert.equal(seen.url, `https://x.supabase.co/auth/v1/admin/users/${U1.id}`);
    assert.equal(seen.o.method, "DELETE");
    assert.equal(seen.o.headers.apikey, "srv");
    assert.equal(seen.o.headers.Authorization, "Bearer srv");
    await deleteAuthUser(U1.id, async () => ({ ok: false, status: 404 }));   // 이미 없음 → 성공 취급 (다시 시도 안전)
    await assert.rejects(deleteAuthUser(U1.id, async () => ({ ok: false, status: 500 })));
  } finally {
    restoreEnv("SUPABASE_URL", prev.url);
    restoreEnv("SUPABASE_SERVICE_ROLE_KEY", prev.key);
  }
});

test("restoreEnv puts back a pre-existing value instead of deleting it", async () => {
  const { deleteAuthUser } = await import("../api/loc.js");
  const before = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
  process.env.SUPABASE_URL = "https://keep.example/";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "keep";
  try {
    // 위 테스트와 같은 save/restore 를 한 번 더 — 끝나면 원래 값이 남아 있어야 한다
    const prev = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
    process.env.SUPABASE_URL = "https://x.supabase.co/";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "srv";
    try { await deleteAuthUser(U1.id, async () => ({ ok: true, status: 200 })); }
    finally { restoreEnv("SUPABASE_URL", prev.url); restoreEnv("SUPABASE_SERVICE_ROLE_KEY", prev.key); }
    assert.equal(process.env.SUPABASE_URL, "https://keep.example/");
    assert.equal(process.env.SUPABASE_SERVICE_ROLE_KEY, "keep");
  } finally {
    restoreEnv("SUPABASE_URL", before.url);
    restoreEnv("SUPABASE_SERVICE_ROLE_KEY", before.key);
  }
});

// ---------------------------------------------------------------- handler: Origin 규칙 (가짜 req/res)
// push 만 Origin 없이 받는다(앱은 브라우저가 아님). 나머지는 우리 앱 Origin 이 아니면 403. 호출량 제한이 먼저.
function fakeReq(body, headers = {}) {
  return { method: "POST", headers: { "x-forwarded-for": "10.0.0.1", ...headers }, body, socket: {} };
}
function fakeRes() {
  const res = { statusCode: 0, headers: {}, body: undefined };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.end = (s) => { res.body = JSON.parse(s); };
  return res;
}
let ipN = 0;
const freshIp = () => `10.1.${Math.floor(++ipN / 250)}.${ipN % 250}`;   // 테스트마다 다른 IP (분당 제한이 섞이지 않게)

test("handler: push works without Origin (not 403)", async () => {
  const { default: handler } = await import("../api/loc.js");
  const res = fakeRes();
  await handler(fakeReq({ action: "push", key: KEY, p: P }, { "x-forwarded-for": freshIp() }), res);
  assert.notEqual(res.statusCode, 403);
  assert.notEqual(res.body.reason, "FORBIDDEN");
});

test("handler: non-push actions without an allowed Origin → 403 FORBIDDEN", async () => {
  const { default: handler } = await import("../api/loc.js");
  for (const [body, headers] of [
    [{ action: "me" }, {}],
    [{ action: "latest", key: KEY }, {}],
    [{ action: "device.import", elderId: E1, key: KEY }, { origin: "https://evil.example" }],
    [{ action: "places", elderId: E1 }, { referer: "https://evil.example/x" }],
  ]) {
    const res = fakeRes();
    await handler(fakeReq(body, { "x-forwarded-for": freshIp(), ...headers }), res);
    assert.equal(res.statusCode, 403, JSON.stringify(body));
    assert.equal(res.body.reason, "FORBIDDEN");
  }
  // 우리 앱 Origin 이면 통과 (토큰이 없으니 401 AUTH — Origin 검사 다음 단계까지 감)
  const res = fakeRes();
  await handler(fakeReq({ action: "me" }, { "x-forwarded-for": freshIp(), origin: "https://rememberway.vercel.app" }), res);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.reason, "AUTH");
});

test("handler: rate limit runs before the Origin check", async () => {
  const { default: handler } = await import("../api/loc.js");
  const ip = freshIp();
  let last;
  for (let i = 0; i < 25; i++) {   // 분당 20회 넘김
    last = fakeRes();
    await handler(fakeReq({ action: "me" }, { "x-forwarded-for": ip }), last);
  }
  assert.equal(last.statusCode, 429);
  assert.equal(last.body.reason, "RATE_LIMIT");
});
