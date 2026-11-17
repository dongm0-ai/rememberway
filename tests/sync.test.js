import test from "node:test";
import assert from "node:assert/strict";

// ---- 가짜 localStorage (Map 기반, key(i)/length 까지) ---------------------------------
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: (k) => { mem.delete(k); },
  clear: () => mem.clear(),
  key: (i) => [...mem.keys()][i] ?? null,
  get length() { return mem.size; },
};
const lsGet = (k) => JSON.parse(mem.get(k) ?? "null");
const lsSet = (k, v) => mem.set(k, JSON.stringify(v));

const { store, KEYS, setStoreHook, getHome, saveHome } = await import("../public/js/common.js");
const fam = await import("../public/js/family.js");
const { mergeDiary, sanitizeForUpload, applyLoadResult, SYNCED, currentElder, setCurrentElder, checkAccount,
  pull, push, flush, listElders, createElder, importLocalData, onSync, _setTransport, CONFLICT_TEXT } = fam;

const E1 = { id: "11111111-1111-4111-8111-111111111111", label: "아버지", role: "owner" };
const E2 = { id: "22222222-2222-4222-8222-222222222222", label: "어머니", role: "member" };
const HOME = { label: "석교동", lat: 36.3, lng: 127.43 };
const NEAR = { lat: 36.3002, lng: 127.43 };    // 약 22m
const FAR = { lat: 36.31, lng: 127.43 };       // 약 1.1km

/** 가짜 서버: handler(body) → 응답. calls 에 보낸 요청이 쌓인다 */
function fakeServer(handler) {
  const calls = [];
  _setTransport(async (body) => { calls.push(JSON.parse(JSON.stringify(body))); return handler(body, calls.length); });
  return calls;
}
function reset() { mem.clear(); _setTransport(async () => ({ ok: false, reason: "NETWORK" })); }

// ---- 브리프의 테스트 ------------------------------------------------------------------
test("mergeDiary keeps days from both sides", () => assert.deepEqual(mergeDiary([{ date: "2026-11-16", visited: ["a"] }], [{ date: "2026-11-17", visited: ["b"] }]).map((d) => d.date), ["2026-11-16", "2026-11-17"]));
test("mergeDiary unions visited on same day", () => assert.deepEqual(mergeDiary([{ date: "d", visited: ["a"] }], [{ date: "d", visited: ["b", "a"] }])[0].visited.sort(), ["a", "b"]));
test("sanitize drops utterance from incidents", () => assert.equal(sanitizeForUpload(KEYS.incidents, [{ utterance: "x", clue: {} }], null)[0].utterance, undefined));
test("sanitize drops points within 50m of home", () => {
  const prof = { honorific: "아버지", places: [{ name: "경로당", source: "memory", lat: NEAR.lat, lng: NEAR.lng, distance_m: 22 }, { name: "시장", source: "memory", ...FAR }] };
  const p = sanitizeForUpload(KEYS.profile, prof, HOME);
  assert.equal(p.places.length, 2, "장소 이름은 남긴다");
  assert.equal(p.places[0].lat, undefined); assert.equal(p.places[0].lng, undefined); assert.equal(p.places[0].distance_m, undefined);
  assert.equal(p.places[1].lat, FAR.lat);
  const d = sanitizeForUpload(KEYS.diary, [{ date: "d", visited: ["경로당", "시장"], coords: { 경로당: NEAR, 시장: FAR } }], HOME);
  assert.deepEqual(Object.keys(d[0].coords), ["시장"]);
});
test("applyLoadResult GONE clears cache", () => {
  reset();
  lsSet("rw_elder", E1); lsSet(`rw_cache:${E1.id}`, { profile: { honorific: "아버지" } });
  lsSet(KEYS.profile, { honorific: "아버지" }); lsSet(KEYS.diary, []); lsSet("rw_home:" + E1.id, HOME); lsSet("rw_email", "a@b.c");
  assert.equal(applyLoadResult({ ok: false, reason: "GONE" }, E1.id), "gone");
  assert.equal(mem.has(`rw_cache:${E1.id}`), false);
  assert.equal(mem.has("rw_elder"), false);
  assert.equal(mem.has(KEYS.profile), false);
  assert.equal(mem.has(KEYS.diary), false);
  assert.equal(mem.has("rw_home:" + E1.id), false, "그 어르신 집 주소도 이 폰에서 지운다");
  assert.equal(lsGet("rw_email"), "a@b.c");
});

// ---- 순수 함수 더 ------------------------------------------------------------------
test("mergeDiary: same day keeps local extra fields, clears stayed_home when someone visited, sorted", () => {
  const m = mergeDiary([{ date: "2026-11-17", visited: [], stayed_home: true, spoken: "원문" }, { date: "2026-11-01", visited: ["x"] }],
    [{ date: "2026-11-17", visited: ["시장"], coords: { 시장: FAR } }, { date: "2026-11-10", visited: ["y"] }]);
  assert.deepEqual(m.map((d) => d.date), ["2026-11-01", "2026-11-10", "2026-11-17"]);
  assert.deepEqual(m[2].visited, ["시장"]); assert.equal(m[2].stayed_home, false); assert.equal(m[2].spoken, "원문"); assert.deepEqual(m[2].coords, { 시장: FAR });
  assert.deepEqual(mergeDiary(null, undefined), []);
});
test("sanitize strips every raw-speech field and never mutates input", () => {
  const inc = [{ id: 1, clue: { today_destination: "시장" }, utterance: "원문", record: { found_place: "공원", narrative: "보호자 원문", prevention: [] } }];
  const before = JSON.stringify(inc);
  const s = sanitizeForUpload(KEYS.incidents, inc, HOME);
  assert.equal(s[0].record.narrative, undefined); assert.equal(s[0].utterance, undefined);
  assert.equal(s[0].record.found_place, "공원"); assert.equal(s[0].clue.today_destination, "시장");
  assert.equal(JSON.stringify(inc), before);
  const d = sanitizeForUpload(KEYS.diary, [{ date: "d", visited: [], spoken: "오늘 약국에…", extracted: { notes: "n" } }], null);
  assert.equal(d[0].spoken, undefined); assert.equal(d[0].extracted.notes, "n");
  assert.equal(sanitizeForUpload(KEYS.profile, null, HOME), null);
});
test("sanitize keeps points when no home is set", () => {
  const d = sanitizeForUpload(KEYS.diary, [{ date: "d", visited: [], coords: { a: NEAR } }], null);
  assert.deepEqual(d[0].coords, { a: NEAR });
});

// ---- 계정 바뀜 -----------------------------------------------------------------------
test("checkAccount: first login remembers the user and wipes nothing", () => {
  reset(); lsSet(KEYS.profile, { honorific: "아버지" });
  assert.equal(checkAccount("u1"), "first");
  assert.equal(lsGet("rw_owner_user"), "u1"); assert.ok(mem.has(KEYS.profile));
  assert.equal(checkAccount("u1"), "same");
});
test("checkAccount: other account wipes caches and synced keys but keeps home, track, email", () => {
  reset();
  lsSet("rw_owner_user", "u1"); lsSet("rw_elder", E1); lsSet(`rw_cache:${E1.id}`, {}); lsSet(`rw_cache:${E2.id}`, {});
  for (const k of SYNCED) lsSet(k, [1]);
  lsSet("rw_dirty", { [E1.id]: ["profile"] }); lsSet("rw_elders", [E1]);
  lsSet("rw_home", HOME); lsSet("rw_home:" + E1.id, HOME); lsSet("rw_track", { key: "ABCDEFGHIJKLMNOP" }); lsSet("rw_email", "a@b.c");
  assert.equal(checkAccount("u2"), "switched");
  for (const k of [...SYNCED, `rw_cache:${E1.id}`, `rw_cache:${E2.id}`, "rw_elder", "rw_dirty", "rw_elders"]) assert.equal(mem.has(k), false, k);
  for (const k of ["rw_home", "rw_home:" + E1.id, "rw_track", "rw_email"]) assert.ok(mem.has(k), k);
  assert.equal(lsGet("rw_owner_user"), "u2");
});

// ---- 어르신 바꾸기 ---------------------------------------------------------------------
test("setCurrentElder swaps synced keys and rw_track per elder", () => {
  reset();
  lsSet(`rw_cache:${E1.id}`, { profile: { honorific: "아버지" }, diary: [{ date: "d", visited: ["a"] }], incidents: [], updated_at: "t1", track: { key: "AAAAAAAAAAAAAAAA" } });
  lsSet(`rw_cache:${E2.id}`, { profile: { honorific: "어머니" }, diary: [], incidents: [{ id: 2 }], updated_at: "t2" });
  setCurrentElder(E1);
  assert.deepEqual(currentElder(), E1);
  assert.equal(lsGet(KEYS.profile).honorific, "아버지"); assert.equal(lsGet("rw_track").key, "AAAAAAAAAAAAAAAA");
  lsSet(KEYS.diary, [{ date: "d", visited: ["a", "b"] }]);   // 페이지가 바꾼 사본
  setCurrentElder(E2);
  assert.equal(lsGet(KEYS.profile).honorific, "어머니"); assert.deepEqual(lsGet(KEYS.incidents), [{ id: 2 }]);
  assert.equal(mem.has("rw_track"), false, "어머니는 연결 코드가 없다");
  assert.deepEqual(lsGet(`rw_cache:${E1.id}`).diary[0].visited, ["a", "b"], "떠나는 어르신 사본은 보관");
  setCurrentElder(E1);
  assert.deepEqual(lsGet(KEYS.diary)[0].visited, ["a", "b"]); assert.equal(lsGet("rw_track").key, "AAAAAAAAAAAAAAAA");
});
test("first elder pick never inherits this phone's old data: it goes to a device-only backup", () => {
  reset();
  lsSet(KEYS.profile, { honorific: "아버지" }); lsSet(KEYS.diary, [{ date: "d", visited: ["a"] }]);
  lsSet("rw_track", { key: "LEGACYLEGACYLEGA" }); lsSet("rw_home", HOME);
  setCurrentElder(E1);
  for (const k of [...SYNCED, "rw_track", "rw_home", "rw_home:" + E1.id]) assert.equal(mem.has(k), false, k);
  const keys = fam.phoneBackups();
  assert.equal(keys.length, 1); assert.match(keys[0], /^rw_backup_\d+/);
  const b = lsGet(keys[0]);
  assert.equal(b.profile.honorific, "아버지"); assert.equal(b.track.key, "LEGACYLEGACYLEGA"); assert.equal(b.home.label, "석교동");
  assert.equal(lsGet("rw_dirty"), null, "보관한 데이터는 올리지 않는다");
});
test("invited to another family's elder with old phone data: nothing leaks into that elder", async () => {
  reset();
  lsSet(KEYS.profile, { honorific: "우리 아버지", places: [{ name: "비밀 장소" }] }); lsSet("rw_track", { key: "LEGACYLEGACYLEGA" }); lsSet("rw_home", HOME);
  const server = { profile: { honorific: "어머니", places: [] }, diary: [], incidents: [], updated_at: base0 };
  const calls = fakeServer((b) => (b.action === "me" ? { ok: true, elders: [E2] } : b.action === "data.load" ? { ok: true, data: server } : { ok: false, reason: "BAD_ACTION" }));
  const elders = await listElders();
  assert.equal((await importLocalData({ elders, userId: "u9", ask: () => true })).skipped, true);
  setCurrentElder(E2);
  assert.equal(await pull(), "ok");
  assert.deepEqual(lsGet(KEYS.profile), server.profile);
  assert.equal(mem.has("rw_track"), false); assert.equal(mem.has("rw_home:" + E2.id), false); assert.equal(getHome(), null);
  assert.deepEqual(calls.map((c) => c.action), ["me", "data.load"], "이 폰 데이터를 올리지 않았다");
  assert.equal(fam.phoneBackups().length, 1);
});
test("after an account switch the old account's connection code does not become the new account's elder's", () => {
  reset();
  lsSet("rw_owner_user", "u1"); setCurrentElder(E1); lsSet("rw_track", { key: "OLDACCOUNTCODE23" }); lsSet("rw_home:" + E1.id, HOME);
  assert.equal(checkAccount("u2"), "switched");
  setCurrentElder(E2);
  assert.equal(mem.has("rw_track"), false);
  assert.equal(lsGet(fam.phoneBackups()[0]).track.key, "OLDACCOUNTCODE23");
  assert.equal(getHome(), null);
});

// ---- 집 주소 (common.js) ----------------------------------------------------------------
test("home is per elder; the old rw_home is never handed to whichever elder is picked", () => {
  reset(); lsSet("rw_home", HOME);
  assert.equal(getHome().label, "석교동");   // 어르신이 없으면 옛 키
  lsSet("rw_elder", E1);
  assert.equal(getHome(), null);
  assert.ok(mem.has("rw_home"), "옮기지 않는다");
  saveHome({ label: "대흥동", lat: 36.32, lng: 127.42 });
  assert.equal(lsGet("rw_home:" + E1.id).label, "대흥동");
  lsSet("rw_elder", E2);
  assert.equal(getHome(), null, "다른 어르신은 집 주소가 따로");
});
test("store.set calls the hook after writing", () => {
  reset(); const seen = [];
  setStoreHook((k, v) => seen.push([k, v, mem.get(k)]));
  store.set("x", { a: 1 });
  setStoreHook(null); store.set("y", 1);
  assert.deepEqual(seen, [["x", { a: 1 }, '{"a":1}']]);
  fam.installSync();   // 다음 테스트를 위해 되돌림
});

// ---- 불러오기 ------------------------------------------------------------------------
test("applyLoadResult ok fills the cache and, for the current elder, the synced keys", () => {
  reset(); lsSet("rw_elder", E1);
  const data = { profile: { honorific: "아버지", places: [] }, diary: [{ date: "d", visited: ["a"] }], incidents: [], updated_at: "2026-11-17T00:00:00.000Z" };
  assert.equal(applyLoadResult({ ok: true, data }, E1.id), "ok");
  assert.deepEqual(lsGet(KEYS.profile), data.profile); assert.deepEqual(lsGet(KEYS.diary), data.diary);
  assert.equal(lsGet(`rw_cache:${E1.id}`).updated_at, data.updated_at);
  assert.equal(applyLoadResult({ ok: true, data: { ...data, profile: { honorific: "어머니" } } }, E2.id), "ok");
  assert.equal(lsGet(KEYS.profile).honorific, "아버지", "현재 어르신이 아니면 사본만");
  applyLoadResult({ ok: true, data: { ...data, profile: null } }, E1.id);
  assert.equal(mem.has(KEYS.profile), false);
});
test("applyLoadResult offline keeps the phone copy", () => {
  reset(); lsSet("rw_elder", E1); lsSet(KEYS.profile, { honorific: "아버지" });
  for (const reason of ["NETWORK", "TIMEOUT", "AUTH_UNAVAILABLE", "STORE_ERROR"]) assert.equal(applyLoadResult({ ok: false, reason }, E1.id), "offline");
  assert.equal(lsGet(KEYS.profile).honorific, "아버지"); assert.deepEqual(currentElder(), E1);
});

// ---- 올리기 ---------------------------------------------------------------------------
const base0 = "2026-11-17T00:00:00.000Z", base1 = "2026-11-17T00:00:01.000Z", base2 = "2026-11-17T00:00:02.000Z";
function withElder(cache = {}) { reset(); setCurrentElder(E1); lsSet(`rw_cache:${E1.id}`, { profile: null, diary: [], incidents: [], updated_at: base0, base: { profile: null, diary: [], incidents: [] }, ...cache }); }

test("store.set on a synced key marks it dirty; push sends a sanitized save with base", async () => {
  withElder(); lsSet("rw_home:" + E1.id, HOME);
  const calls = fakeServer(() => ({ ok: true, updated_at: base1 }));
  store.set(KEYS.incidents, [{ id: 1, utterance: "원문", record: { narrative: "원문" } }]);
  store.set("rw_other", 1);
  assert.deepEqual(lsGet("rw_dirty"), { [E1.id]: ["incidents"] });
  assert.equal(await flush(), "ok");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, "data.save"); assert.equal(calls[0].elderId, E1.id); assert.equal(calls[0].base, base0);
  assert.equal(calls[0].incidents[0].utterance, undefined); assert.equal(calls[0].incidents[0].record.narrative, undefined);
  assert.equal("profile" in calls[0], false, "바뀐 것만 보낸다");
  assert.equal(lsGet(`rw_cache:${E1.id}`).updated_at, base1);
  assert.equal(mem.has("rw_dirty"), false);
  assert.equal(lsGet(KEYS.incidents)[0].utterance, "원문", "이 폰 사본에는 원문이 남는다");
});
test("push is debounced 1 second", async (t) => {
  withElder();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = fakeServer(() => ({ ok: true, updated_at: base1 }));
  store.set(KEYS.profile, { honorific: "아버지", places: [] });
  store.set(KEYS.diary, [{ date: "d", visited: ["a"] }]);
  t.mock.timers.tick(999); await Promise.resolve();
  assert.equal(calls.length, 0);
  t.mock.timers.tick(1); await new Promise((r) => setImmediate(r));
  assert.equal(calls.length, 1); assert.ok(calls[0].profile && calls[0].diary);
});
test("offline save keeps rw_dirty and pull retries it before loading", async () => {
  withElder();
  let calls = fakeServer(() => ({ ok: false, reason: "NETWORK" }));
  store.set(KEYS.profile, { honorific: "아버지", places: [{ name: "시장" }] });
  assert.equal(await flush(), "offline");
  assert.deepEqual(lsGet("rw_dirty"), { [E1.id]: ["profile"] });
  assert.equal(await pull(), "offline");
  assert.equal(lsGet(KEYS.profile).places[0].name, "시장", "서버가 안 되면 이 폰 사본 그대로");
  calls = fakeServer((b) => (b.action === "data.save" ? { ok: true, updated_at: base1 } : { ok: true, data: { profile: b.action && { honorific: "아버지", places: [{ name: "시장" }] }, diary: [], incidents: [], updated_at: base1 } }));
  assert.equal(await pull(), "ok");
  assert.deepEqual(calls.map((c) => c.action), ["data.save", "data.load"]);
  assert.equal(mem.has("rw_dirty"), false);
});
test("diary conflict: merge by day and save again on the server's updated_at", async () => {
  withElder({ diary: [{ date: "2026-11-16", visited: ["a"] }] });
  const server = { profile: null, diary: [{ date: "2026-11-16", visited: ["b"] }, { date: "2026-11-17", visited: ["c"] }], incidents: [], updated_at: base1 };
  const calls = fakeServer((b, n) => (n === 1 ? { ok: false, reason: "CONFLICT", data: server } : { ok: true, updated_at: base2 }));
  const events = []; const off = onSync((e) => events.push(e));
  store.set(KEYS.diary, [{ date: "2026-11-16", visited: ["a", "d"] }]);
  assert.equal(await flush(), "ok"); off();
  assert.equal(calls.length, 2); assert.equal(calls[1].base, base1);
  assert.deepEqual(calls[1].diary.map((d) => [d.date, [...d.visited].sort()]), [["2026-11-16", ["a", "b", "d"]], ["2026-11-17", ["c"]]]);
  assert.deepEqual(lsGet(KEYS.diary).map((d) => d.date), ["2026-11-16", "2026-11-17"]);
  assert.equal(lsGet(`rw_cache:${E1.id}`).updated_at, base2);
  assert.equal(events.some((e) => e.type === "conflict"), false, "일지는 조용히 합친다");
});
test("profile conflict when another family changed it: server wins with a notice", async () => {
  withElder({ profile: { honorific: "아버지", places: [] }, base: { profile: { honorific: "아버지", places: [] }, diary: [], incidents: [] } });
  const server = { profile: { honorific: "아버지", places: [{ name: "옛 직장" }] }, diary: [], incidents: [], updated_at: base1 };
  const calls = fakeServer(() => ({ ok: false, reason: "CONFLICT", data: server }));
  const events = []; const off = onSync((e) => events.push(e));
  store.set(KEYS.profile, { honorific: "아버지", places: [{ name: "시장" }] });
  assert.equal(await flush(), "conflict"); off();
  assert.equal(calls.length, 1);
  assert.deepEqual(lsGet(KEYS.profile), server.profile);
  assert.deepEqual(events.filter((e) => e.type === "conflict"), [{ type: "conflict", key: KEYS.profile, elderId: E1.id, text: CONFLICT_TEXT }]);
  assert.equal(CONFLICT_TEXT, "다른 가족이 먼저 고쳤어요");
  assert.equal(lsGet(`rw_cache:${E1.id}`).updated_at, base1); assert.equal(mem.has("rw_dirty"), false);
});
test("profile conflict caused only by someone else's diary: keep my profile, save again", async () => {
  const p0 = { honorific: "아버지", places: [] };
  withElder({ profile: p0, base: { profile: p0, diary: [], incidents: [] } });
  const server = { profile: { places: [], honorific: "아버지" }, diary: [{ date: "d", visited: ["x"] }], incidents: [], updated_at: base1 };   // jsonb 는 키 순서가 바뀐다
  const calls = fakeServer((b, n) => (n === 1 ? { ok: false, reason: "CONFLICT", data: server } : { ok: true, updated_at: base2 }));
  store.set(KEYS.profile, { honorific: "아버지", places: [{ name: "시장" }] });
  assert.equal(await flush(), "ok");
  assert.equal(calls[1].base, base1); assert.equal(calls[1].profile.places[0].name, "시장"); assert.equal("diary" in calls[1], false);
  assert.deepEqual(lsGet(KEYS.diary), server.diary, "다른 가족의 일지는 받아 온다");
  assert.equal(lsGet(KEYS.profile).places[0].name, "시장");
});
test("save GONE clears that elder; pull reports gone", async () => {
  withElder();
  fakeServer(() => ({ ok: false, reason: "GONE" }));
  const events = []; const off = onSync((e) => events.push(e));
  store.set(KEYS.profile, { honorific: "아버지" });
  assert.equal(await flush(), "gone"); off();
  assert.equal(currentElder(), null); assert.equal(mem.has(`rw_cache:${E1.id}`), false); assert.equal(mem.has("rw_dirty"), false);
  assert.ok(events.some((e) => e.type === "gone" && e.elderId === E1.id));
  setCurrentElder(E2);
  assert.equal(await pull(), "gone");
  assert.equal(currentElder(), null);
});
test("a save the server refuses for good (BAD_INPUT) is dropped instead of retried forever", async () => {
  withElder();
  fakeServer(() => ({ ok: false, reason: "BAD_INPUT" }));
  store.set(KEYS.profile, { honorific: "아버지" });
  assert.equal(await flush(), "error");
  assert.equal(mem.has("rw_dirty"), false);
});
test("pull with no current elder does nothing", async () => {
  reset(); const calls = fakeServer(() => ({ ok: true }));
  assert.equal(await pull(), "ok"); assert.equal(calls.length, 0);
});

// ---- 어르신 목록·만들기 ------------------------------------------------------------------
test("listElders returns the server list, caches it, and drops a current elder that is no longer mine", async () => {
  reset(); setCurrentElder(E1); lsSet(`rw_cache:${E1.id}`, {});
  fakeServer(() => ({ ok: true, elders: [E2] }));
  assert.deepEqual(await listElders(), [E2]);
  assert.equal(currentElder(), null); assert.equal(mem.has(`rw_cache:${E1.id}`), false);
  fakeServer(() => ({ ok: false, reason: "NETWORK" }));
  assert.deepEqual(await listElders(), [E2], "서버가 안 되면 마지막 목록");
});
test("listElders refreshes the current elder's role and label", async () => {
  reset(); setCurrentElder(E1);
  fakeServer(() => ({ ok: true, elders: [{ ...E1, label: "아빠", role: "member" }] }));
  await listElders();
  assert.deepEqual(currentElder(), { ...E1, label: "아빠", role: "member" });
});
test("createElder keeps the new connection code in that elder's copy", async () => {
  reset();
  const calls = fakeServer(() => ({ ok: true, elder: E1, deviceCode: "NEWCODENEWCODE23" }));
  const r = await createElder("  아버지 ");
  assert.equal(calls[0].action, "elder.create"); assert.equal(calls[0].label, "아버지");
  assert.equal(r.ok, true); assert.deepEqual(r.elder, E1);
  assert.equal(lsGet(`rw_cache:${E1.id}`).track.key, "NEWCODENEWCODE23");
});

// ---- 첫 로그인 가져오기 -------------------------------------------------------------------
test("first login with this phone's old data: create elder, upload sanitized data, import device", async () => {
  reset();
  lsSet(KEYS.profile, { honorific: "아버지", places: [{ name: "경로당", ...NEAR }] });
  lsSet(KEYS.diary, [{ date: "d", visited: ["경로당"], spoken: "원문" }]);
  lsSet("rw_track", { key: "OLDCODEOLDCODE23", created: "x" }); lsSet("rw_home", HOME);
  const calls = fakeServer((b) => ({ "elder.create": { ok: true, elder: E1, deviceCode: "NEWCODENEWCODE23" }, "data.save": { ok: true, updated_at: base1 }, "device.import": { ok: true } }[b.action]));
  let asked = null;
  const r = await importLocalData({ elders: [], userId: "u1", ask: (m) => { asked = m; return true; } });
  assert.equal(asked, "이 폰의 등록 정보를 새 어르신으로 올릴까요?");
  assert.equal(r.ok, true);
  assert.deepEqual(calls.map((c) => c.action), ["elder.create", "data.save", "device.import"]);
  assert.equal(calls[0].label, "아버지");
  assert.equal(calls[1].base, null); assert.equal(calls[1].diary[0].spoken, undefined); assert.equal(calls[1].profile.places[0].lat, undefined);
  assert.equal(calls[2].key, "OLDCODEOLDCODE23");
  assert.deepEqual(currentElder(), E1);
  assert.equal(lsGet("rw_track").key, "OLDCODEOLDCODE23"); assert.equal(lsGet(KEYS.diary)[0].spoken, "원문");
  assert.equal(lsGet("rw_home:" + E1.id).label, "석교동");
  assert.equal(lsGet(`rw_cache:${E1.id}`).updated_at, base1);
  // 다시 부르면 묻지 않는다
  assert.equal((await importLocalData({ elders: [], userId: "u1", ask: () => { throw new Error("asked twice"); } })).skipped, true);
});
test("first login import: device already taken gives a gentle message and keeps the new code", async () => {
  reset();
  lsSet(KEYS.profile, { honorific: "어머니", places: [] }); lsSet("rw_track", { key: "OLDCODEOLDCODE23" });
  fakeServer((b) => ({ "elder.create": { ok: true, elder: E2, deviceCode: "NEWCODENEWCODE23" }, "data.save": { ok: true, updated_at: base1 }, "device.import": { ok: false, reason: "DEVICE_TAKEN" } }[b.action]));
  const r = await importLocalData({ elders: [], userId: "u2", ask: () => true });
  assert.equal(r.ok, true); assert.match(r.message, /연결 코드/);
  assert.equal(lsGet("rw_track").key, "NEWCODENEWCODE23");
});
test("first login import is not offered when there are elders, no old profile, or the guardian says no", async () => {
  reset(); lsSet(KEYS.profile, { honorific: "아버지" });
  const calls = fakeServer(() => ({ ok: true }));
  assert.equal((await importLocalData({ elders: [E1], userId: "u1", ask: () => true })).skipped, true);
  assert.equal((await importLocalData({ elders: [], userId: "u1", ask: () => false })).skipped, true);
  mem.delete(KEYS.profile); mem.delete("rw_import_asked");
  assert.equal((await importLocalData({ elders: [], userId: "u1", ask: () => true })).skipped, true);
  assert.equal(calls.length, 0);
});

test("family.js exports SYNCED as the three shared keys", () => assert.deepEqual(SYNCED, [KEYS.profile, KEYS.diary, KEYS.incidents]));
test("push(key) marks the current elder dirty", () => {
  withElder(); push(KEYS.incidents);
  assert.deepEqual(lsGet("rw_dirty"), { [E1.id]: ["incidents"] });
});
test("conflict while the guardian edited another key meanwhile: that edit is kept and sent next", async () => {
  withElder({ diary: [{ date: "d1", visited: ["a"] }] });
  const server = { profile: { honorific: "아버지" }, diary: [{ date: "d0", visited: ["z"] }], incidents: [], updated_at: base1 };
  const calls = fakeServer((b, n) => {
    if (n === 1) { store.set(KEYS.incidents, [{ id: 9 }]); return { ok: false, reason: "CONFLICT", data: server }; }   // 기다리는 사이 기록을 고침
    return { ok: true, updated_at: base2 };
  });
  store.set(KEYS.diary, [{ date: "d1", visited: ["a", "b"] }]);
  assert.equal(await flush(), "ok");
  assert.deepEqual(lsGet(KEYS.incidents), [{ id: 9 }]);
  assert.deepEqual(calls[1].incidents, [{ id: 9 }]); assert.deepEqual(calls[1].diary.map((d) => d.date), ["d0", "d1"]);
  assert.deepEqual(lsGet(KEYS.profile), server.profile);
  assert.equal(mem.has("rw_dirty"), false);
});

// ---- 고친 것 (리뷰 1회차) ----------------------------------------------------------------
test("conflict: a diary edit to the same key made while the save was in flight survives", async () => {
  withElder({ diary: [{ date: "d1", visited: ["a"] }] });
  const server = { profile: null, diary: [{ date: "d0", visited: ["z"] }], incidents: [], updated_at: base1 };
  const calls = fakeServer((b, n) => {
    if (n === 1) { store.set(KEYS.diary, [{ date: "d1", visited: ["a", "b"] }, { date: "d2", visited: ["c"] }]); return { ok: false, reason: "CONFLICT", data: server }; }
    return { ok: true, updated_at: base2 };
  });
  store.set(KEYS.diary, [{ date: "d1", visited: ["a", "b"] }]);
  assert.equal(await flush(), "ok");
  assert.deepEqual(lsGet(KEYS.diary).map((d) => d.date), ["d0", "d1", "d2"]);
  assert.deepEqual(calls[1].diary.map((d) => d.date), ["d0", "d1", "d2"]);
  assert.equal(mem.has("rw_dirty"), false);
});
test("conflict: a profile edit to the same key made while the save was in flight survives (server profile untouched)", async () => {
  const p0 = { honorific: "아버지", places: [] };
  withElder({ profile: p0, base: { profile: p0, diary: [], incidents: [] } });
  const server = { profile: p0, diary: [{ date: "d", visited: ["x"] }], incidents: [], updated_at: base1 };
  const calls = fakeServer((b, n) => {
    if (n === 1) { store.set(KEYS.profile, { honorific: "아버지", places: [{ name: "시장" }, { name: "공원" }] }); return { ok: false, reason: "CONFLICT", data: server }; }
    return { ok: true, updated_at: base2 };
  });
  store.set(KEYS.profile, { honorific: "아버지", places: [{ name: "시장" }] });
  assert.equal(await flush(), "ok");
  assert.deepEqual(lsGet(KEYS.profile).places.map((p) => p.name), ["시장", "공원"]);
  assert.deepEqual(calls[1].profile.places.map((p) => p.name), ["시장", "공원"]);
});
test("pull keeps this phone's raw text and near-home points when the server holds the sanitized same data", async () => {
  withElder(); lsSet("rw_home:" + E1.id, HOME);
  const localDiary = [{ date: "d", visited: ["경로당"], spoken: "오늘 경로당에…", coords: { 경로당: NEAR } }];
  const localProfile = { honorific: "아버지", places: [{ name: "경로당", ...NEAR }] };
  lsSet(KEYS.diary, localDiary); lsSet(KEYS.profile, localProfile);
  const data = { profile: sanitizeForUpload(KEYS.profile, localProfile, HOME), diary: sanitizeForUpload(KEYS.diary, localDiary, HOME), incidents: [], updated_at: base1 };
  fakeServer(() => ({ ok: true, data }));
  assert.equal(await pull(), "ok");
  assert.deepEqual(lsGet(KEYS.diary), localDiary); assert.deepEqual(lsGet(KEYS.profile), localProfile);
  fakeServer(() => ({ ok: true, data: { ...data, diary: [{ date: "d", visited: ["시장"] }], updated_at: base2 } }));
  await pull();
  assert.deepEqual(lsGet(KEYS.diary), [{ date: "d", visited: ["시장"] }], "서버 값이 정말 다르면 서버 값");
});
test("mergeDiary same day unions extracted places and mentions and keeps both notes", () => {
  const m = mergeDiary([{ date: "d", visited: [], extracted: { new_places: [{ name: "약국" }], mentions: [{ place: "바다", kind: "memory" }], notes: "기침" } }],
    [{ date: "d", visited: [], extracted: { new_places: [{ name: "시장" }, { name: "약국" }], mentions: [], notes: "잘 주무심" } }]);
  assert.deepEqual(m[0].extracted.new_places.map((p) => p.name).sort(), ["시장", "약국"]);
  assert.deepEqual(m[0].extracted.mentions, [{ place: "바다", kind: "memory" }]);
  assert.equal(m[0].extracted.notes, "잘 주무심 / 기침");
});
test("gone event tells the shell the home address was removed", () => {
  reset(); setCurrentElder(E1); lsSet("rw_home:" + E1.id, HOME);
  const events = []; const off = onSync((e) => events.push(e));
  applyLoadResult({ ok: false, reason: "GONE" }, E1.id); off();
  assert.deepEqual(events, [{ type: "gone", elderId: E1.id, homeRemoved: true, wasCurrent: true }]);
});
test("importLocalData marks asked only after ask() resolves", async () => {
  reset(); lsSet(KEYS.profile, { honorific: "아버지" });
  await assert.rejects(importLocalData({ elders: [], userId: "u1", ask: async () => { throw new Error("closed"); } }));
  assert.equal(mem.has("rw_import_asked"), false);
});
test("listElders forgets every cached elder (and its home) that is not in the server list", async () => {
  reset(); setCurrentElder(E2);
  lsSet(`rw_cache:${E1.id}`, { profile: { honorific: "아버지" } }); lsSet("rw_home:" + E1.id, HOME); lsSet(`rw_cache:${E2.id}`, {});
  fakeServer(() => ({ ok: true, elders: [E2] }));
  await listElders();
  assert.equal(mem.has(`rw_cache:${E1.id}`), false); assert.equal(mem.has("rw_home:" + E1.id), false);
  assert.ok(mem.has(`rw_cache:${E2.id}`)); assert.deepEqual(currentElder(), E2);
});
test("a save answered after an account switch does not write the old account's cache", async () => {
  withElder(); lsSet("rw_owner_user", "u1");
  let release; const gate = new Promise((r) => (release = r));
  fakeServer(async () => { await gate; return { ok: false, reason: "CONFLICT", data: { profile: { honorific: "x" }, diary: [], incidents: [], updated_at: base1 } }; });
  store.set(KEYS.profile, { honorific: "아버지" });
  const p = flush();
  await new Promise((r) => setImmediate(r));
  checkAccount("u2"); release();
  await p;
  assert.equal(mem.has(`rw_cache:${E1.id}`), false); assert.equal(mem.has(KEYS.profile), false); assert.equal(mem.has("rw_dirty"), false);
});
test("sanitize treats string numbers and [lat,lng] tuples as points", () => {
  const p = sanitizeForUpload(KEYS.profile, { places: [{ name: "a", lat: String(NEAR.lat), lng: String(NEAR.lng) }], path: [[NEAR.lat, NEAR.lng], [FAR.lat, FAR.lng]] }, HOME);
  assert.equal(p.places[0].lat, undefined); assert.equal(p.places[0].name, "a");
  assert.deepEqual(p.path, [[FAR.lat, FAR.lng]]);
});
