// POST /api/loc — 목걸이 실시간 위치 중계 + 보호자 계정 데이터 API (2026-11-16 지도교사 결정: 초기에는 어르신 휴대폰 연동, 이후 유심 내장 GPS)
// Vercel 함수 12개 한도 때문에 계정 데이터 action 도 모두 여기 (공용 규칙은 lib/family.js).
//
// 로그인 없이 (연결 코드 key 로만):
//   {action:"push", key, p}         ← 어르신 휴대폰 앱(android/). p = 목걸이 위치 JSON (hardware/README.md "블루투스 약속", GPS_BLE 가이드 v1 형식)
//                                     폐기된 코드(revoked_devices: 어르신 삭제·연결 코드 재발급)는 410 GONE → 앱은 대기열 비우고 멈춤.
//                                     모르는 코드(계정 전 rw_track 코드 등)는 지금처럼 받는다. Origin 검사 없음(앱은 브라우저가 아님).
//                                     응답에 commands 가 있으면 그때 기다리던 부저 명령 (따로 물어보는 횟수를 줄이려고 같이 실어 보냄)
//   {action:"cmd.pending", key}     ← 어르신 휴대폰 앱이 기다리는 부저 명령을 물어봄 (위치를 안 보내는 동안). 받은 명령은 delivered 로 바뀜
//   {action:"cmd.result", key, id, status:"accepted"|"failed"|"expired", response?}  ← 추적기에 전달한 결과 (accepted = 추적기가 ACK 를 보냄. 소리가 실제로 났는지는 알 수 없다)
//   {action:"device.report", key, tracker:{name,id,fw}, ble, gps, app}  ← 앱이 연동한 추적기와 연결 상태 (등록·상태 표시용, 블루투스 주소는 받지 않음)
//   (연결 코드만으로 위치를 읽는 옛 {action:"latest", key} 는 없앴다 — 코드를 아는 누구나 어르신 위치를 볼 수 있었다. key 만 보내면 400 BAD_ACTION)
// 로그인 필요 (Authorization: Bearer <Supabase access token>, 우리 앱 Origin):
//   me · elder.create {label} · data.load {elderId} · data.save {elderId, profile?, diary?, incidents?, base}
//   invite.create {elderId} · invite.accept {token} · members.list {elderId} · members.remove {elderId, userId}
//   elder.leave {elderId} · elder.delete {elderId} · device.reset {elderId} · device.import {elderId, key} · account.withdraw
//   latest {elderId, limit}  ← 최근 위치들 (새것부터), member 누구나
//   places {elderId}         ← 최근 30일 기록에서 자주 머문 곳 (계산은 public/lib/gps.js, 원본 점은 보내지 않음), member 누구나
//   clear {elderId}          ← 위치 기록만 모두 지우기 (개인정보 보호법: 목적을 이루면 지체 없이 파기), owner 만
//   (places/clear 를 key 로 부르는 옛 방식은 더 이상 없음 — 로그인 + elderId)
//   buzz.send {elderId, command}  ← 원격 부저: 명령을 저장해 두면 어르신 휴대폰 앱이 가져가 블루투스로 추적기에 전달. member 누구나.
//                                   command = BUZZER_FIND(20초) · BUZZER_ON(10초) · BUZZER_OFF. 60초 안에 전달 못 하면 만료(뒤늦게 울리지 않음)
//   buzz.status {elderId, id}     ← 그 명령이 어디까지 갔는지: pending → delivered(휴대폰 도착) → accepted | failed | expired
//   device.status {elderId}       ← 앱이 마지막으로 알린 추적기·연결 상태 (없으면 device:null)
//
// 응답 본문은 항상 { ok, reason?, ... }. HTTP 상태:
//   200 성공 (push 는 201) · 400 BAD_INPUT / BAD_KEY / BAD_ACTION / INVITE_NOT_FOUND / USE_LEAVE (요청 자체가 틀림)
//   401 AUTH (토큰 없음·무효 → 다시 로그인) · 403 NOT_OWNER / FORBIDDEN(Origin) · 404 GONE (어르신이 없거나 내가 member 가 아님 → 사본 지움)
//   409 CONFLICT(+data 서버 값) / INVITE_USED / INVITE_EXPIRED / DEVICE_TAKEN / DEVICE_REVOKED / NO_SUCH_MEMBER / NO_DEVICE (지금 상태와 맞지 않음)
//   404 NO_COMMAND (그 명령이 없음) · 410 GONE (연결 코드로 부르는 action: 폐기된 연결 코드) · 422 BAD_FIX · 429 RATE_LIMIT
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

const STATUS = { BAD_INPUT: 400, INVITE_NOT_FOUND: 400, USE_LEAVE: 400, NOT_OWNER: 403, GONE: 404, NO_COMMAND: 404,
  CONFLICT: 409, INVITE_USED: 409, INVITE_EXPIRED: 409, DEVICE_TAKEN: 409, DEVICE_REVOKED: 409, NO_SUCH_MEMBER: 409, NO_DEVICE: 409, RATE_LIMIT: 429 };
const LOGIN_ACTIONS = new Set(["me", "elder.create", "data.load", "data.save", "invite.create", "invite.accept", "members.list",
  "members.remove", "elder.leave", "elder.delete", "device.reset", "device.import", "account.withdraw", "latest", "places", "clear",
  "buzz.send", "buzz.status", "device.status"]);
/** 연결 코드(key)만으로 부르는 action — 어르신 휴대폰 앱에서 온다 (로그인·Origin 없음) */
export const KEY_ACTIONS = new Set(["push", "cmd.pending", "cmd.result", "device.report"]);

// ---- 원격 부저 (2026-11-20): 보호자 웹 → 서버 → 어르신 휴대폰 앱 → 블루투스 → 추적기. 생성형 AI 는 쓰지 않는다.
const BUZZ_COMMANDS = new Set(["BUZZER_FIND", "BUZZER_ON", "BUZZER_OFF"]);   // 추적기 펌웨어가 받는 글자 그대로
export const CMD_TTL_MS = 60_000;          // 이 시간 안에 휴대폰이 가져가 전달하지 못하면 만료 — 한참 뒤에 갑자기 울리지 않게
const CMD_KEEP_MS = 24 * 3600 * 1000;      // 명령 기록은 하루 뒤 지운다 (진행 표시용일 뿐)
const CMD_GAP_MS = 3000;                   // 울리기 버튼 연타 방지 (멈추기는 언제나 통과)
const CMD_RESULTS = new Set(["accepted", "failed", "expired"]);
const BLE_STATES = new Set(["connected", "connecting", "disconnected", "bluetooth_off", "stopped"]);
const GPS_STATES = new Set(["valid", "waiting", "unknown"]);
const enc = encodeURIComponent;
/** 표시용 짧은 글자 (이름·버전·응답). 글자·숫자·몇몇 기호만, 길이 제한 */
const short = (v, max = 40) => (typeof v === "string" ? v.replace(/[^\w .:+-]/g, "").slice(0, max) || null : null);

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
  // 기다리는 부저 명령이 있으면 같이 돌려준다. 여기서 실패해도(표가 아직 없음 등) 위치 저장은 이미 끝났으니 그대로 성공.
  let commands = [];
  try { commands = await takeCommands(db, dev, now); } catch {}
  return out(201, { ok: true, accepted: true, event_id: o?.[0]?.id, received_at: o?.[0]?.received_at, ...(commands.length ? { commands } : {}) });
}

const isRevoked = async (db, dev) => ((await db("GET", `revoked_devices?device_hash=eq.${dev}&select=device_hash`)) ?? []).length > 0;

/** 그 연결 코드로 기다리는(만료 전) 부저 명령을 오래된 것부터. 처음 가져가는 것은 delivered 로 바꾼다.
 *  결과가 보고될 때까지는 다시 물어도 계속 준다 — 같은 명령을 두 번 울리지 않는 것은 앱이 id 로 막는다. */
async function takeCommands(db, dev, now) {
  const t = now().toISOString();
  const rows = (await db("GET", `device_commands?dev=eq.${dev}&status=in.(pending,delivered)&expires_at=gt.${enc(t)}&select=id,command,expires_at,status&order=created_at.asc&limit=5`)) ?? [];
  const fresh = rows.filter((r) => r.status === "pending").map((r) => r.id);
  if (fresh.length) await db("PATCH", `device_commands?id=in.(${fresh.join(",")})&status=eq.pending`, { status: "delivered", updated_at: t });
  return rows.map((r) => ({ id: r.id, command: r.command, expires_at: r.expires_at }));
}

/** 어르신 휴대폰 앱이 연결 코드로 부르는 것 (push 제외): cmd.pending · cmd.result · device.report */
async function deviceAction(action, b, db, now) {
  const dev = deviceHashOf(cleanKey(b.key));
  if (await isRevoked(db, dev)) return out(410, { ok: false, reason: "GONE" });
  const t = now().toISOString();
  if (action === "cmd.pending") return out(200, { ok: true, commands: await takeCommands(db, dev, now), now: t });
  if (action === "cmd.result") {
    if (!UUID_RE.test(String(b.id ?? "")) || !CMD_RESULTS.has(b.status)) return out(400, { ok: false, reason: "BAD_INPUT" });
    const [row] = (await db("GET", `device_commands?id=eq.${b.id}&dev=eq.${dev}&select=id,status`)) ?? [];
    if (!row) return out(404, { ok: false, reason: "NO_COMMAND" });
    // 이미 결과가 정해진 명령은 바꾸지 않는다 (앱이 같은 보고를 다시 보내도 안전)
    if (row.status === "accepted" || row.status === "failed") return out(200, { ok: true, status: row.status });
    await db("PATCH", `device_commands?id=eq.${b.id}&dev=eq.${dev}`, { status: b.status, response: short(b.response, 64), updated_at: t });
    return out(200, { ok: true, status: b.status });
  }
  // device.report — 앱이 연동한 추적기와 지금 상태. 추적기 이름·펌웨어가 붙인 id·버전만 (블루투스 주소·사람 정보 없음)
  const tr = b.tracker && typeof b.tracker === "object" ? b.tracker : {};
  await db("POST", "device_status", {
    dev, tracker_name: short(tr.name), tracker_id: short(tr.id), fw: short(tr.fw, 32),
    ble_state: BLE_STATES.has(b.ble) ? b.ble : null, gps_state: GPS_STATES.has(b.gps) ? b.gps : null,
    app_version: short(b.app, 20), reported_at: t,
  }, "resolution=merge-duplicates");
  return out(200, { ok: true });
}

/** 보호자(로그인 + member)가 부르는 것: buzz.send · buzz.status · device.status. dev = 그 어르신의 연결 코드 해시(없으면 null) */
async function guardianDevice(action, b, db, dev, user, now) {
  const t = now(), ts = t.toISOString();
  if (action === "device.status") {
    const [d] = dev ? (await db("GET", `device_status?dev=eq.${dev}&select=tracker_name,tracker_id,fw,ble_state,gps_state,app_version,reported_at`)) ?? [] : [];
    return out(200, { ok: true, device: d ?? null, now: ts });
  }
  if (!dev) return out(409, { ok: false, reason: "NO_DEVICE" });   // 어르신 폰 연결 코드가 아직 없음
  if (action === "buzz.status") {
    if (!UUID_RE.test(String(b.id ?? ""))) return out(400, { ok: false, reason: "BAD_INPUT" });
    const [c] = (await db("GET", `device_commands?id=eq.${b.id}&dev=eq.${dev}&select=id,command,status,response,expires_at`)) ?? [];
    if (!c) return out(404, { ok: false, reason: "NO_COMMAND" });
    const waiting = c.status === "pending" || c.status === "delivered";
    const status = waiting && Date.parse(c.expires_at) <= t.getTime() ? "expired" : c.status;
    return out(200, { ok: true, id: c.id, command: c.command, status, response: c.response ?? null, expires_at: c.expires_at, now: ts });
  }
  // buzz.send
  if (!BUZZ_COMMANDS.has(b.command)) return out(400, { ok: false, reason: "BAD_INPUT" });
  const before = (ms) => enc(new Date(t.getTime() - ms).toISOString());
  await db("DELETE", `device_commands?created_at=lt.${before(CMD_KEEP_MS)}`).catch(() => {});   // 하루 지난 명령 기록 지우기
  if (b.command !== "BUZZER_OFF") {
    const recent = (await db("GET", `device_commands?dev=eq.${dev}&command=neq.BUZZER_OFF&created_at=gt.${before(CMD_GAP_MS)}&select=id&limit=1`)) ?? [];
    if (recent.length) return out(429, { ok: false, reason: "RATE_LIMIT" });
  }
  const expires_at = new Date(t.getTime() + CMD_TTL_MS).toISOString();
  const o = await db("POST", "device_commands", { dev, command: b.command, status: "pending", created_by: user.id, created_at: ts, expires_at, updated_at: ts }, "return=representation");
  const id = o?.[0]?.id;
  if (!id) throw Object.assign(new Error("command not stored"), { reason: "STORE_ERROR" });
  return out(200, { ok: true, id, command: b.command, status: "pending", expires_at, now: ts });
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
  if (!KEY_ACTIONS.has(action) && !LOGIN_ACTIONS.has(action)) return out(400, { ok: false, reason: "BAD_ACTION" });
  // 연결 코드(key)로 할 수 있는 건 push 뿐. 위치 읽기는 로그인 + member 만 (key 만 보낸 latest 는 400)
  if (action === "latest" && b.elderId == null && b.key != null) return out(400, { ok: false, reason: "BAD_ACTION" });

  try {
    if (action === "push") {
      if (!KEY_RE.test(cleanKey(b.key))) return out(400, { ok: false, reason: "BAD_KEY" });
      if (!storeReady) return out(503, { ok: false, reason: "NO_STORE" });   // 앱은 503이면 대기열에 두고 나중에 다시 보냄
      return await push(b, db, now);
    }
    if (KEY_ACTIONS.has(action)) {   // cmd.pending · cmd.result · device.report (어르신 휴대폰 앱, 연결 코드로만)
      if (!KEY_RE.test(cleanKey(b.key))) return out(400, { ok: false, reason: "BAD_KEY" });
      if (!storeReady) return out(503, { ok: false, reason: "NO_STORE" });
      return await deviceAction(action, b, db, now);
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
      case "buzz.send": case "buzz.status": case "device.status": {
        const a = await elderDevice(db, user, b.elderId);
        if (!a.ok) return fromFamily(a);
        return await guardianDevice(action, b, db, a.dev, user, now);
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
    const isPush = KEY_ACTIONS.has(b?.action);   // push 와 그 밖의 앱 action (명령 조회·결과·단말 보고)
    if (!rateOk(req, isPush ? { bucket: "loc-push", perMin: LOC_RATE.push, countDay: false } : { bucket: "loc", perMin: LOC_RATE.read, countDay: false }))
      return send(res, 429, { ok: false, reason: "RATE_LIMIT" });
    // 앱에서 오는 action 은 브라우저가 아니라 Origin 없음 → 연결 코드로만 확인. 나머지는 보호자 웹앱에서만
    if (!isPush && !allowedOrigin(req)) return send(res, 403, { ok: false, reason: "FORBIDDEN" });
    const token = bearer(req);
    const { db, fam = familyApi({ db }), storeReady = () => true, auth = checkToken } = deps;
    const r = await route(b, { db, fam, storeReady: storeReady(), auth: () => auth(token) });
    return send(res, r.status, r.body);
  };
}

export default makeHandler({ db: kvDb, storeReady: kvReady });
