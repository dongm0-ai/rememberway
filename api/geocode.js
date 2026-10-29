// GET /api/geocode?q=대전 중구 석교동 — 주소·동 이름 → 좌표.
// MAP_PROVIDER=naver 이고 NAVER_CLIENT_SECRET 이 있으면 네이버 Geocoding(서버에서만, Secret 비공개), 아니면 {ok:false}로 돌려 브라우저가 OSM(Nominatim)을 쓴다.
export default async function handler(req, res) {
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  const q = new URL(req.url, "http://x").searchParams.get("q")?.trim();
  if (!q) return res.end(JSON.stringify({ ok: false, reason: "BAD_INPUT" }));
  const id = process.env.NAVER_CLIENT_ID, secret = process.env.NAVER_CLIENT_SECRET;
  if ((process.env.MAP_PROVIDER || "osm") !== "naver" || !id || !secret) return res.end(JSON.stringify({ ok: false, reason: "NOT_CONFIGURED" }));
  try {
    const r = await fetch(`https://maps.apigw.ntruss.com/map-geocode/v2/geocode?query=${encodeURIComponent(q)}`, { headers: { "x-ncp-apigw-api-key-id": id, "x-ncp-apigw-api-key": secret }, signal: AbortSignal.timeout(8000) });
    const data = await r.json();
    const a = data.addresses?.[0];
    if (!a) return res.end(JSON.stringify({ ok: false, reason: "NOT_FOUND", status: data.status }));
    res.setHeader("cache-control", "public, max-age=86400");
    res.end(JSON.stringify({ ok: true, lat: Number(a.y), lng: Number(a.x), found_name: a.roadAddress || a.jibunAddress || q, address: a.jibunAddress }));
  } catch (e) {
    res.end(JSON.stringify({ ok: false, reason: "AI_UNAVAILABLE", detail: String(e.message ?? e).slice(0, 120) }));
  }
}
