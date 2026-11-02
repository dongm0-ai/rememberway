// GET /api/geocode?q=대전 중구 석교동 — 집 동네 → 좌표 (네이버만, lib/naver.js). 우리 앱 화면에서 온 요청만.
import { guardGet } from "../lib/http.js";
import { naverGeocode, naverReverse } from "../lib/naver.js";

export default async function handler(req, res) {
  if (!guardGet(req, res)) return;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  const u = new URL(req.url, "http://x");
  const q = u.searchParams.get("q")?.trim(), lat = Number(u.searchParams.get("lat")), lng = Number(u.searchParams.get("lng"));
  // ?lat=&lng= : 현재 위치 → 동 이름 (처음 집 설정할 때 "현재 위치로"). 좌표는 화면에서 이미 약 100m 단위로 반올림해서 보낸다
  if (!q && Number.isFinite(lat) && Number.isFinite(lng) && lat && lng) {
    try { return res.end(JSON.stringify({ ok: true, label: await naverReverse(lat, lng) })); }
    catch (e) { return res.end(JSON.stringify({ ok: false, reason: e.reason || "UPSTREAM" })); }
  }
  if (!q) return res.end(JSON.stringify({ ok: false, reason: "BAD_INPUT" }));
  try {
    const hit = await naverGeocode(q);
    if (!hit) return res.end(JSON.stringify({ ok: false, reason: "NOT_FOUND" }));
    res.setHeader("cache-control", "private, max-age=86400");
    res.end(JSON.stringify({ ok: true, ...hit }));
  } catch (e) {
    res.end(JSON.stringify({ ok: false, reason: e.reason || "UPSTREAM", detail: String(e.message ?? e).slice(0, 120) }));
  }
}
