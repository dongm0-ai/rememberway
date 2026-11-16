// POST /api/loc — 목걸이 실시간 위치 중계 (2026-11-16 지도교사 결정: 초기에는 어르신 휴대폰 연동, 이후 유심 내장 GPS)
//   {action:"push", key, p}      ← 어르신 휴대폰 앱(android/). p = 목걸이 위치 JSON (hardware/necklace, GPS_BLE 가이드 v1 형식)
//   {action:"latest", key, limit} ← 보호자 웹앱 /track : 최근 위치들 (새것부터)
//   {action:"clear", key}         ← 보호자: 이 연결 코드의 기록 모두 지우기 (개인정보 보호법: 목적을 이루면 지체 없이 파기)
// key = 보호자 웹앱이 만든 연결 코드(무작위 16글자). 서버에는 해시(dev)만 남긴다. 생성형 AI는 쓰지 않는다 (위치는 측정값).
import { createHash } from "node:crypto";
import { readJson, send, allowedOrigin, rateOk } from "../lib/http.js";
import { db, kvReady } from "../lib/kv.js";

const KEY_RE = /^[A-Z2-7]{16}$/;
const devOf = (key) => createHash("sha256").update("rw-loc:" + key).digest("hex").slice(0, 32);
const num = (v, lo, hi) => (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : null);

export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { ok: false, reason: "METHOD" });
  if (!rateOk(req)) return send(res, 429, { ok: false, reason: "RATE_LIMIT" });
  let b; try { b = await readJson(req); } catch { return send(res, 400, { ok: false, reason: "BAD_INPUT" }); }
  const key = String(b?.key ?? "").toUpperCase().replace(/[^A-Z2-7]/g, "");
  if (!KEY_RE.test(key)) return send(res, 400, { ok: false, reason: "BAD_KEY" });
  if (!kvReady()) return send(res, b?.action === "push" ? 503 : 200, { ok: false, reason: "NO_STORE" });   // 앱은 503이면 대기열에 두고 나중에 다시 보냄
  const dev = devOf(key);
  try {
    if (b.action === "push") {   // 앱에서 옴 (브라우저가 아니라 Origin 없음) → 연결 코드로만 확인
      const p = b.p ?? {};
      const lat = num(p.latitude, -90, 90), lng = num(p.longitude, -180, 180), age = num(p.fix_age_ms, 0, 3000);
      if (lat === null || lng === null || age === null) return send(res, 422, { ok: false, reason: "BAD_FIX" });
      const t = p.gps_time ? Date.parse(p.gps_time) : NaN;
      const row = { dev, lat, lng, fix_age_ms: Math.round(age), gps_time: Number.isFinite(t) ? new Date(t).toISOString() : null,
        speed_kmh: num(p.speed_kmh, 0, 500), seq: Number.isInteger(p.sequence) ? p.sequence : null, fw: typeof p.firmware_version === "string" ? p.firmware_version.slice(0, 32) : null };
      const out = await db("POST", "loc_events", row, "return=representation");
      return send(res, 201, { ok: true, accepted: true, event_id: out?.[0]?.id, received_at: out?.[0]?.received_at });
    }
    if (!allowedOrigin(req)) return send(res, 403, { ok: false, reason: "FORBIDDEN" });   // 아래는 보호자 웹앱에서만
    if (b.action === "latest") {
      const limit = Math.min(Math.max(parseInt(b.limit) || 200, 1), 1000);
      const rows = await db("GET", `loc_events?dev=eq.${dev}&select=lat,lng,gps_time,received_at,speed_kmh&order=received_at.desc&limit=${limit}`);
      return send(res, 200, { ok: true, points: rows ?? [], now: new Date().toISOString() });
    }
    if (b.action === "clear") {
      await db("DELETE", `loc_events?dev=eq.${dev}`);
      return send(res, 200, { ok: true });
    }
    return send(res, 400, { ok: false, reason: "BAD_ACTION" });
  } catch (e) {
    return send(res, b?.action === "push" ? 503 : 200, { ok: false, reason: e?.reason ?? "STORE_ERROR" });
  }
}
