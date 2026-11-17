// POST /api/loc — 목걸이 실시간 위치 중계 + 보호자 계정 데이터 API (2026-11-16 지도교사 결정: 초기에는 어르신 휴대폰 연동, 이후 유심 내장 GPS)
// Vercel 함수 12개 한도 때문에 계정 데이터 action 도 모두 여기 (공용 규칙은 lib/family.js).
//
// 로그인 없이 (연결 코드 key 로만):
//   {action:"push", key, p}         ← 어르신 휴대폰 앱(android/). p = 목걸이 위치 JSON (hardware/necklace, GPS_BLE 가이드 v1 형식)
//                                     폐기된 코드(revoked_devices: 어르신 삭제·연결 코드 재발급)는 410 GONE → 앱은 대기열 비우고 멈춤.
//                                     모르는 코드(계정 전 rw_track 코드 등)는 지금처럼 받는다. Origin 검사 없음(앱은 브라우저가 아님).
//   (연결 코드만으로 위치를 읽는 옛 {action:"latest", key} 는 없앴다 — 코드를 아는 누구나 어르신 위치를 볼 수 있었다. key 만 보내면 400 BAD_ACTION)
// 로그인 필요 (Authorization: Bearer <Supabase access token>, 우리 앱 Origin):
//   me · elder.create {label} · data.load {elderId} · data.save {elderId, profile?, diary?, incidents?, base}
//   invite.create {elderId} · invite.accept {token} · members.list {elderId} · members.remove {elderId, userId}
//   elder.leave {elderId} · elder.delete {elderId} · device.reset {elderId} · device.import {elderId, key} · account.withdraw
//   latest {elderId, limit}  ← 최근 위치들 (새것부터), member 누구나
//   places {elderId}         ← 최근 30일 기록에서 자주 머문 곳 (계산은 public/lib/gps.js, 원본 점은 보내지 않음), member 누구나
//   clear {elderId}          ← 위치 기록만 모두 지우기 (개인정보 보호법: 목적을 이루면 지체 없이 파기), owner 만
//   (places/clear 를 key 로 부르는 옛 방식은 더 이상 없음 — 로그인 + elderId)
//
// 응답 본문은 항상 { ok, reason?, ... }. HTTP 상태:
//   200 성공 (push 는 201) · 400 BAD_INPUT / BAD_KEY / BAD_ACTION / INVITE_NOT_FOUND / USE_LEAVE (요청 자체가 틀림)
//   401 AUTH (토큰 없음·무효 → 다시 로그인) · 403 NOT_OWNER / FORBIDDEN(Origin) · 404 GONE (어르신이 없거나 내가 member 가 아님 → 사본 지움)
//   409 CONFLICT(+data 서버 값) / INVITE_USED / INVITE_EXPIRED / DEVICE_TAKEN / DEVICE_REVOKED / NO_SUCH_MEMBER (지금 상태와 맞지 않음)
//   410 GONE (push 만: 폐기된 연결 코드) · 422 BAD_FIX · 429 RATE_LIMIT
//   503 AUTH_UNAVAILABLE (Auth 장애 — 로그인 화면으로 보내지 말 것) · NO_STORE · STORE_ERROR · AUTH_DELETE_FAILED
//   account.withdraw: 가족 데이터 정리(lib/family.js withdraw) 뒤 Supabase Auth 계정 삭제. Auth 삭제가 실패하면 503 AUTH_DELETE_FAILED —
//     이때 가족 데이터는 이미 정리됨. 다시 부르면 안전 (어르신이 없으니 바로 Auth 삭제만 다시, 이미 없는 계정(404)은 성공 취급).
// 보관 기간 30일 (지도교사 결정 2026-11-17, 근거 Bayat 외 2020 노인 GPS 4주). 30일이 지난 기록은 자동으로 지운다 (개인정보 보호법 제21조: 보유기간 경과 시 지체 없이 파기).
// key = 어르신 폰 연결 코드(무작위 16글자). 서버에는 해시(dev = elders.device_hash)만 남긴다. 생성형 AI는 쓰지 않는다 (위치는 측정값).
import { readJson, send, allowedOrigin, rateOk } from "../lib/http.js";
import { db as kvDb, kvReady } from "../lib/kv.js";
import { bearer, checkToken } from "../lib/auth.js";
import { familyApi, deviceHashOf } from "../lib/family.js";
import { GPS_WINDOW_DAYS, findStays, groupPlaces, trackSummary } from "../public/lib/gps.js";

const cutoff = (now) => new Date(now().getTime() - GPS_WINDOW_DAYS * 86400000).toISOString();
const purge = (db, now) => db("DELETE", `loc_events?received_at=lt.${cutoff(now)}`).catch(() => {});   // 모든 연결 코드의 30일 지난 기록

const KEY_RE = /^[A-Z2-7]{16}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const cleanKey = (k) => String(k ?? "").toUpperCase().replace(/[^A-Z2-7]/g, "");
const num = (v, lo, hi) => (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : null);

const STATUS = { BAD_INPUT: 400, INVITE_NOT_FOUND: 400, USE_LEAVE: 400, NOT_OWNER: 403, GONE: 404,
  CONFLICT: 409, INVITE_USED: 409, INVITE_EXPIRED: 409, DEVICE_TAKEN: 409, DEVICE_REVOKED: 409, NO_SUCH_MEMBER: 409 };
const LOGIN_ACTIONS = new Set(["me", "elder.create", "data.load", "data.save", "invite.create", "invite.accept", "members.list",
  "members.remove", "elder.leave", "elder.delete", "device.reset", "device.import", "account.withdraw", "latest", "places", "clear"]);

const out = (status, body) => ({ status, body });
/** family 결과 → HTTP. ok 는 200, 실패는 STATUS 표 (모르는 reason 은 400). 내부 표시(deleteAuthUser)는 내보내지 않음 */
function fromFamily(r) {
  if (r?.ok) { const { deleteAuthUser, ...rest } = r; return out(200, rest); }
  return out(STATUS[r?.reason] ?? 400, { ...r, ok: false });
}

/** Supabase Auth 계정 삭제 (service_role). 이미 없음(404)은 성공. 실패하면 던진다 */
export async function deleteAuthUser(id, fetchFn = fetch) {
  const base = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || "";
  const r = await fetchFn(`${base}/auth/v1/admin/users/${encodeURIComponent(id)}`, {
    method: "DELETE", headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(6000),
  });
  if (!r || (!r.ok && r.status !== 404)) throw Object.assign(new Error("auth delete failed " + r?.status), { reason: "AUTH_DELETE_FAILED" });
}

/** 위치 action 용 member 확인 (lib/family.js 의 access 와 같은 순서: member 먼저 → 아니면 어르신이 있든 없든 GONE).
 *  통과하면 { ok:true, dev, role } */
async function elderDevice(db, user, elderId, { owner = false } = {}) {
  if (!UUID_RE.test(String(user?.id ?? "")) || !UUID_RE.test(String(elderId ?? ""))) return { ok: false, reason: "BAD_INPUT" };
  const [m] = (await db("GET", `elder_members?elder_id=eq.${elderId}&user_id=eq.${user.id}&select=role`)) ?? [];
  if (!m) return { ok: false, reason: "GONE" };
  const [e] = (await db("GET", `elders?id=eq.${elderId}&select=device_hash`)) ?? [];
  if (!e) return { ok: false, reason: "GONE" };
  if (owner && m.role !== "owner") return { ok: false, reason: "NOT_OWNER" };
  return { ok: true, dev: e.device_hash || null, role: m.role };
}

async function readLatest(db, dev, limit, now) {
  await purge(db, now);
  const rows = dev ? await db("GET", `loc_events?dev=eq.${dev}&select=lat,lng,gps_time,received_at,speed_kmh&order=received_at.desc&limit=${limit}`) : [];
  return out(200, { ok: true, points: rows ?? [], now: now().toISOString() });
}

async function readPlaces(db, dev, now) {
  await purge(db, now);
  const pts = [];
  for (let off = 0; dev && off < 100000; off += 1000) {   // 30일치를 1000개씩 (함수 시간 한도 때문에 최대 10만 점)
    const rows = await db("GET", `loc_events?dev=eq.${dev}&received_at=gte.${cutoff(now)}&select=lat,lng,gps_time,received_at&order=received_at.asc&limit=1000&offset=${off}`);
    for (const r of rows ?? []) pts.push({ t: Date.parse(r.gps_time || r.received_at), lat: r.lat, lng: r.lng });
    if (!rows || rows.length < 1000) break;
  }
  pts.sort((a, c) => a.t - c.t);
  const { stays, rules } = findStays(pts);
  return out(200, { ok: true, track: trackSummary(pts), places: groupPlaces(stays), rules });   // 집 표시는 브라우저에서(집 주소는 서버로 보내지 않음)
}

async function push(b, db, now) {
  const key = cleanKey(b.key);
  if (!KEY_RE.test(key)) return out(400, { ok: false, reason: "BAD_KEY" });
  const dev = deviceHashOf(key);
  const p = b.p ?? {};
  const lat = num(p.latitude, -90, 90), lng = num(p.longitude, -180, 180), age = num(p.fix_age_ms, 0, 3000);
  if (lat === null || lng === null || age === null) return out(422, { ok: false, reason: "BAD_FIX" });
  if (((await db("GET", `revoked_devices?device_hash=eq.${dev}&select=device_hash`)) ?? []).length) return out(410, { ok: false, reason: "GONE" });
  const t = p.gps_time ? Date.parse(p.gps_time) : NaN;
  const row = { dev, lat, lng, fix_age_ms: Math.round(age), gps_time: Number.isFinite(t) ? new Date(t).toISOString() : null,
    speed_kmh: num(p.speed_kmh, 0, 500), seq: Number.isInteger(p.sequence) ? p.sequence : null, fw: typeof p.firmware_version === "string" ? p.firmware_version.slice(0, 32) : null };
  const o = await db("POST", "loc_events", row, "return=representation");
  if (Math.random() < 0.02) await purge(db, now);   // 가끔 한 번씩 (보호자 화면이 열릴 때도 지움)
  return out(201, { ok: true, accepted: true, event_id: o?.[0]?.id, received_at: o?.[0]?.received_at });
}

/**
 * 요청 하나 처리 (HTTP 없이 테스트 가능). 반환 { status, body }.
 * ctx = { user? | auth?: async () => ({user}|{error:"INVALID"|"UNAVAILABLE"}), db, fam, now?, storeReady?, deleteAuthUser? }
 *   user 가 없고 auth 도 없으면 로그인 안 한 요청. Origin·rate 검사는 handler 가 한다.
 */
export async function route(body, ctx) {
  const { db, fam, now = () => new Date(), storeReady = true } = ctx;
  const b = body && typeof body === "object" ? body : {};
  const action = b.action;
  if (action !== "push" && !LOGIN_ACTIONS.has(action)) return out(400, { ok: false, reason: "BAD_ACTION" });
  // 연결 코드(key)로 할 수 있는 건 push 뿐. 위치 읽기는 로그인 + member 만 (key 만 보낸 latest 는 400)
  if (action === "latest" && b.elderId == null && b.key != null) return out(400, { ok: false, reason: "BAD_ACTION" });

  try {
    if (action === "push") {
      if (!KEY_RE.test(cleanKey(b.key))) return out(400, { ok: false, reason: "BAD_KEY" });
      if (!storeReady) return out(503, { ok: false, reason: "NO_STORE" });   // 앱은 503이면 대기열에 두고 나중에 다시 보냄
      return await push(b, db, now);
    }

    // ---- 여기부터 로그인 필요 ----
    const who = ctx.user ? { user: ctx.user } : ctx.auth ? await ctx.auth() : { error: "INVALID" };
    if (!who?.user) return who?.error === "UNAVAILABLE" ? out(503, { ok: false, reason: "AUTH_UNAVAILABLE" }) : out(401, { ok: false, reason: "AUTH" });
    const user = who.user;
    if (!storeReady) return out(503, { ok: false, reason: "NO_STORE" });

    switch (action) {
      case "me": return fromFamily(await fam.me(user));
      case "elder.create": return fromFamily(await fam.createElder(user, { label: b.label }));
      case "data.load": return fromFamily(await fam.load(user, b.elderId));
      case "data.save": return fromFamily(await fam.save(user, b.elderId, { profile: b.profile, diary: b.diary, incidents: b.incidents, base: b.base }));
      case "invite.create": return fromFamily(await fam.inviteCreate(user, b.elderId));
      case "invite.accept": return fromFamily(await fam.inviteAccept(user, b.token));
      case "members.list": return fromFamily(await fam.members(user, b.elderId));
      case "members.remove": return fromFamily(await fam.removeMember(user, b.elderId, b.userId));
      case "elder.leave": return fromFamily(await fam.leave(user, b.elderId));
      case "elder.delete": return fromFamily(await fam.deleteElder(user, b.elderId));
      case "device.reset": return fromFamily(await fam.resetDevice(user, b.elderId));
      case "device.import": return fromFamily(await fam.importDevice(user, b.elderId, b.key));
      case "account.withdraw": {
        const r = await fam.withdraw(user);
        if (!r?.ok) return fromFamily(r);
        try { await (ctx.deleteAuthUser ?? deleteAuthUser)(user.id); }
        catch { return out(503, { ok: false, reason: "AUTH_DELETE_FAILED" }); }   // 가족 데이터는 이미 정리됨 — 다시 부르면 Auth 삭제만 다시
        return out(200, { ok: true });
      }
      case "latest": case "places": case "clear": {
        const a = await elderDevice(db, user, b.elderId, { owner: action === "clear" });
        if (!a.ok) return fromFamily(a);
        if (action === "latest") return await readLatest(db, a.dev, Math.min(Math.max(parseInt(b.limit) || 200, 1), 1000), now);
        if (action === "places") return await readPlaces(db, a.dev, now);
        if (a.dev) await db("DELETE", `loc_events?dev=eq.${a.dev}`);
        return out(200, { ok: true });
      }
    }
    return out(400, { ok: false, reason: "BAD_ACTION" });
  } catch (e) {
    return out(503, { ok: false, reason: e?.reason === "NO_STORE" ? "NO_STORE" : "STORE_ERROR" });
  }
}

// 호출량: AI 키를 지키는 공용 제한(분당 20회)과 따로 센다. 위치 화면은 자주 다시 읽고(보호자 둘 + 어르신 폰이 같은 Wi-Fi = 같은 IP),
// 어르신 폰 앱은 움직이는 동안 10초마다·밀린 대기열을 한꺼번에 보내므로 push 는 더 넉넉한 별도 몫. 하루 상한(AI 할당량)에는 세지 않는다.
export const LOC_RATE = { push: Number(process.env.RATE_PUSH_PER_MIN || 600), read: Number(process.env.RATE_LOC_PER_MIN || 240) };

/** HTTP 처리기 만들기. deps = { db, fam?, storeReady?, auth? } — 테스트는 가짜 db 를 넣는다 (실제 저장소에 쓰지 않게) */
export function makeHandler(deps) {
  return async function handler(req, res) {
    if (req.method !== "POST") return send(res, 405, { ok: false, reason: "METHOD" });
    let b; try { b = await readJson(req); } catch { return send(res, 400, { ok: false, reason: "BAD_INPUT" }); }
    const isPush = b?.action === "push";
    if (!rateOk(req, isPush ? { bucket: "loc-push", perMin: LOC_RATE.push, countDay: false } : { bucket: "loc", perMin: LOC_RATE.read, countDay: false }))
      return send(res, 429, { ok: false, reason: "RATE_LIMIT" });
    // push 는 앱에서 옴 (브라우저가 아니라 Origin 없음) → 연결 코드로만 확인. 나머지는 보호자 웹앱에서만
    if (!isPush && !allowedOrigin(req)) return send(res, 403, { ok: false, reason: "FORBIDDEN" });
    const token = bearer(req);
    const { db, fam = familyApi({ db }), storeReady = () => true, auth = checkToken } = deps;
    const r = await route(b, { db, fam, storeReady: storeReady(), auth: () => auth(token) });
    return send(res, r.status, r.body);
  };
}

export default makeHandler({ db: kvDb, storeReady: kvReady });
