// GET /api/search?q=석교동 경로당&lat=..&lng=..&n=3 — 가게·장소 이름 검색 (네이버 지역 검색, lib/naver.js).
// 우리 앱 화면에서 온 요청만, 호출량 제한 (네이버 할당량을 남이 쓰지 못하게).
import { guardGet } from "../lib/http.js";
import { naverLocal, hav } from "../lib/naver.js";

export default async function handler(req, res) {
  if (!guardGet(req, res)) return;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  const u = new URL(req.url, "http://x");
  const q = u.searchParams.get("q")?.trim(), lat = Number(u.searchParams.get("lat") || NaN), lng = Number(u.searchParams.get("lng") || NaN), n = Math.min(Number(u.searchParams.get("n") || 3), 5);
  if (!q) return res.end(JSON.stringify({ ok: false, reason: "BAD_INPUT" }));
  try {
    let places = await naverLocal(q);
    if (Number.isFinite(lat) && Number.isFinite(lng)) places = places.map((p) => ({ ...p, distance_m: hav(lat, lng, p.lat, p.lng) })).sort((a, b) => a.distance_m - b.distance_m);
    res.setHeader("cache-control", "private, max-age=600");
    res.end(JSON.stringify({ ok: true, q, places: places.slice(0, n) }));
  } catch (e) {
    res.end(JSON.stringify({ ok: false, reason: e.reason || "UPSTREAM", detail: String(e.message ?? e).slice(0, 120) }));
  }
}
