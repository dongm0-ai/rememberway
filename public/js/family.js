// 보호자 계정 동기화 (브라우저) — 현재 어르신의 프로필·일지·찾은 뒤 기록을 서버(api/loc.js)와 맞춘다.
// - 기존 화면은 그대로 store.get/store.set(KEYS.profile/diary/incidents) 만 쓴다. 그 키들은 "현재 어르신 서버 데이터의 이 폰 사본"이다.
//   store.set 훅(common.js setStoreHook)이 바뀐 키를 rw_dirty 에 적고 1초 뒤 data.save 로 올린다. 못 올리면 다음 pull() 전에 다시.
// - 어르신별 사본: localStorage "rw_cache:<elderId>" = { profile, diary, incidents, updated_at, base, track }
//     updated_at = 서버가 마지막으로 준 시각(data.save 의 base), base = 그때의 서버 값(업로드 정리 후 모양 — 충돌 때 "누가 바꿨나" 비교용),
//     track = 그 어르신 폰 연결 코드 사본(rw_track 모양). 현재 어르신 = "rw_elder" {id,label,role}.
// - 충돌(CONFLICT): 일지는 날짜별로 합쳐 서버 updated_at 으로 다시 저장. 프로필·기록은 다른 가족이 바꿨으면 서버 값 + "다른 가족이 먼저 고쳤어요"
//   (rw-sync 이벤트). 서버에서 바뀐 게 그 키가 아니면(다른 가족은 일지만 고침) 내 값을 다시 저장.
// - 서버로 보내지 않는 것: 보호자가 말한 원문(utterance·narrative·spoken·raw), 집 좌표(ARRIVE_M 50m 안의 점), 집 주소 자체.
// - 서버가 GONE(어르신이 지워졌거나 내가 더는 가족이 아님) → 그 어르신 사본·집 주소·rw_elder 를 이 폰에서 지운다.
// - 다른 계정으로 로그인 → 모든 rw_cache:*·SYNCED 키 삭제 (집 주소·연결 코드·이메일은 그대로).
// - import 할 때는 window/localStorage 를 건드리지 않는다 (Node 테스트). store 훅만 등록한다 — 호출될 때 읽는다.
import { KEYS, setStoreHook, homeFor, homeKeyFor } from "./common.js";
import { authFetch } from "./auth.js";
import { ARRIVE_M } from "../lib/schema.js";
import { haversineM } from "../lib/priority.js";

export const SYNCED = [KEYS.profile, KEYS.diary, KEYS.incidents];
export const CONFLICT_TEXT = "다른 가족이 먼저 고쳤어요";
const FIELD = { [KEYS.profile]: "profile", [KEYS.diary]: "diary", [KEYS.incidents]: "incidents" };
const KEY_OF = { profile: KEYS.profile, diary: KEYS.diary, incidents: KEYS.incidents };
const EMPTY = { profile: null, diary: [], incidents: [] };
const ELDER_KEY = "rw_elder", ELDERS_KEY = "rw_elders", OWNER_KEY = "rw_owner_user", DIRTY_KEY = "rw_dirty", TRACK_KEY = "rw_track", ASKED_KEY = "rw_import_asked";
const CACHE_PREFIX = "rw_cache:";
const cacheKey = (id) => CACHE_PREFIX + id;
const DEBOUNCE_MS = 1000;
const MAX_RESAVE = 3;
// 잠깐의 장애 — 이 폰 사본으로 계속 쓰고 다음에 다시 올린다. 이 밖의 실패(BAD_INPUT 등)는 다시 보내도 같으니 버린다
const TRANSIENT = new Set(["NETWORK", "TIMEOUT", "AUTH_UNAVAILABLE", "STORE_ERROR", "NO_STORE", "RATE_LIMIT", "AUTH", "NEED_LOGIN", "UNAUTHORIZED", "FORBIDDEN"]);
const isTransient = (reason) => TRANSIENT.has(reason) || /^HTTP_5\d\d$/.test(String(reason));

// ---------------------------------------------------------------- 저장소 (호출할 때 읽는다, 막혀 있어도 죽지 않음)
const ls = () => globalThis.localStorage;
const rawGet = (k) => { try { return ls()?.getItem(k) ?? null; } catch { return null; } };
const jget = (k, fb = null) => { const v = rawGet(k); if (v === null) return fb; try { return JSON.parse(v); } catch { return fb; } };
const jset = (k, v) => { try { ls()?.setItem(k, JSON.stringify(v)); } catch {} };   // store.set 이 아님 — 훅(업로드)을 부르지 않는다
const del = (k) => { try { ls()?.removeItem(k); } catch {} };
function allKeys() { const out = []; try { const s = ls(); for (let i = 0; i < (s?.length ?? 0); i++) { const k = s.key(i); if (k !== null) out.push(k); } } catch {} return out; }

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
/** 키 순서와 상관없이 같은 값인가 (서버 jsonb 는 키 순서를 바꾼다) */
function same(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return a == null && b == null;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => same(x, b[i]));
  const ka = Object.keys(a).filter((k) => a[k] !== undefined), kb = Object.keys(b).filter((k) => b[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => same(a[k], b[k]));
}

// ---------------------------------------------------------------- 알림 (화면이 한 줄 안내를 띄울 수 있게)
const listeners = new Set();
/** 동기화 소식 받기. e = {type:"conflict", key, elderId, text} | {type:"gone", elderId} | {type:"saved"|"offline"|"error", elderId, reason?}. 해제 함수를 돌려준다.
 *  브라우저에서는 window 의 "rw-sync" CustomEvent(detail = e)로도 나간다 */
export function onSync(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(e) {
  for (const fn of listeners) { try { fn(e); } catch {} }
  try { if (typeof globalThis.dispatchEvent === "function" && typeof CustomEvent === "function") globalThis.dispatchEvent(new CustomEvent("rw-sync", { detail: e })); } catch {}
}

// ---------------------------------------------------------------- 서버 호출 (테스트는 바꿔 끼운다)
let transport = (body) => authFetch(body);
let timer = null;
/** 테스트용: 서버 호출 함수 바꾸기 (대기 중인 올리기도 취소) */
export function _setTransport(fn) { transport = fn; clearTimeout(timer); timer = null; }
async function call(body) { try { return (await transport(body)) ?? { ok: false, reason: "NETWORK" }; } catch { return { ok: false, reason: "NETWORK" }; } }

// ---------------------------------------------------------------- 순수 함수
/** 일지 합치기: 날짜별. 같은 날이면 visited 합집합(+ 이 폰 쪽 다른 칸 우선), 날짜순 */
export function mergeDiary(local, server) {
  const byDate = new Map();
  for (const e of Array.isArray(server) ? server : []) if (e && e.date) byDate.set(String(e.date), clone(e));
  for (const e of Array.isArray(local) ? local : []) {
    if (!e || !e.date) continue;
    const s = byDate.get(String(e.date));
    if (!s) { byDate.set(String(e.date), clone(e)); continue; }
    const m = { ...s, ...clone(e), visited: [...new Set([...(s.visited ?? []), ...(e.visited ?? [])])] };
    if (s.coords || e.coords) m.coords = { ...(s.coords ?? {}), ...(e.coords ?? {}) };
    if (m.visited.length) { m.stayed_home = false; m.unknown = false; }   // 누군가 다녀온 곳을 적었으면 "집에만"·"모름"은 맞지 않다
    byDate.set(String(e.date), m);
  }
  return [...byDate.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

const RAW_SPEECH = new Set(["utterance", "narrative", "spoken", "raw"]);   // 보호자가 말하거나 쓴 원문 전체
const POINT_ONLY = new Set(["lat", "lng", "lon", "acc", "accuracy", "time", "t", "gps_time", "received_at", "speed_kmh"]);
/** 서버로 올리기 전 정리 (입력은 바꾸지 않는다): 원문 칸 삭제, 집(home)에서 ARRIVE_M 안의 점 삭제.
 *  점만 있는 객체({lat,lng})는 통째로, 장소처럼 이름이 있는 객체는 좌표(lat/lng/distance_m)만 지운다 — 이름은 남는다 */
export function sanitizeForUpload(key, value, home) {
  if (value === null || value === undefined) return value ?? null;
  const v = clone(value);
  const h = home && Number.isFinite(Number(home.lat)) && Number.isFinite(Number(home.lng)) ? { lat: Number(home.lat), lng: Number(home.lng) } : null;
  const nearHome = (o) => h && typeof o.lat === "number" && typeof o.lng === "number" && haversineM(h.lat, h.lng, o.lat, o.lng) <= ARRIVE_M;
  const walk = (node) => {   // false 를 돌려주면 부모에서 지운다
    if (!node || typeof node !== "object") return true;
    if (Array.isArray(node)) { for (let i = node.length - 1; i >= 0; i--) if (!walk(node[i])) node.splice(i, 1); return true; }
    for (const k of Object.keys(node)) if (RAW_SPEECH.has(k)) delete node[k];
    if (nearHome(node)) {
      if (Object.keys(node).every((k) => POINT_ONLY.has(k))) return false;
      delete node.lat; delete node.lng; delete node.lon; delete node.distance_m;
    }
    for (const k of Object.keys(node)) if (!walk(node[k])) delete node[k];
    return true;
  };
  if (key === KEYS.profile && v && typeof v === "object") { delete v.home; delete v.rw_home; }   // 집 주소 자체는 절대 올리지 않는다
  walk(v);
  return v;
}

// ---------------------------------------------------------------- 어르신별 사본
const readCache = (id) => { const c = jget(cacheKey(id), null); return c && typeof c === "object" ? c : {}; };
const writeCache = (id, c) => jset(cacheKey(id), c);
const readWorking = (field) => jget(KEY_OF[field], EMPTY[field]);
function writeWorking(field, value) { if (value === null || value === undefined) del(KEY_OF[field]); else jset(KEY_OF[field], value); }

function dirtyOf(id) { const d = jget(DIRTY_KEY, {}); return Array.isArray(d?.[id]) ? d[id] : []; }
function setDirty(id, fields) {
  const d = jget(DIRTY_KEY, {}) || {};
  if (fields.length) d[id] = [...new Set(fields)]; else delete d[id];
  if (Object.keys(d).length) jset(DIRTY_KEY, d); else del(DIRTY_KEY);
}

/** 현재 어르신 {id,label,role} | null */
export function currentElder() { const e = jget(ELDER_KEY, null); return e && typeof e.id === "string" && e.id ? e : null; }

/** 현재 어르신 바꾸기: 떠나는 어르신의 SYNCED 키·rw_track 사본을 rw_cache 에 보관하고, 새 어르신 사본을 꺼낸다.
 *  처음 고르는 것(이전 어르신 없음)이고 새 어르신 사본에 연결 코드가 없으면, 이 폰의 기존 rw_track 은 그 어르신 것으로 남긴다. null → 고른 어르신 없음 */
export function setCurrentElder(e) {
  const prev = currentElder();
  if (prev) {
    const c = readCache(prev.id);
    for (const f of Object.keys(EMPTY)) c[f] = readWorking(f);
    const t = jget(TRACK_KEY, null);
    if (t) c.track = t; else delete c.track;
    writeCache(prev.id, c);
  }
  if (!e || !e.id) {
    del(ELDER_KEY);
    if (prev) { for (const f of Object.keys(EMPTY)) writeWorking(f, null); del(TRACK_KEY); }
    return;
  }
  jset(ELDER_KEY, { id: e.id, label: e.label ?? "", role: e.role ?? "member" });
  if (prev?.id === e.id) return;
  const hasCache = rawGet(cacheKey(e.id)) !== null;
  const c = readCache(e.id);
  if (hasCache || prev) for (const f of Object.keys(EMPTY)) writeWorking(f, f in c ? c[f] : null);
  if (c.track) jset(TRACK_KEY, c.track); else if (prev) del(TRACK_KEY);
}

/** 그 어르신의 이 폰 사본을 모두 지운다 (서버가 GONE) */
function forget(elderId) {
  del(cacheKey(elderId)); setDirty(elderId, []); del(homeKeyFor(elderId));
  const list = jget(ELDERS_KEY, null);
  if (Array.isArray(list)) jset(ELDERS_KEY, list.filter((x) => x?.id !== elderId));
  if (currentElder()?.id === elderId) { del(ELDER_KEY); for (const f of Object.keys(EMPTY)) writeWorking(f, null); del(TRACK_KEY); }
  emit({ type: "gone", elderId });
}

/** data.load 응답 → 사본 반영. "ok" | "gone"(GONE: 그 어르신 사본·rw_elder 삭제) | "offline"(그 밖의 실패: 이 폰 사본 그대로) */
export function applyLoadResult(res, elderId) {
  if (res?.ok && res.data) {
    const d = res.data, c = readCache(elderId), isCur = currentElder()?.id === elderId, dirty = dirtyOf(elderId);
    const base = {};
    for (const f of Object.keys(EMPTY)) {
      const srv = d[f] ?? EMPTY[f];
      base[f] = clone(srv);
      const local = isCur ? readWorking(f) : (c[f] ?? EMPTY[f]);
      // 응답을 기다리는 사이 이 폰에서 고친 칸은 지우지 않는다 (다음 올리기 때 보냄)
      c[f] = !dirty.includes(f) ? srv : f === "diary" ? mergeDiary(local, srv) : local;
      if (isCur) writeWorking(f, c[f]);
    }
    c.updated_at = d.updated_at ?? null; c.base = base;
    writeCache(elderId, c);
    return "ok";
  }
  if (res?.reason === "GONE" || res?.reason === "NOT_MEMBER") { forget(elderId); return "gone"; }
  return "offline";
}

// ---------------------------------------------------------------- 올리기
/** store.set 훅: SYNCED 키가 바뀌면 현재 어르신 사본에 적고 올리기 예약 */
function onStoreSet(key, value) {
  const f = FIELD[key]; const e = currentElder();
  if (!f || !e) return;
  const c = readCache(e.id); c[f] = clone(value) ?? EMPTY[f]; writeCache(e.id, c);
  push(key);
}
/** 이 모듈을 import 하면 등록된다. 테스트가 훅을 바꾼 뒤 되돌릴 때 부른다 */
export function installSync() { setStoreHook(onStoreSet); }
installSync();

/** key 를 현재 어르신의 "못 올린 변경"으로 표시하고 1초 뒤 올린다 (그 사이 또 바뀌면 한 번에) */
export function push(key) {
  const f = FIELD[key]; const e = currentElder();
  if (!f || !e) return;
  setDirty(e.id, [...dirtyOf(e.id), f]);
  clearTimeout(timer);
  timer = setTimeout(() => { timer = null; for (const id of Object.keys(jget(DIRTY_KEY, {}) || {})) flush(id).catch(() => {}); }, DEBOUNCE_MS);   // 그 사이 어르신을 바꿨어도 모두
  timer?.unref?.();
}

let chain = Promise.resolve();
/** 못 올린 변경을 지금 올린다. → "ok" | "offline" | "gone" | "conflict"(서버 값으로 바뀐 칸이 있음) | "error"(서버가 받지 않음 — 버림) */
export function flush(elderId = currentElder()?.id) {
  clearTimeout(timer); timer = null;
  const p = chain.then(() => (elderId ? saveNow(elderId) : "ok"));
  chain = p.catch(() => {});
  return p;
}

async function saveNow(elderId) {
  let fields = dirtyOf(elderId);
  if (!fields.length) return "ok";
  let conflicted = false;
  for (let attempt = 0; attempt <= MAX_RESAVE && fields.length; attempt++) {
    const c = readCache(elderId), isCur = currentElder()?.id === elderId, home = homeFor(elderId);
    const local = {}, up = {};
    for (const f of fields) { local[f] = isCur ? readWorking(f) : (c[f] ?? EMPTY[f]); up[f] = sanitizeForUpload(KEY_OF[f], local[f], home); }
    const res = await call({ action: "data.save", elderId, ...up, base: c.updated_at ?? null });
    if (res?.ok) {
      const c2 = readCache(elderId);
      c2.updated_at = res.updated_at ?? c2.updated_at ?? null;
      c2.base = { ...(c2.base ?? {}), ...clone(up) };
      writeCache(elderId, c2);
      // 보내는 사이 또 고친 칸은 남긴다
      const now = isCur ? Object.fromEntries(fields.map((f) => [f, readWorking(f)])) : null;
      setDirty(elderId, dirtyOf(elderId).filter((f) => !fields.includes(f) || (now && !same(now[f], local[f]))));
      emit({ type: "saved", elderId });
      return conflicted ? "conflict" : "ok";
    }
    if (res?.reason === "GONE") { forget(elderId); return "gone"; }
    if (res?.reason === "CONFLICT" && res.data) {
      const srv = res.data, c2 = readCache(elderId), base = c2.base ?? null, resave = [];
      const late = dirtyOf(elderId).filter((f) => !fields.includes(f));   // 응답을 기다리는 사이 이 폰에서 고친 칸
      for (const f of Object.keys(EMPTY)) {
        const sv = srv[f] ?? EMPTY[f];
        if (late.includes(f)) {   // 지우지 않고 다음에 보냄 (일지는 서버 것과 합쳐서)
          const mine = currentElder()?.id === elderId ? readWorking(f) : (c2[f] ?? EMPTY[f]);
          c2[f] = f === "diary" ? mergeDiary(mine, sv) : mine; resave.push(f); continue;
        }
        if (!fields.includes(f)) { c2[f] = sv; continue; }   // 내가 안 고친 칸은 서버 값
        if (f === "diary") {
          const merged = mergeDiary(local.diary, sv);
          c2.diary = merged;
          if (!same(sanitizeForUpload(KEYS.diary, merged, home), sv)) resave.push("diary");
          continue;
        }
        const untouched = base ? same(sv, base[f] ?? EMPTY[f]) : same(sv, EMPTY[f]);   // 다른 가족은 이 칸을 안 고쳤다
        if (untouched) { c2[f] = local[f]; resave.push(f); }
        else { c2[f] = sv; conflicted = true; emit({ type: "conflict", key: KEY_OF[f], elderId, text: CONFLICT_TEXT }); }
      }
      c2.updated_at = srv.updated_at ?? null;
      c2.base = Object.fromEntries(Object.keys(EMPTY).map((f) => [f, clone(srv[f] ?? EMPTY[f])]));
      writeCache(elderId, c2);
      if (currentElder()?.id === elderId) for (const f of Object.keys(EMPTY)) writeWorking(f, c2[f]);
      setDirty(elderId, resave);
      fields = resave;
      continue;
    }
    if (isTransient(res?.reason)) { emit({ type: "offline", elderId, reason: res?.reason }); return "offline"; }
    setDirty(elderId, []);   // 다시 보내도 같은 답 (BAD_INPUT 등) — 이 폰 사본은 그대로 두고 올리기는 포기
    emit({ type: "error", elderId, reason: res?.reason });
    return "error";
  }
  return fields.length ? "offline" : conflicted ? "conflict" : "ok";
}

// ---------------------------------------------------------------- 불러오기·어르신 목록
/** 현재 어르신 데이터를 서버에서 받아 사본 갱신. 못 올린 변경이 있으면 먼저 올린다.
 *  → "ok" | "offline"(서버 장애·네트워크 — 이 폰의 마지막 사본으로 계속) | "gone"(그 어르신 사본을 지웠음) */
export async function pull() {
  const e = currentElder();
  if (!e) return "ok";
  if (dirtyOf(e.id).length) {
    const r = await flush(e.id);
    if (r === "gone") return "gone";
    if (dirtyOf(e.id).length) return "offline";   // 아직 못 올림 — 서버 값으로 덮지 않는다
  }
  const r = applyLoadResult(await call({ action: "data.load", elderId: e.id }), e.id);
  return r;
}

/** 내 어르신 목록 [{id,label,role}] (me). 서버가 안 되면 이 폰에 마지막으로 받은 목록.
 *  현재 어르신이 목록에 없으면(내보내졌거나 지워짐) 그 사본을 지운다 */
export async function listElders() {
  const res = await call({ action: "me" });
  if (!res?.ok || !Array.isArray(res.elders)) { const l = jget(ELDERS_KEY, []); return Array.isArray(l) ? l : []; }
  const list = res.elders.filter((x) => x && typeof x.id === "string").map((x) => ({ id: x.id, label: x.label ?? "", role: x.role ?? "member" }));
  jset(ELDERS_KEY, list);
  const cur = currentElder();
  if (cur) {
    const mine = list.find((x) => x.id === cur.id);
    if (!mine) forget(cur.id);
    else if (mine.label !== cur.label || mine.role !== cur.role) jset(ELDER_KEY, mine);
  }
  return list;
}

/** 새 어르신 등록 (나는 owner). → {ok:true, elder, deviceCode} | {ok:false, reason}. 새 연결 코드는 그 어르신 사본(track)에 둔다. 현재 어르신은 바꾸지 않는다 */
export async function createElder(label) {
  const res = await call({ action: "elder.create", label: String(label ?? "").trim() });
  if (!res?.ok || !res.elder?.id) return { ok: false, reason: res?.reason ?? "UNKNOWN" };
  const c = readCache(res.elder.id);
  if (res.deviceCode) c.track = { key: res.deviceCode, created: new Date().toISOString() };
  writeCache(res.elder.id, c);
  const list = jget(ELDERS_KEY, []);
  jset(ELDERS_KEY, [...(Array.isArray(list) ? list : []).filter((x) => x?.id !== res.elder.id), res.elder]);
  return { ok: true, elder: res.elder, deviceCode: res.deviceCode ?? null };
}

// ---------------------------------------------------------------- 계정
/** 로그인한 사용자 id 를 이 폰의 주인(rw_owner_user)과 비교. 다르면 이전 계정 사본을 모두 지운다 (집 주소·연결 코드·이메일은 그대로).
 *  → "first"(이 폰 첫 로그인) | "same" | "switched" */
export function checkAccount(userId) {
  if (!userId) return "same";
  const owner = jget(OWNER_KEY, null);
  if (owner === userId) return "same";
  jset(OWNER_KEY, userId);
  if (owner === null) return "first";
  for (const k of allKeys()) if (k.startsWith(CACHE_PREFIX)) del(k);
  for (const k of [...SYNCED, ELDER_KEY, ELDERS_KEY, DIRTY_KEY]) del(k);
  clearTimeout(timer); timer = null;
  return "switched";
}

const IMPORT_TEXT = {
  DEVICE_TAKEN: "이 폰에 있던 어르신 폰 연결 코드는 이미 다른 어르신에 연결돼 있어요. 설정에서 새 연결 코드를 확인해 주세요.",
  DEVICE_REVOKED: "이 폰에 있던 어르신 폰 연결 코드는 더 이상 쓸 수 없어요. 설정에서 새 연결 코드를 어르신 폰에 넣어 주세요.",
  OTHER: "어르신 폰 연결 코드는 옮기지 못했어요. 설정에서 새 연결 코드를 확인해 주세요.",
};
/** 첫 로그인 + 어르신 0명 + 이 폰에 기존 rw_profile → "이 폰의 등록 정보를 새 어르신으로 올릴까요?"
 *  예 → elder.create(호칭) → data.save(정리한 등록·일지·기록) → rw_track 이 있으면 device.import. 그 어르신이 현재 어르신이 된다.
 *  ask(text) → boolean | Promise<boolean>. 사용자마다 한 번만 묻는다(rw_import_asked).
 *  → {skipped:true} | {ok:true, elder, message?} (message = 연결 코드를 못 옮겼을 때 보여 줄 한 줄) | {ok:false, reason} */
export async function importLocalData({ elders, userId, ask }) {
  const profile = jget(KEYS.profile, null);
  if (!profile || (Array.isArray(elders) && elders.length) || !userId || jget(ASKED_KEY, null) === userId) return { skipped: true };
  jset(ASKED_KEY, userId);
  if (!(await ask("이 폰의 등록 정보를 새 어르신으로 올릴까요?"))) return { skipped: true };

  const local = { profile, diary: jget(KEYS.diary, []) ?? [], incidents: jget(KEYS.incidents, []) ?? [] };
  const legacyTrack = jget(TRACK_KEY, null);
  const label = String(profile.honorific ?? "").trim().slice(0, 20) || "어르신";
  const made = await createElder(label);
  if (!made.ok) { del(ASKED_KEY); return { ok: false, reason: made.reason }; }   // 다음에 다시 물을 수 있게
  const id = made.elder.id, home = homeFor(id);

  const c = readCache(id);
  Object.assign(c, clone(local));
  const up = Object.fromEntries(Object.keys(EMPTY).map((f) => [f, sanitizeForUpload(KEY_OF[f], local[f], home)]));
  const saved = await call({ action: "data.save", elderId: id, ...up, base: null });
  if (saved?.ok) { c.updated_at = saved.updated_at ?? null; c.base = clone(up); }
  let message;
  if (legacyTrack?.key) {
    const r = await call({ action: "device.import", elderId: id, key: legacyTrack.key });
    if (r?.ok) c.track = legacyTrack;
    else message = IMPORT_TEXT[r?.reason] ?? IMPORT_TEXT.OTHER;
  }
  writeCache(id, c);
  // 현재 어르신으로: 이전 어르신이 없으니 사본(=이 폰 데이터)을 그대로 꺼낸다. 옛 집 주소(rw_home)는 첫 getHome 때 이 어르신 키로 옮겨진다
  del(ELDER_KEY);
  setCurrentElder(made.elder);
  if (!saved?.ok) setDirty(id, Object.keys(EMPTY));   // 못 올렸으면 다음 pull 때 다시
  if (!jget(homeKeyFor(id), null) && jget("rw_home", null)) { jset(homeKeyFor(id), jget("rw_home", null)); del("rw_home"); }
  return message ? { ok: true, elder: made.elder, message } : { ok: true, elder: made.elder };
}

