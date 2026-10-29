// GET /api/search?q=석교동 경로당&lat=..&lng=..&n=3 — 가게·장소 이름 검색 (네이버 검색 API '지역').
// developers.naver.com 에서 애플리케이션 등록(무료, 카드 불필요) → NAVER_SEARCH_CLIENT_ID / NAVER_SEARCH_CLIENT_SECRET.
// 설정이 없으면 {ok:false, reason:"NOT_CONFIGURED"} → 브라우저는 OSM(Nominatim)으로 내려간다.
const hav = (a, b, c, d) => { const R = 6371000, t = (x) => (x * Math.PI) / 180; const dl = t(c - a), dg = t(d - b); const h = Math.sin(dl / 2) ** 2 + Math.cos(t(a)) * Math.cos(t(c)) * Math.sin(dg / 2) ** 2; return Math.round(2 * R * Math.asin(Math.sqrt(h))); };

export default async function handler(req, res) {
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  const u = new URL(req.url, "http://x");
  const q = u.searchParams.get("q")?.trim(), lat = Number(u.searchParams.get("lat")), lng = Number(u.searchParams.get("lng")), n = Math.min(Number(u.searchParams.get("n") || 3), 5);
  if (!q) return res.end(JSON.stringify({ ok: false, reason: "BAD_INPUT" }));
  const id = process.env.NAVER_SEARCH_CLIENT_ID, secret = process.env.NAVER_SEARCH_CLIENT_SECRET;
  if (!id || !secret) return res.end(JSON.stringify({ ok: false, reason: "NOT_CONFIGURED" }));
  try {
    const r = await fetch(`https://openapi.naver.com/v1/search/local.json?query=${encodeURIComponent(q)}&display=5&sort=random`, { headers: { "X-Naver-Client-Id": id, "X-Naver-Client-Secret": secret }, signal: AbortSignal.timeout(8000) });
    const data = await r.json();
    if (!r.ok) return res.end(JSON.stringify({ ok: false, reason: "UPSTREAM", status: r.status, detail: data.errorMessage }));
    // mapx/mapy: WGS84 경도·위도 × 10^7
    let places = (data.items ?? []).map((it) => ({ found_name: String(it.title).replace(/<[^>]+>/g, ""), address: it.roadAddress || it.address, category: it.category, lat: Number(it.mapy) / 1e7, lng: Number(it.mapx) / 1e7 })).filter((p) => p.lat && p.lng);
    if (Number.isFinite(lat) && Number.isFinite(lng)) places = places.map((p) => ({ ...p, distance_m: hav(lat, lng, p.lat, p.lng) })).sort((a, b) => a.distance_m - b.distance_m);
    res.setHeader("cache-control", "public, max-age=600");
    res.end(JSON.stringify({ ok: true, q, places: places.slice(0, n) }));
  } catch (e) {
    res.end(JSON.stringify({ ok: false, reason: "AI_UNAVAILABLE", detail: String(e.message ?? e).slice(0, 120) }));
  }
}
