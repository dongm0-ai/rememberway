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
// - 다른 계정으로 로그인 → 모든 rw_cache:*·SYNCED 키 삭제 (집 주소·연결 코드·이메일은 그대로). 집 주소는 기기에만 있어 지우면 되살릴 수 없으므로
//   이전 계정 어르신의 rw_home:<id> 는 계속 남긴다 — 이 계정이 가졌다가 잃은(GONE·목록에서 사라진) 어르신의 집 주소만 지운다.
// - import 할 때는 window/localStorage 를 건드리지 않는다 (Node 테스트). store 훅만 등록한다 — 호출될 때 읽는다.
import { KEYS, setStoreHook, homeFor, homeKeyFor } from "./common.js";
import { authFetch } from "./auth.js";
import { ARRIVE_M, addressLike } from "../lib/schema.js";
import { haversineM } from "../lib/priority.js";

export const SYNCED = [KEYS.profile, KEYS.diary, KEYS.incidents];
export const CONFLICT_TEXT = "다른 가족이 먼저 고쳤어요";
const FIELD = { [KEYS.profile]: "profile", [KEYS.diary]: "diary", [KEYS.incidents]: "incidents" };
const KEY_OF = { profile: KEYS.profile, diary: KEYS.diary, incidents: KEYS.incidents };
const EMPTY = { profile: null, diary: [], incidents: [] };
const ELDER_KEY = "rw_elder", ELDERS_KEY = "rw_elders", OWNER_KEY = "rw_owner_user", DIRTY_KEY = "rw_dirty", TRACK_KEY = "rw_track", ASKED_KEY = "rw_import_asked";
const CREATED_KEY = "rw_created";   // 이 폰이 방금 만든 어르신 { <id>: {t, elder, pending?} } — 서버 me 의 답이 만들기 전 것이어도 잊지 않으려는 표시
const FRESH_MS = 30000, PENDING_MS = 300000;   // 만든 뒤 30초 (importLocalData 가 아직 올리는 중이면 최대 5분)
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
/** 동기화 소식 받기. e = {type:"conflict", key, elderId, text} | {type:"gone", elderId} | {type:"saved"|"offline"|"error", elderId, reason?}
 *  | {type:"elder-changed", elderId, pinned, key} (다른 탭에서 어르신을 바꿔 이 탭의 변경을 올리지 않음). 해제 함수를 돌려준다.
 *  브라우저에서는 window 의 "rw-sync" CustomEvent(detail = e)로도 나간다 */
export function onSync(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(e) {
  for (const fn of listeners) { try { fn(e); } catch {} }
  try { if (typeof globalThis.dispatchEvent === "function" && typeof CustomEvent === "function") globalThis.dispatchEvent(new CustomEvent("rw-sync", { detail: e })); } catch {}
}

// ---------------------------------------------------------------- 서버 호출 (테스트는 바꿔 끼운다)
let transport = (body) => authFetch(body);
let timer = null;
let generation = 0;   // 다른 계정으로 로그인하면 올라간다 — 그 전에 보낸 요청의 응답은 버린다
/** 테스트용: 서버 호출 함수 바꾸기 (대기 중인 올리기도 취소) */
export function _setTransport(fn) { transport = fn; clearTimeout(timer); timer = null; }
async function call(body) { try { return (await transport(body)) ?? { ok: false, reason: "NETWORK" }; } catch { return { ok: false, reason: "NETWORK" }; } }

// ---------------------------------------------------------------- 순수 함수
const unionBy = (a, b, keyOf) => { const m = new Map(); for (const x of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) if (x && !m.has(keyOf(x))) m.set(keyOf(x), x); return [...m.values()]; };
/** 같은 날 AI가 뽑은 것 합치기: 장소·언급은 이름으로 합집합, 특이사항은 둘이 다르면 둘 다 (서버 것 먼저) */
function mergeExtracted(s, l) {
  if (!s || typeof s !== "object") return l;
  if (!l || typeof l !== "object") return s;
  const notes = [...new Set([s.notes, l.notes].filter((x) => typeof x === "string" && x.trim()))];
  return { ...s, ...l,
    new_places: unionBy(s.new_places, l.new_places, (p) => p?.name ?? JSON.stringify(p)),
    mentions: unionBy(s.mentions, l.mentions, (m) => `${m?.place ?? ""}|${m?.kind ?? ""}`),
    notes: notes.length ? notes.join(" / ") : null };
}
/** 일지 합치기: 날짜별, 날짜순. 같은 날이면 visited·coords·extracted(장소·언급·특이사항)는 합집합, 나머지 칸은 이 폰 쪽 우선.
 *  지운 날은 따로 기록하지 않으므로, 한쪽에서 지운 날이 다른 쪽에 남아 있으면 합칠 때 되살아난다 (일지는 지우는 일이 드물고, 잃는 것보다 낫다) */
export function mergeDiary(local, server) {
  const byDate = new Map();
  for (const e of Array.isArray(server) ? server : []) if (e && e.date) byDate.set(String(e.date), clone(e));
  for (const e of Array.isArray(local) ? local : []) {
    if (!e || !e.date) continue;
    const s = byDate.get(String(e.date));
    if (!s) { byDate.set(String(e.date), clone(e)); continue; }
    const m = { ...s, ...clone(e), visited: [...new Set([...(s.visited ?? []), ...(e.visited ?? [])])] };
    if (s.coords || e.coords) m.coords = { ...(s.coords ?? {}), ...(e.coords ?? {}) };
    if (s.extracted || e.extracted) m.extracted = mergeExtracted(clone(s.extracted), clone(e.extracted));
    if (m.visited.length) { m.stayed_home = false; m.unknown = false; }   // 누군가 다녀온 곳을 적었으면 "집에만"·"모름"은 맞지 않다
    byDate.set(String(e.date), m);
  }
  return [...byDate.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

const RAW_SPEECH = new Set(["utterance", "narrative", "spoken", "raw"]);   // 보호자가 말하거나 쓴 원문 전체
const POINT_ONLY = new Set(["lat", "lng", "lon", "acc", "accuracy", "time", "t", "gps_time", "received_at", "speed_kmh"]);
/** 서버로 올리기 전 정리 (입력은 바꾸지 않는다): 원문 칸 삭제, 집(home)에서 ARRIVE_M 안의 점 삭제,
 *  주소처럼 보이는 장소 이름(addressLike)은 등록 장소(profile.places)·일지 다녀온 곳(visited·coords)에서 뺀다.
 *  점만 있는 객체({lat,lng})는 통째로, 장소처럼 이름이 있는 객체는 좌표(lat/lng/distance_m)만 지운다 — 이름은 남는다 */
export function sanitizeForUpload(key, value, home) {
  if (value === null || value === undefined) return value ?? null;
  const v = clone(value);
  const h = home && Number.isFinite(Number(home.lat)) && Number.isFinite(Number(home.lng)) ? { lat: Number(home.lat), lng: Number(home.lng) } : null;
  const num = (x) => (typeof x === "number" ? x : typeof x === "string" && x.trim() !== "" ? Number(x) : NaN);   // "36.3" 같은 글자 숫자도
  const near = (lat, lng) => h && Number.isFinite(lat) && Number.isFinite(lng) && haversineM(h.lat, h.lng, lat, lng) <= ARRIVE_M;
  const nearHome = (o) => near(num(o.lat), num(o.lng ?? o.lon));
  const isTuple = (a) => a.length === 2 && a.every((x) => Number.isFinite(num(x)));   // [lat, lng]
  const walk = (node) => {   // false 를 돌려주면 부모에서 지운다
    if (!node || typeof node !== "object") return true;
    if (Array.isArray(node)) {
      if (isTuple(node) && near(num(node[0]), num(node[1]))) return false;
      for (let i = node.length - 1; i >= 0; i--) if (!walk(node[i])) node.splice(i, 1);
      return true;
    }
    for (const k of Object.keys(node)) if (RAW_SPEECH.has(k)) delete node[k];
    if (nearHome(node)) {
      if (Object.keys(node).every((k) => POINT_ONLY.has(k))) return false;
      delete node.lat; delete node.lng; delete node.lon; delete node.distance_m;
    }
    for (const k of Object.keys(node)) if (!walk(node[k])) delete node[k];
    return true;
  };
  if (key === KEYS.profile && v && typeof v === "object") {
    delete v.home; delete v.rw_home;   // 집 주소 자체는 절대 올리지 않는다
    // 주소처럼 적은 장소 이름("대종로 12번길 3")은 집 주소일 수 있다 — 서버로 보내지 않는다 (이 폰 사본에는 남는다)
    if (Array.isArray(v.places)) v.places = v.places.filter((p) => !addressLike(p?.name));
  }
  if (key === KEYS.diary && Array.isArray(v)) {
    for (const e of v) {
      if (!e || typeof e !== "object") continue;
      if (Array.isArray(e.visited)) e.visited = e.visited.filter((n) => !addressLike(n));
      if (e.coords && typeof e.coords === "object") for (const n of Object.keys(e.coords)) if (addressLike(n)) delete e.coords[n];
    }
  }
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

// ---------------------------------------------------------------- 이 화면(탭)의 어르신
// rw_elder 는 탭끼리 같이 쓴다. 다른 탭에서 어르신을 바꾼 뒤 이 탭의 화면이 store.set 하면, 이 탭이 들고 있던 옛 어르신 값이
// 새 어르신 사본으로 올라가 버린다. 그래서 이 탭이 고른 어르신(pinned)을 기억하고, 훅이 불릴 때 rw_elder 가 다르면 올리지 않는다.
let pinned;   // undefined = 아직 모름(검사 안 함) · null = 이 탭은 어르신 없음 · "<id>"
/** 이 탭이 보고 있는 어르신 id 를 기억 (셸이 화면을 붙일 때·setCurrentElder 가 부른다) */
export function pinElder(id) { pinned = typeof id === "string" && id ? id : id === undefined ? undefined : null; }
/** 이 탭이 기억한 어르신 id (undefined = 아직 모름) */
export const pinnedElder = () => pinned;

// 찾기 흐름의 단서·되묻기 상태(sessionStorage)는 그 어르신 것이다 — 어르신이 바뀌면 지운다 (다른 어르신의 단서를 쓰지 않게)
const SESSION_SCOPED = [KEYS.clue, KEYS.mode, KEYS.utterance, "rw_memory_done"];
const SESSION_ELDER = "rw_session_elder";
/** 이 탭의 찾기 흐름 상태가 어느 어르신 것인지 적고, 다른 어르신이면 지운다. 어르신 없음(null)으로는 지우지 않는다
 *  (어르신 없이 찾기를 시작한 뒤 등록하는 경우 단서를 이어 쓴다) */
export function scopeSession(elderId) {
  const ss = globalThis.sessionStorage;
  if (!ss || typeof elderId !== "string" || !elderId) return;
  try {
    const prev = ss.getItem(SESSION_ELDER);
    if (prev && prev !== elderId) for (const k of SESSION_SCOPED) ss.removeItem(k);
    ss.setItem(SESSION_ELDER, elderId);
  } catch {}
}

const BACKUP_PREFIX = "rw_backup_";
const LEGACY_HOME = homeKeyFor(null);   // "rw_home"
const HOME_PREFIX = homeKeyFor("x").slice(0, -1);   // "rw_home:"
/** 어르신을 고르지 않은 상태의 이 폰 데이터(SYNCED 키·rw_track·옛 rw_home)를 어느 어르신에도 넘기지 않고 따로 보관한 뒤 비운다.
 *  보관 키 "rw_backup_<시각>" — 이 폰에만, 서버로 올리지 않는다. 보관할 게 없으면 null.
 *  어르신을 고르기 전에 저장한 집 주소(옛 rw_home)도 여기로 들어간다: 처음 고른 어르신에게 자동으로 붙지 않는다 (importLocalData 로 올려 만든 어르신만 그 집 주소를 이어받는다).
 *  그 밖에는 설정에서 집 주소를 다시 넣어야 하고, 이전 값은 이 보관본에 남는다 */
function backupPhoneData() {
  const b = {};
  for (const f of Object.keys(EMPTY)) { const v = jget(KEY_OF[f], null); if (v !== null) b[f] = v; }
  const t = jget(TRACK_KEY, null), h = jget(LEGACY_HOME, null);
  if (t !== null) b.track = t;
  if (h !== null) b.home = h;
  if (!Object.keys(b).length) return null;
  let k = BACKUP_PREFIX + Date.now();
  while (rawGet(k) !== null) k += "_";
  jset(k, { ...b, saved_at: new Date().toISOString() });
  for (const f of Object.keys(EMPTY)) writeWorking(f, null);
  del(TRACK_KEY); del(LEGACY_HOME);
  return k;
}
const BACKUP_NOTICE_KEY = "rw_notice_backup";   // "rw_backup_" 로 시작하면 보관본으로 보이니 다른 이름
/** 방금 옛 데이터를 보관했다는 표시를 꺼내고 지운다 (한 번만 알리게). → 보관 키 | null */
export function takeBackupNotice() { const k = jget(BACKUP_NOTICE_KEY, null); if (k !== null) del(BACKUP_NOTICE_KEY); return typeof k === "string" && rawGet(k) !== null ? k : null; }
/** 이 폰에 따로 보관된 옛 데이터 키 목록 (설정 화면에서 안내·삭제용) */
export function phoneBackups() { return allKeys().filter((k) => k.startsWith(BACKUP_PREFIX)).sort(); }

/** 사본을 현재 SYNCED 키·rw_track 으로 꺼낸다 */
function loadWorking(id) {
  const c = readCache(id);
  for (const f of Object.keys(EMPTY)) writeWorking(f, f in c ? c[f] : null);
  if (c.track) jset(TRACK_KEY, c.track); else del(TRACK_KEY);
}

/** 현재 어르신 바꾸기: 떠나는 어르신의 SYNCED 키·rw_track 사본을 rw_cache 에 보관하고, 새 어르신 사본을 꺼낸다.
 *  이전 어르신이 없을 때 이 폰에 남아 있던 데이터(계정 전 데이터, 다른 계정의 연결 코드 등)는 고른 어르신에 넘기지 않고 rw_backup_* 으로 옮긴다
 *  (그 데이터를 어르신으로 올리는 건 importLocalData 만). null → 고른 어르신 없음 */
export function setCurrentElder(e) {
  pinElder(e?.id ?? null);
  scopeSession(e?.id);
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
  if (prev?.id === e.id) { jset(ELDER_KEY, { id: e.id, label: e.label ?? "", role: e.role ?? "member" }); return; }
  if (!prev) { const k = backupPhoneData(); if (k) jset(BACKUP_NOTICE_KEY, k); }   // 셸이 다음 화면에서 "옛 정보는 따로 보관했어요" 한 번 알림
  jset(ELDER_KEY, { id: e.id, label: e.label ?? "", role: e.role ?? "member" });
  loadWorking(e.id);
}

/** 그 어르신의 이 폰 사본을 모두 지운다 (서버가 GONE, 또는 내 목록에 없음). 집 주소도 지우고 이벤트로 알린다 */
function forget(elderId) {
  const homeRemoved = rawGet(homeKeyFor(elderId)) !== null;
  del(cacheKey(elderId)); setDirty(elderId, []); del(homeKeyFor(elderId));
  const list = jget(ELDERS_KEY, null);
  if (Array.isArray(list)) jset(ELDERS_KEY, list.filter((x) => x?.id !== elderId));
  const wasCurrent = currentElder()?.id === elderId;
  if (wasCurrent) { del(ELDER_KEY); for (const f of Object.keys(EMPTY)) writeWorking(f, null); del(TRACK_KEY); }
  emit({ type: "gone", elderId, homeRemoved, wasCurrent });
}

/** data.load 응답 → 사본 반영. "ok" | "gone"(GONE: 그 어르신 사본·rw_elder 삭제) | "offline"(그 밖의 실패: 이 폰 사본 그대로) */
export function applyLoadResult(res, elderId) {
  if (res?.ok && res.data) {
    const d = res.data, c = readCache(elderId), isCur = currentElder()?.id === elderId, dirty = dirtyOf(elderId), home = homeFor(elderId);
    const base = {};
    for (const f of Object.keys(EMPTY)) {
      const srv = d[f] ?? EMPTY[f];
      base[f] = clone(srv);
      const local = isCur ? readWorking(f) : (c[f] ?? EMPTY[f]);
      // 응답을 기다리는 사이 이 폰에서 고친 칸은 지우지 않는다 (다음 올리기 때 보냄).
      // 서버 값이 이 폰 사본을 정리한 것과 같으면 이 폰 사본(원문·집 근처 좌표가 남은 것)을 그대로 둔다
      if (dirty.includes(f)) c[f] = f === "diary" ? mergeDiary(local, srv) : local;
      else c[f] = same(srv, sanitizeForUpload(KEY_OF[f], local, home)) ? local : srv;
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
/** store.set 훅: SYNCED 키가 바뀌면 현재 어르신 사본에 적고 올리기 예약.
 *  다른 탭에서 어르신을 바꿨으면(rw_elder ≠ 이 탭의 어르신) 올리지 않고, 방금 덮인 이 폰 사본을 지금 어르신 값으로 되돌린 뒤 "elder-changed" 를 알린다 */
function onStoreSet(key, value) {
  const f = FIELD[key]; const e = currentElder();
  if (!f || !e) return;
  if (pinned !== undefined && e.id !== pinned) {
    const c = readCache(e.id);
    writeWorking(f, f in c ? c[f] : null);
    emit({ type: "elder-changed", elderId: e.id, pinned, key });
    return;
  }
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
  const g = generation;
  for (let attempt = 0; attempt <= MAX_RESAVE && fields.length; attempt++) {
    const c = readCache(elderId), isCur = currentElder()?.id === elderId, home = homeFor(elderId);
    const local = {}, up = {};
    for (const f of fields) { local[f] = isCur ? readWorking(f) : (c[f] ?? EMPTY[f]); up[f] = sanitizeForUpload(KEY_OF[f], local[f], home); }
    const res = await call({ action: "data.save", elderId, ...up, base: c.updated_at ?? null });
    if (g !== generation) return "offline";   // 기다리는 사이 다른 계정으로 로그인했다 — 이전 계정 사본을 되살리지 않는다
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
      // 응답을 받은 지금의 이 폰 값으로 판단한다 (기다리는 사이 같은 칸·다른 칸을 또 고쳤을 수 있다 — 훅이 사본에 바로 적는다)
      const srv = res.data, c2 = readCache(elderId), base = c2.base ?? null, resave = [];
      const mineNow = (f) => (currentElder()?.id === elderId ? readWorking(f) : (c2[f] ?? EMPTY[f]));
      const dirtyNow = new Set([...fields, ...dirtyOf(elderId)]);
      for (const f of Object.keys(EMPTY)) {
        const sv = srv[f] ?? EMPTY[f];
        if (!dirtyNow.has(f)) { c2[f] = sv; continue; }   // 내가 안 고친 칸은 서버 값
        const mine = mineNow(f);
        if (f === "diary") {
          const merged = mergeDiary(mine, sv);
          c2.diary = merged;
          if (!same(sanitizeForUpload(KEYS.diary, merged, home), sv)) resave.push("diary");
          continue;
        }
        const untouched = base ? same(sv, base[f] ?? EMPTY[f]) : same(sv, EMPTY[f]);   // 다른 가족은 이 칸을 안 고쳤다
        if (untouched) { c2[f] = mine; resave.push(f); }
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
  const g = generation;   // 올리는 동안 계정이 바뀌는 것도 알아채려고 먼저 잡는다
  if (dirtyOf(e.id).length) {
    const r = await flush(e.id);
    if (g !== generation) return "offline";
    if (r === "gone") return "gone";
    if (dirtyOf(e.id).length) return "offline";   // 아직 못 올림 — 서버 값으로 덮지 않는다
  }
  const res = await call({ action: "data.load", elderId: e.id });
  if (g !== generation) return "offline";
  return applyLoadResult(res, e.id);
}

/** 이 폰이 방금 만든 어르신 (아직 유효한 표시만). 낡은 표시는 지운다 */
function freshCreated() {
  const m = jget(CREATED_KEY, null), now = Date.now(), out = {};
  if (!m || typeof m !== "object") return out;
  for (const [id, v] of Object.entries(m)) { const age = now - Number(v?.t); if (v?.elder?.id === id && age < (v.pending ? PENDING_MS : FRESH_MS)) out[id] = v; }
  if (Object.keys(out).length !== Object.keys(m).length) { if (Object.keys(out).length) jset(CREATED_KEY, out); else del(CREATED_KEY); }
  return out;
}
const markCreated = (elder, pending) => jset(CREATED_KEY, { ...freshCreated(), [elder.id]: { t: Date.now(), elder, ...(pending ? { pending: true } : {}) } });
/** 올리는 중 표시를 끝낸다 (그 시각부터 30초는 더 지킨다) */
function settleCreated(id) { const f = freshCreated(); if (f[id]) jset(CREATED_KEY, { ...f, [id]: { t: Date.now(), elder: f[id].elder } }); }

/** 내 어르신 목록 [{id,label,role}] (me). 서버가 안 되면 이 폰에 마지막으로 받은 목록.
 *  이 계정이 알던 어르신(마지막 목록·이 폰 사본·현재 어르신)이 목록에서 사라졌으면 (내보내졌거나 지워짐) 사본·집 주소를 지운다 (현재 어르신이면 rw_elder 도).
 *  사본이 없이 집 주소만 남은 어르신은 이전 계정의 것일 수 있어 건드리지 않는다 (집 주소는 이 폰에만 있어 지우면 되살릴 수 없다).
 *  이 폰이 방금(30초 안) 만든 어르신은, 서버가 만들기 전에 낸 답에 없어도 잊지 않고 목록에 붙인다 */
export async function listElders() {
  const g = generation;
  const res = await call({ action: "me" });
  if (g !== generation || !res?.ok || !Array.isArray(res.elders)) { const l = jget(ELDERS_KEY, []); return Array.isArray(l) ? l : []; }
  const list = res.elders.filter((x) => x && typeof x.id === "string").map((x) => ({ id: x.id, label: x.label ?? "", role: x.role ?? "member" }));
  const ids = new Set(list.map((x) => x.id));
  for (const [id, v] of Object.entries(freshCreated())) if (!ids.has(id)) { list.push({ id, label: v.elder.label ?? "", role: v.elder.role ?? "owner" }); ids.add(id); }
  const known = new Set(), prev = jget(ELDERS_KEY, null);
  if (Array.isArray(prev)) for (const x of prev) if (x && typeof x.id === "string") known.add(x.id);
  for (const k of allKeys()) if (k.startsWith(CACHE_PREFIX)) known.add(k.slice(CACHE_PREFIX.length));
  const cur = currentElder();
  if (cur) known.add(cur.id);
  jset(ELDERS_KEY, list);
  for (const id of known) if (id && !ids.has(id)) forget(id);
  const now = currentElder(), mine = now && list.find((x) => x.id === now.id);
  if (mine && (mine.label !== now.label || mine.role !== now.role)) jset(ELDER_KEY, mine);
  return list;
}

/** 새 어르신 등록 (나는 owner). → {ok:true, elder, deviceCode} | {ok:false, reason}. 새 연결 코드는 그 어르신 사본(track)에 둔다. 현재 어르신은 바꾸지 않는다 */
export const createElder = (label) => makeElder(label, false);
async function makeElder(label, pending) {
  const g = generation;
  const res = await call({ action: "elder.create", label: String(label ?? "").trim() });
  if (g !== generation) return { ok: false, reason: "ACCOUNT_CHANGED" };
  if (!res?.ok || !res.elder?.id) return { ok: false, reason: res?.reason ?? "UNKNOWN" };
  markCreated(res.elder, pending);   // 같은 때 보낸 me 의 답이 이 어르신을 모르더라도 잊지 않도록
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
  generation++;
  for (const k of allKeys()) if (k.startsWith(CACHE_PREFIX)) del(k);
  for (const k of [...SYNCED, ELDER_KEY, ELDERS_KEY, DIRTY_KEY, CREATED_KEY]) del(k);
  clearTimeout(timer); timer = null;
  // 이전 계정의 연결 코드(rw_track)·집 주소(rw_home:<id>)는 지우지 않는다 (기기에만 있어 되살릴 수 없다). 새 계정에서 처음 어르신을 고를 때 rw_track 은
  // rw_backup_* 으로 옮겨져 어느 어르신에도 넘어가지 않고, rw_home:<id> 는 그 어르신의 id 로만 읽히니 다른 어르신에게 보이지 않는다 (listElders 도 지우지 않는다)
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
  const g = generation;   // 기다리는 사이(묻기·서버 호출) 다른 계정으로 로그인하면 이전 계정 일로 이 폰에 아무것도 쓰지 않는다
  const profile = jget(KEYS.profile, null);
  if (!profile || (Array.isArray(elders) && elders.length) || !userId || jget(ASKED_KEY, null) === userId) return { skipped: true };
  const yes = await ask("이 폰의 등록 정보를 새 어르신으로 올릴까요?");   // 창을 닫거나 오류면 아래로 가지 않아 다음에 다시 묻는다
  if (g !== generation) return { skipped: true };
  jset(ASKED_KEY, userId);
  if (!yes) return { skipped: true };

  const local = { profile, diary: jget(KEYS.diary, []) ?? [], incidents: jget(KEYS.incidents, []) ?? [] };
  const legacyTrack = jget(TRACK_KEY, null), legacyHome = jget(LEGACY_HOME, null);
  const label = [...String(profile.honorific ?? "").trim()].slice(0, 20).join("") || "어르신";   // 글자(코드 포인트) 20자 — 서버와 같은 기준
  const made = await makeElder(label, true);   // 올리는 동안은 "만드는 중" 표시를 붙여 둔다 (listElders 가 이 어르신을 잊지 않게)
  if (!made.ok) { if (jget(ASKED_KEY, null) === userId) del(ASKED_KEY); return { ok: false, reason: made.reason }; }   // 다음에 다시 물을 수 있게
  const id = made.elder.id;
  try {
    const home = homeFor(null);   // 아직 옮기기 전의 옛 집 주소
    const c = readCache(id);
    Object.assign(c, clone(local));
    const up = Object.fromEntries(Object.keys(EMPTY).map((f) => [f, sanitizeForUpload(KEY_OF[f], local[f], home)]));
    const saved = await call({ action: "data.save", elderId: id, ...up, base: null });
    if (g !== generation) return { ok: false, reason: "ACCOUNT_CHANGED" };
    if (saved?.ok) { c.updated_at = saved.updated_at ?? null; c.base = clone(up); }
    let message;
    if (legacyTrack?.key) {
      const r = await call({ action: "device.import", elderId: id, key: legacyTrack.key });
      if (g !== generation) return { ok: false, reason: "ACCOUNT_CHANGED" };
      if (r?.ok) c.track = legacyTrack;
      else message = IMPORT_TEXT[r?.reason] ?? IMPORT_TEXT.OTHER;
    }
    writeCache(id, c);
    // 이 폰 데이터를 넘겨받는 건 방금 만든 이 어르신뿐: 사본(=이 폰 데이터)·연결 코드를 꺼내고 옛 집 주소를 이 어르신 키로 옮긴다
    // (setCurrentElder 를 쓰지 않는다 — 그건 이 폰 데이터를 rw_backup_* 으로 치운다)
    jset(ELDER_KEY, { id, label: made.elder.label ?? label, role: made.elder.role ?? "owner" });
    pinElder(id); scopeSession(id);
    loadWorking(id);
    if (legacyHome !== null) { if (rawGet(homeKeyFor(id)) === null) jset(homeKeyFor(id), legacyHome); del(LEGACY_HOME); }
    if (!saved?.ok) setDirty(id, Object.keys(EMPTY));   // 못 올렸으면 다음 pull 때 다시
    return message ? { ok: true, elder: made.elder, message } : { ok: true, elder: made.elder };
  } finally { settleCreated(id); }
}
