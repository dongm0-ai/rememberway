// GET /api/geocode?q=대전 중구 석교동 — 집 동네 → 좌표 (네이버만, lib/naver.js). 우리 앱 화면에서 온 요청만.
import { guardGet } from "../lib/http.js";
import { naverGeocode, naverReverseFull, naverAddressSearch } from "../lib/naver.js";

export default async function handler(req, res) {
  if (!guardGet(req, res)) return;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  const u = new URL(req.url, "http://x");
  const q = u.searchParams.get("q")?.trim(), lat = Number(u.searchParams.get("lat")), lng = Number(u.searchParams.get("lng"));
  // ?lat=&lng= : 현재 위치 → 동 이름·도로명·지번·건물명 (처음 집 설정할 때 "현재 위치로"). 결과는 보호자 기기에만 저장되고 서버는 남기지 않는다
  if (!q && Number.isFinite(lat) && Number.isFinite(lng) && lat && lng) {
    try { return res.end(JSON.stringify({ ok: true, ...(await naverReverseFull(lat, lng)) })); }
    catch (e) { return res.end(JSON.stringify({ ok: false, reason: e.reason || "UPSTREAM" })); }
  }
  if (!q) return res.end(JSON.stringify({ ok: false, reason: "BAD_INPUT" }));
  // ?list=1 : 집 주소 설정 화면의 검색 — 도로명·지번·건물명 후보를 여러 개 돌려줘서 보호자가 고르게 한다 (배민 주소 검색처럼)
  if (u.searchParams.get("list")) {
    try { const items = await naverAddressSearch(q); return res.end(JSON.stringify({ ok: true, items })); }
    catch (e) { return res.end(JSON.stringify({ ok: false, reason: e.reason || "UPSTREAM" })); }
  }
  try {
    const hit = await naverGeocode(q);
    if (!hit) return res.end(JSON.stringify({ ok: false, reason: "NOT_FOUND" }));
    res.setHeader("cache-control", "private, max-age=86400");
    res.end(JSON.stringify({ ok: true, ...hit }));
  } catch (e) {
    res.end(JSON.stringify({ ok: false, reason: e.reason || "UPSTREAM", detail: String(e.message ?? e).slice(0, 120) }));
  }
}
