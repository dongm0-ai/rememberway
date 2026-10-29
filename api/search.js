// GET /api/search?q=석교동 경로당&lat=..&lng=..&n=3 — 가게·장소 이름 검색 (네이버 검색 API '지역').
// 네이버클라우드 NAVER API HUB → Application 등록(검색 → 지역) → NAVER_APIHUB_CLIENT_ID / NAVER_APIHUB_CLIENT_SECRET.
// (구 developers.naver.com 검색 API는 2026-07-31부터 신규 신청 불가. 기존 키가 있으면 NAVER_SEARCH_* 로도 동작)
// 설정이 없으면 {ok:false, reason:"NOT_CONFIGURED"} → 브라우저는 OSM(Nominatim)으로 내려간다.
const hav = (a, b, c, d) => { const R = 6371000, t = (x) => (x * Math.PI) / 180; const dl = t(c - a), dg = t(d - b); const h = Math.sin(dl / 2) ** 2 + Math.cos(t(a)) * Math.cos(t(c)) * Math.sin(dg / 2) ** 2; return Math.round(2 * R * Math.asin(Math.sqrt(h))); };

export default async function handler(req, res) {
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  const u = new URL(req.url, "http://x");
  const q = u.searchParams.get("q")?.trim(), lat = Number(u.searchParams.get("lat")), lng = Number(u.searchParams.get("lng")), n = Math.min(Number(u.searchParams.get("n") || 3), 5);
  if (!q) return res.end(JSON.stringify({ ok: false, reason: "BAD_INPUT" }));
  // 1순위: 네이버클라우드 NAVER API HUB (2026-07-31 이후 신규 신청은 여기서만 가능). 2순위: 구 개발자센터 검색 API 키(기존 사용자만)
  const hub = { id: process.env.NAVER_APIHUB_CLIENT_ID, secret: process.env.NAVER_APIHUB_CLIENT_SECRET };
  const dev = { id: process.env.NAVER_SEARCH_CLIENT_ID, secret: process.env.NAVER_SEARCH_CLIENT_SECRET };
  let url, headers;
  if (hub.id && hub.secret) { url = "https://naverapihub.apigw.ntruss.com/search/v1/local"; headers = { "X-NCP-APIGW-API-KEY-ID": hub.id, "X-NCP-APIGW-API-KEY": hub.secret }; }
  else if (dev.id && dev.secret) { url = "https://openapi.naver.com/v1/search/local.json"; headers = { "X-Naver-Client-Id": dev.id, "X-Naver-Client-Secret": dev.secret }; }
  else return res.end(JSON.stringify({ ok: false, reason: "NOT_CONFIGURED" }));
  try {
    const r = await fetch(`${url}?query=${encodeURIComponent(q)}&display=5&sort=random&format=json`, { headers, signal: AbortSignal.timeout(8000) });
    const data = await r.json();
    if (!r.ok) return res.end(JSON.stringify({ ok: false, reason: "UPSTREAM", status: r.status, detail: data.errorMessage || data.error?.message || JSON.stringify(data).slice(0, 120) }));
    // mapx/mapy: WGS84 경도·위도 × 10^7
    let places = (data.items ?? []).map((it) => ({ found_name: String(it.title).replace(/<[^>]+>/g, ""), address: it.roadAddress || it.address, category: it.category, lat: Number(it.mapy) / 1e7, lng: Number(it.mapx) / 1e7 })).filter((p) => p.lat && p.lng);
    if (Number.isFinite(lat) && Number.isFinite(lng)) places = places.map((p) => ({ ...p, distance_m: hav(lat, lng, p.lat, p.lng) })).sort((a, b) => a.distance_m - b.distance_m);
    res.setHeader("cache-control", "public, max-age=600");
    res.end(JSON.stringify({ ok: true, q, places: places.slice(0, n) }));
  } catch (e) {
    res.end(JSON.stringify({ ok: false, reason: "AI_UNAVAILABLE", detail: String(e.message ?? e).slice(0, 120) }));
  }
}
