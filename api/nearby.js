// GET /api/nearby?kind=카페&lat=..&lng=..&r=1500&n=3 — 집 근처에서 종류별 실제 가게 찾기 (OSM Overpass).
// 브라우저에서 Overpass를 직접 부르면 CORS에 막혀서 서버 함수가 대신 부른다. 키 없음. 공개 서버라 호출을 아낀다.
const KIND_TAGS = {
  카페: ["amenity=cafe"], 커피숍: ["amenity=cafe"], 커피: ["amenity=cafe"],
  편의점: ["shop=convenience"], 슈퍼: ["shop=supermarket", "shop=convenience"], 마트: ["shop=supermarket"],
  세탁소: ["shop=laundry", "shop=dry_cleaning"], 무인세탁: ["shop=laundry"], 무인세탁실: ["shop=laundry"], 세탁: ["shop=laundry", "shop=dry_cleaning"], 빨래방: ["shop=laundry"],
  약국: ["amenity=pharmacy"], 병원: ["amenity=hospital", "amenity=clinic"], 의원: ["amenity=clinic", "amenity=doctors"],
  시장: ["amenity=marketplace"], 경로당: ["amenity=social_facility", "amenity=community_centre"], 노인정: ["amenity=social_facility", "amenity=community_centre"],
  교회: ["amenity=place_of_worship"], 성당: ["amenity=place_of_worship"], 절: ["amenity=place_of_worship"],
  공원: ["leisure=park"], 은행: ["amenity=bank"], 우체국: ["amenity=post_office"], 목욕탕: ["amenity=public_bath"], 사우나: ["amenity=public_bath"],
  미용실: ["shop=hairdresser"], 이발소: ["shop=hairdresser"], 정류장: ["highway=bus_stop"], 버스정류장: ["highway=bus_stop"],
  지하철역: ["railway=station"], 역: ["railway=station"], 학교: ["amenity=school"], 놀이터: ["leisure=playground"], 주민센터: ["amenity=townhall"], 복지관: ["amenity=social_facility"],
};
const hav = (a, b, c, d) => { const R = 6371000, t = (x) => (x * Math.PI) / 180; const dl = t(c - a), dg = t(d - b); const h = Math.sin(dl / 2) ** 2 + Math.cos(t(a)) * Math.cos(t(c)) * Math.sin(dg / 2) ** 2; return Math.round(2 * R * Math.asin(Math.sqrt(h))); };

export default async function handler(req, res) {
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "public, max-age=600");
  const u = new URL(req.url, "http://x");
  const kind = (u.searchParams.get("kind") || "").replace(/\s+/g, ""), lat = Number(u.searchParams.get("lat")), lng = Number(u.searchParams.get("lng"));
  const r = Math.min(Number(u.searchParams.get("r") || 1500), 3000), n = Math.min(Number(u.searchParams.get("n") || 3), 5);
  const tags = KIND_TAGS[kind];
  if (!tags || !Number.isFinite(lat) || !Number.isFinite(lng)) return res.end(JSON.stringify({ ok: false, reason: "BAD_INPUT", kinds: Object.keys(KIND_TAGS) }));
  const q = `[out:json][timeout:10];(${tags.map((t) => { const [k, v] = t.split("="); return `nwr["${k}"="${v}"](around:${Math.round(r)},${lat},${lng});`; }).join("")});out center ${n * 5};`;
  try {
    const rr = await fetch("https://overpass-api.de/api/interpreter?data=" + encodeURIComponent(q), { headers: { "user-agent": "rememberway-ai (school project; dongm0-ai on github)" }, signal: AbortSignal.timeout(12000) });
    if (!rr.ok) return res.end(JSON.stringify({ ok: false, reason: "UPSTREAM", status: rr.status }));
    const data = await rr.json();
    const seen = new Set();
    const places = (data.elements ?? []).map((e) => ({ lat: e.lat ?? e.center?.lat, lng: e.lon ?? e.center?.lon, found_name: e.tags?.["name:ko"] || e.tags?.name || `(이름 없는 ${kind})`, category: kind }))
      .filter((x) => x.lat && x.lng).map((x) => ({ ...x, distance_m: hav(lat, lng, x.lat, x.lng) })).sort((a, b) => a.distance_m - b.distance_m)
      .filter((x) => (seen.has(x.found_name) ? false : seen.add(x.found_name))).slice(0, n);
    res.end(JSON.stringify({ ok: true, kind, places }));
  } catch (e) {
    res.end(JSON.stringify({ ok: false, reason: "AI_UNAVAILABLE", detail: String(e.message ?? e).slice(0, 120) }));
  }
}
