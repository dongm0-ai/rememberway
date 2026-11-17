import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { familyApi, deviceHashOf } from "../lib/family.js";

// ---- 메모리 가짜 PostgREST db: lib/family.js 가 쓰는 부분집합만 (eq./lt./gt./is.null/in., select, order, limit) ----
const PK = {
  elders: ["id"], elder_members: ["elder_id", "user_id"], elder_data: ["elder_id"],
  invites: ["token_hash"], revoked_devices: ["device_hash"], loc_events: ["id"],
};
const UNIQUE = { elders: [["device_hash"]] };
const TS = new Set(["created_at", "last_seen", "joined_at", "updated_at", "expires_at", "used_at", "revoked_at", "received_at"]);
// Postgres 가 timestamptz 를 돌려주는 모양 (우리가 보낸 "Z" 문자열과 다르다 → 코드는 문자열 비교에 기대면 안 됨)
const pgTs = (v) => (v == null ? v : new Date(v).toISOString().replace("Z", "000+00:00"));

function fakeDb() {
  const t = { elders: [], elder_members: [], elder_data: [], invites: [], revoked_devices: [], loc_events: [] };
  const calls = [];
  const norm = (table, row) => {
    const r = { ...row };
    for (const k of Object.keys(r)) if (TS.has(k)) r[k] = pgTs(r[k]);
    return r;
  };
  const cmp = (k, a, b) => (TS.has(k) && a != null && b != null ? Date.parse(a) - Date.parse(b) : a < b ? -1 : a > b ? 1 : 0);
  function parse(path) {
    const [table, qs = ""] = path.split("?");
    if (!(table in t)) throw Object.assign(new Error("no table " + table), { reason: "NO_TABLE" });
    const filters = [], opts = {};
    for (const part of qs.split("&").filter(Boolean)) {
      const i = part.indexOf("=");
      const k = decodeURIComponent(part.slice(0, i)), raw = part.slice(i + 1);
      if (k === "select" || k === "order" || k === "limit") { opts[k] = decodeURIComponent(raw); continue; }
      const d = raw.indexOf(".");
      const op = raw.slice(0, d), v = decodeURIComponent(raw.slice(d + 1).replace(/\+/g, " "));   // 쿼리 문자열의 "+" 는 공백
      if (!["eq", "lt", "gt", "is", "in"].includes(op)) throw new Error("fake db: unsupported op " + op);
      if (op === "is" && v !== "null") throw new Error("fake db: only is.null");
      if (/[&?=]/.test(v) && op !== "in") throw new Error("fake db: suspicious value " + v);
      filters.push({ k, op, v });
    }
    return { table, filters, opts };
  }
  const match = (row, { k, op, v }) => {
    if (op === "is") return row[k] == null;
    if (op === "in") return v.replace(/^\(|\)$/g, "").split(",").includes(String(row[k]));
    if (row[k] == null) return false;
    const c = cmp(k, row[k], v);
    return op === "eq" ? (TS.has(k) ? c === 0 : String(row[k]) === v) : op === "lt" ? c < 0 : c > 0;
  };
  const project = (rows, select) => {
    if (!select || select === "*") return rows.map((r) => ({ ...r }));
    const cols = select.split(",");
    return rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c] ?? null])));
  };
  const dupe = (table, row, except) => {
    const keys = [PK[table], ...(UNIQUE[table] ?? [])];
    return t[table].some((o) => o !== except && keys.some((ks) => ks.every((k) => row[k] != null && o[k] === row[k])));
  };
  async function db(method, path, body, prefer) {
    calls.push({ method, path, body, prefer });
    const { table, filters, opts } = parse(path);
    const sel = () => t[table].filter((r) => filters.every((f) => match(r, f)));
    const repr = (prefer ?? "").includes("return=representation");
    if (method === "GET") {
      let rows = sel();
      if (opts.order) {
        for (const o of opts.order.split(",").reverse()) {
          const [k, dir = "asc"] = o.split(".");
          rows = [...rows].sort((a, b) => (dir === "desc" ? -1 : 1) * cmp(k, a[k], b[k]));
        }
      }
      if (opts.limit) rows = rows.slice(0, Number(opts.limit));
      return project(rows, opts.select);
    }
    if (method === "POST") {
      const out = [];
      for (const raw of Array.isArray(body) ? body : [body]) {
        const row = norm(table, raw);
        if (dupe(table, row)) {
          if ((prefer ?? "").includes("resolution=ignore-duplicates")) continue;
          throw Object.assign(new Error("duplicate key " + table), { reason: "STORE_ERROR" });
        }
        t[table].push(row); out.push({ ...row });
      }
      return repr ? out : null;
    }
    if (method === "PATCH") {
      const rows = sel(), patch = norm(table, body);
      for (const r of rows) {
        if (dupe(table, { ...r, ...patch }, r)) throw Object.assign(new Error("duplicate key " + table), { reason: "STORE_ERROR" });
      }
      for (const r of rows) Object.assign(r, patch);
      return repr ? rows.map((r) => ({ ...r })) : null;
    }
    if (method === "DELETE") {
      const gone = sel();
      t[table] = t[table].filter((r) => !gone.includes(r));
      if (table === "elders") {   // on delete cascade
        const ids = new Set(gone.map((r) => r.id));
        for (const c of ["elder_members", "elder_data", "invites"]) t[c] = t[c].filter((r) => !ids.has(r.elder_id));
      }
      return repr ? gone : null;
    }
    throw new Error("fake db: method " + method);
  }
  return { db, t, calls };
}

function setup() {
  const f = fakeDb();
  let clock = Date.parse("2026-11-17T00:00:00.000Z");
  let n = 0;
  const api = familyApi({ db: f.db, now: () => new Date(clock), randomToken: () => "tok" + ++n });
  return { ...f, api, tick: (ms) => (clock += ms) };
}
const A = { id: "11111111-1111-4111-8111-111111111111", email: "a@x.kr" };
const B = { id: "22222222-2222-4222-8222-222222222222", email: "b@x.kr" };
const C = { id: "33333333-3333-4333-8333-333333333333", email: "c@x.kr" };

async function withMember() {
  const s = setup();
  const { elder, deviceCode } = await s.api.createElder(A, { label: "어머니" });
  s.tick(1000);
  const inv = await s.api.inviteCreate(A, elder.id);
  s.tick(1000);
  const acc = await s.api.inviteAccept(B, inv.token);
  assert.equal(acc.ok, true);
  return { ...s, elder, deviceCode };
}

// ---------------------------------------------------------------- 테스트
test("deviceHashOf matches old devOf for same code", () => {
  const devOf = (key) => createHash("sha256").update("rw-loc:" + key).digest("hex").slice(0, 32);
  assert.equal(deviceHashOf("ABCDEFGHIJKLMNOP"), devOf("ABCDEFGHIJKLMNOP"));
  assert.equal(deviceHashOf("ABCDEFGHIJKLMNOP").length, 32);
});

test("owner creates elder, member cannot load other elder", async () => {
  const s = setup();
  const r = await s.api.createElder(A, { label: "  어머니 " });
  assert.equal(r.ok, true);
  assert.deepEqual(r.elder, { id: r.elder.id, label: "어머니", role: "owner" });
  assert.match(r.deviceCode, /^[A-Z2-7]{16}$/);
  // 서버엔 해시만
  assert.equal(s.t.elders[0].device_hash, deviceHashOf(r.deviceCode));
  assert.ok(!JSON.stringify(s.t).includes(r.deviceCode));
  // 바로 load 가능 (elder_data 행이 있음)
  const l = await s.api.load(A, r.elder.id);
  assert.equal(l.ok, true);
  assert.deepEqual({ ...l.data, updated_at: null }, { profile: null, diary: [], incidents: [], updated_at: null });
  assert.ok(l.data.updated_at);
  const me = await s.api.me(A);
  assert.deepEqual(me, { ok: true, elders: [{ id: r.elder.id, label: "어머니", role: "owner" }] });
  // B 는 member 아님
  assert.deepEqual(await s.api.load(B, r.elder.id), { ok: false, reason: "NOT_MEMBER" });
  assert.deepEqual(await s.api.save(B, r.elder.id, { profile: { x: 1 }, base: l.data.updated_at }), { ok: false, reason: "NOT_MEMBER" });
  assert.deepEqual(await s.api.inviteCreate(B, r.elder.id), { ok: false, reason: "NOT_MEMBER" });
  assert.deepEqual(await s.api.members(B, r.elder.id), { ok: false, reason: "NOT_MEMBER" });
  assert.deepEqual(await s.api.leave(B, r.elder.id), { ok: false, reason: "NOT_MEMBER" });
  assert.deepEqual(await s.api.deleteElder(B, r.elder.id), { ok: false, reason: "NOT_MEMBER" });
  assert.deepEqual(await s.api.me(B), { ok: true, elders: [] });
  assert.equal(s.t.elder_data[0].profile, null);
});

test("bad label and malformed ids are rejected without touching other rows", async () => {
  const s = setup();
  assert.deepEqual(await s.api.createElder(A, { label: "" }), { ok: false, reason: "BAD_INPUT" });
  assert.deepEqual(await s.api.createElder(A, {}), { ok: false, reason: "BAD_INPUT" });
  const { elder } = await s.api.createElder(A, { label: "아버지" });
  // PostgREST 경로 주입 시도: elder_id 에 필터를 덧붙이기
  for (const bad of [`${elder.id}&user_id=eq.${B.id}`, "x", "", null, 7]) {
    assert.deepEqual(await s.api.load(B, bad), { ok: false, reason: "BAD_INPUT" });
  }
  assert.deepEqual(await s.api.load({ id: "nope&x=1" }, elder.id), { ok: false, reason: "BAD_INPUT" });
  assert.deepEqual(await s.api.me(null), { ok: false, reason: "BAD_INPUT" });
});

test("save with current base → ok, updated_at advances", async () => {
  const s = setup();
  const { elder } = await s.api.createElder(A, { label: "어머니" });
  const l = await s.api.load(A, elder.id);
  const sv = await s.api.save(A, elder.id, { profile: { dong: "가좌동" }, diary: [{ d: "2026-11-17" }], base: l.data.updated_at });
  assert.equal(sv.ok, true);
  assert.ok(Date.parse(sv.updated_at) > Date.parse(l.data.updated_at), "advances even within the same millisecond");
  const l2 = await s.api.load(A, elder.id);
  assert.deepEqual(l2.data.profile, { dong: "가좌동" });
  assert.deepEqual(l2.data.diary, [{ d: "2026-11-17" }]);
  assert.deepEqual(l2.data.incidents, []);   // 안 보낸 칸은 그대로
  assert.equal(l2.data.updated_at, sv.updated_at);
  // 받은 updated_at 을 base 로 다시 저장 → ok
  s.tick(5);
  const sv2 = await s.api.save(A, elder.id, { incidents: [{ k: 1 }], base: sv.updated_at });
  assert.equal(sv2.ok, true);
  assert.deepEqual((await s.api.load(A, elder.id)).data.profile, { dong: "가좌동" });
  // 잘못된 모양
  assert.deepEqual(await s.api.save(A, elder.id, { diary: "x", base: sv2.updated_at }), { ok: false, reason: "BAD_INPUT" });
  assert.deepEqual(await s.api.save(A, elder.id, { base: sv2.updated_at }), { ok: false, reason: "BAD_INPUT" });
});

test("save with stale base → CONFLICT with server data", async () => {
  const s = await withMember();
  const id = s.elder.id;
  const base = (await s.api.load(A, id)).data.updated_at;
  s.tick(10);
  const b = await s.api.save(B, id, { profile: { by: "B" }, base });
  assert.equal(b.ok, true);
  s.tick(10);
  const a = await s.api.save(A, id, { profile: { by: "A" }, base });   // A 는 옛 base
  assert.equal(a.ok, false);
  assert.equal(a.reason, "CONFLICT");
  assert.deepEqual(a.data.profile, { by: "B" });
  assert.equal(a.data.updated_at, b.updated_at);
  assert.deepEqual((await s.api.load(A, id)).data.profile, { by: "B" });
  // base 없음 + 서버에 데이터 있음 → CONFLICT
  const nb = await s.api.save(A, id, { profile: { by: "A" } });
  assert.equal(nb.reason, "CONFLICT");
  // 충돌 뒤 받은 updated_at 으로 다시 → ok
  assert.equal((await s.api.save(A, id, { profile: { by: "A" }, base: a.data.updated_at })).ok, true);
});

test("save race: another save lands between read and write → CONFLICT, nothing overwritten", async () => {
  const s = await withMember();
  const id = s.elder.id;
  const base = (await s.api.load(A, id)).data.updated_at;
  const inner = s.db;
  let raced = false;
  const racing = familyApi({
    db: async (m, path, body, prefer) => {
      if (m === "PATCH" && path.startsWith("elder_data?") && !raced) {
        raced = true;   // A 가 읽은 뒤, 쓰기 직전에 B 가 먼저 저장
        const r = s.t.elder_data.find((x) => x.elder_id === id);
        Object.assign(r, { profile: { by: "B" }, updated_at: pgTs(Date.parse(r.updated_at) + 50) });
      }
      return inner(m, path, body, prefer);
    },
    now: () => new Date(Date.parse("2026-11-17T00:00:05.000Z")),
  });
  const a = await racing.save(A, id, { profile: { by: "A" }, base });
  assert.equal(a.reason, "CONFLICT");
  assert.deepEqual(a.data.profile, { by: "B" });
  assert.deepEqual(s.t.elder_data.find((x) => x.elder_id === id).profile, { by: "B" });
});

test("save without base on a fresh elder is ok", async () => {
  const s = setup();
  const { elder } = await s.api.createElder(A, { label: "어머니" });
  assert.equal((await s.api.save(A, elder.id, { profile: { p: 1 } })).ok, true);
});

test("invite accept twice → INVITE_USED; expired → INVITE_EXPIRED", async () => {
  const s = setup();
  const { elder } = await s.api.createElder(A, { label: "어머니" });
  const inv = await s.api.inviteCreate(A, elder.id);
  assert.equal(inv.ok, true);
  assert.equal(inv.token, "tok1");
  assert.equal(Date.parse(inv.expires_at) - Date.parse("2026-11-17T00:00:00.000Z"), 24 * 3600 * 1000);
  // 서버엔 토큰 해시만
  assert.equal(s.t.invites[0].token_hash, createHash("sha256").update("tok1").digest("hex"));
  assert.ok(!JSON.stringify(s.t.invites).includes('"tok1"'));
  const r1 = await s.api.inviteAccept(B, inv.token);
  assert.deepEqual(r1, { ok: true, elderId: elder.id });
  assert.deepEqual(await s.api.inviteAccept(C, inv.token), { ok: false, reason: "INVITE_USED" });
  assert.deepEqual(await s.api.inviteAccept(C, "no-such"), { ok: false, reason: "INVITE_NOT_FOUND" });
  assert.deepEqual(await s.api.inviteAccept(C, ""), { ok: false, reason: "INVITE_NOT_FOUND" });
  // 만료
  const inv2 = await s.api.inviteCreate(B, elder.id);   // member 도 초대 가능
  assert.equal(inv2.ok, true);
  s.tick(24 * 3600 * 1000 + 1);
  assert.deepEqual(await s.api.inviteAccept(C, inv2.token), { ok: false, reason: "INVITE_EXPIRED" });
  assert.deepEqual(await s.api.load(C, elder.id), { ok: false, reason: "NOT_MEMBER" });
  // 새 member 는 role member 로 보임
  assert.deepEqual((await s.api.me(B)).elders, [{ id: elder.id, label: "어머니", role: "member" }]);
});

test("accept by existing member → ok already, one member row", async () => {
  const s = setup();
  const { elder } = await s.api.createElder(A, { label: "어머니" });
  const inv = await s.api.inviteCreate(A, elder.id);
  assert.deepEqual(await s.api.inviteAccept(A, inv.token), { ok: true, elderId: elder.id, already: true });
  assert.equal(s.t.elder_members.length, 1);
  assert.equal(s.t.elder_members[0].role, "owner");   // owner 가 member 로 내려가지 않음
  // 초대는 그대로 남아 다른 사람이 쓸 수 있음
  assert.deepEqual(await s.api.inviteAccept(B, inv.token), { ok: true, elderId: elder.id });
  assert.deepEqual(await s.api.inviteAccept(B, inv.token), { ok: true, elderId: elder.id, already: true });
  assert.equal(s.t.elder_members.length, 2);
});

test("members lists user_id, role, joined_at, me (no email)", async () => {
  const s = await withMember();
  const m = await s.api.members(B, s.elder.id);
  assert.equal(m.ok, true);
  assert.deepEqual(m.members.map((x) => [x.user_id, x.role, x.me]), [[A.id, "owner", false], [B.id, "member", true]]);
  assert.ok(m.members.every((x) => x.joined_at && !("email" in x)));
});

test("owner leaves → earliest member becomes owner", async () => {
  const s = await withMember();
  const id = s.elder.id;
  s.tick(1000);
  const inv = await s.api.inviteCreate(B, id);
  s.tick(1000);
  await s.api.inviteAccept(C, inv.token);   // C 는 B 보다 나중
  assert.deepEqual(await s.api.leave(A, id), { ok: true });
  assert.deepEqual(await s.api.load(A, id), { ok: false, reason: "NOT_MEMBER" });
  const roles = Object.fromEntries(s.t.elder_members.map((m) => [m.user_id, m.role]));
  assert.deepEqual(roles, { [B.id]: "owner", [C.id]: "member" });
  assert.equal(s.t.elders.length, 1);
  assert.equal(s.t.revoked_devices.length, 0);
});

test("last member leaves → elder, data, invites gone; device revoked", async () => {
  const s = setup();
  const { elder, deviceCode } = await s.api.createElder(A, { label: "어머니" });
  const { elder: other } = await s.api.createElder(B, { label: "아버지" });
  await s.api.inviteCreate(A, elder.id);
  const h = deviceHashOf(deviceCode);
  s.t.loc_events.push({ id: 1, dev: h }, { id: 2, dev: h }, { id: 3, dev: "otherdev" });
  assert.deepEqual(await s.api.leave(A, elder.id), { ok: true, deleted: true });
  assert.deepEqual(s.t.elders.map((e) => e.id), [other.id]);
  assert.deepEqual(s.t.elder_data.map((e) => e.elder_id), [other.id]);
  assert.equal(s.t.invites.length, 0);
  assert.deepEqual(s.t.loc_events.map((e) => e.id), [3]);
  assert.deepEqual(s.t.revoked_devices.map((r) => r.device_hash), [h]);
  assert.deepEqual(await s.api.me(A), { ok: true, elders: [] });
});

test("member cannot removeMember/deleteElder/resetDevice/importDevice → NOT_OWNER", async () => {
  const s = await withMember();
  const id = s.elder.id;
  assert.deepEqual(await s.api.removeMember(B, id, A.id), { ok: false, reason: "NOT_OWNER" });
  assert.deepEqual(await s.api.deleteElder(B, id), { ok: false, reason: "NOT_OWNER" });
  assert.deepEqual(await s.api.resetDevice(B, id), { ok: false, reason: "NOT_OWNER" });
  assert.deepEqual(await s.api.importDevice(B, id, "ABCDEFGHIJKLMNOP"), { ok: false, reason: "NOT_OWNER" });
  assert.equal(s.t.elder_members.length, 2);
  assert.equal(s.t.elders[0].device_hash, deviceHashOf(s.deviceCode));
  // owner 는 member 를 내보낼 수 있고 자기 자신은 못 함
  assert.deepEqual(await s.api.removeMember(A, id, A.id), { ok: false, reason: "USE_LEAVE" });
  assert.deepEqual(await s.api.removeMember(A, id, C.id), { ok: false, reason: "NO_SUCH_MEMBER" });
  assert.deepEqual(await s.api.removeMember(A, id, B.id), { ok: true });
  assert.deepEqual(await s.api.load(B, id), { ok: false, reason: "NOT_MEMBER" });
});

test("deleted elder → load returns GONE", async () => {
  const s = await withMember();
  const id = s.elder.id;
  const h = deviceHashOf(s.deviceCode);
  s.t.loc_events.push({ id: 1, dev: h });
  assert.deepEqual(await s.api.deleteElder(A, id), { ok: true });
  assert.deepEqual(await s.api.load(A, id), { ok: false, reason: "GONE" });
  assert.deepEqual(await s.api.load(B, id), { ok: false, reason: "GONE" });
  assert.deepEqual(await s.api.save(B, id, { profile: {}, base: "x" }), { ok: false, reason: "GONE" });
  assert.equal(s.t.elder_members.length, 0);
  assert.equal(s.t.elder_data.length, 0);
  assert.equal(s.t.loc_events.length, 0);
  assert.deepEqual(s.t.revoked_devices.map((r) => r.device_hash), [h]);
});

test("invite for a deleted elder → INVITE_NOT_FOUND", async () => {
  const s = setup();
  const { elder } = await s.api.createElder(A, { label: "어머니" });
  const inv = await s.api.inviteCreate(A, elder.id);
  await s.api.deleteElder(A, elder.id);
  assert.deepEqual(await s.api.inviteAccept(B, inv.token), { ok: false, reason: "INVITE_NOT_FOUND" });
});

test("resetDevice gives a new code and revokes the old hash", async () => {
  const s = setup();
  const { elder, deviceCode } = await s.api.createElder(A, { label: "어머니" });
  const r = await s.api.resetDevice(A, elder.id);
  assert.equal(r.ok, true);
  assert.match(r.deviceCode, /^[A-Z2-7]{16}$/);
  assert.notEqual(r.deviceCode, deviceCode);
  assert.equal(s.t.elders[0].device_hash, deviceHashOf(r.deviceCode));
  assert.deepEqual(s.t.revoked_devices.map((x) => x.device_hash), [deviceHashOf(deviceCode)]);
});

test("importDevice moves an old rw_track code onto the elder; DEVICE_TAKEN if another elder has it", async () => {
  const s = setup();
  const { elder, deviceCode } = await s.api.createElder(A, { label: "어머니" });
  const { elder: e2, deviceCode: code2 } = await s.api.createElder(A, { label: "아버지" });
  assert.deepEqual(await s.api.importDevice(A, elder.id, code2), { ok: false, reason: "DEVICE_TAKEN" });
  assert.deepEqual(await s.api.importDevice(A, elder.id, "short"), { ok: false, reason: "BAD_INPUT" });
  const old = "abcd efgh ijkl mnop";   // 화면에서 띄어 쓴 소문자도 받는다 (api/loc.js 와 같은 정리)
  assert.deepEqual(await s.api.importDevice(A, elder.id, old), { ok: true });
  assert.equal(s.t.elders.find((e) => e.id === elder.id).device_hash, deviceHashOf("ABCDEFGHIJKLMNOP"));
  assert.deepEqual(s.t.revoked_devices.map((x) => x.device_hash), [deviceHashOf(deviceCode)]);
  assert.deepEqual(await s.api.importDevice(A, elder.id, old), { ok: true });   // 같은 코드 다시 → ok
  // 폐기된 코드는 못 가져옴
  assert.deepEqual(await s.api.importDevice(A, e2.id, deviceCode), { ok: false, reason: "DEVICE_REVOKED" });
});

test("withdraw leaves every elder and asks to delete the auth user", async () => {
  const s = await withMember();
  const { elder: solo } = await s.api.createElder(A, { label: "아버지" });
  assert.deepEqual(await s.api.withdraw(A), { ok: true, deleteAuthUser: true });
  assert.deepEqual(await s.api.me(A), { ok: true, elders: [] });
  assert.deepEqual(await s.api.load(B, solo), { ok: false, reason: "BAD_INPUT" });   // solo 는 객체 — 잘못된 id
  assert.deepEqual(await s.api.load(B, solo.id), { ok: false, reason: "GONE" });
  assert.deepEqual((await s.api.me(B)).elders, [{ id: s.elder.id, label: "어머니", role: "owner" }]);
});

test("member requests update elders.last_seen", async () => {
  const s = setup();
  const { elder } = await s.api.createElder(A, { label: "어머니" });
  const before = s.t.elders[0].last_seen;
  s.tick(60000);
  await s.api.load(A, elder.id);
  assert.ok(Date.parse(s.t.elders[0].last_seen) - Date.parse(before) === 60000);
  // member 가 아니면 갱신 안 함
  s.tick(60000);
  await s.api.load(B, elder.id);
  assert.equal(Date.parse(s.t.elders[0].last_seen) - Date.parse(before), 60000);
});
