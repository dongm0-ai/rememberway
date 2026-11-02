// 네이버 API (서버 전용 — Secret은 브라우저로 내려가지 않는다). 2026-11-02: 지도·장소 찾기는 네이버만 쓴다 (한국 서비스).
//  - 지역 검색: 네이버클라우드 NAVER API HUB(검색 → 지역) NAVER_APIHUB_CLIENT_ID/SECRET, 없으면 구 개발자센터 NAVER_SEARCH_* 키
//  - 주소 → 좌표: 네이버클라우드 Maps Geocoding (NAVER_CLIENT_ID + NAVER_CLIENT_SECRET). Secret이 없으면 지역 검색으로 대신 찾는다
export const hav = (a, b, c, d) => { const R = 6371000, t = (x) => (x * Math.PI) / 180; const dl = t(c - a), dg = t(d - b); const h = Math.sin(dl / 2) ** 2 + Math.cos(t(a)) * Math.cos(t(c)) * Math.sin(dg / 2) ** 2; return Math.round(2 * R * Math.asin(Math.sqrt(h))); };

/** 지역 검색 → [{found_name, address, category, lat, lng}] (최대 5). 설정 없음이면 Error(reason NOT_CONFIGURED) */
export async function naverLocal(q) {
  const hub = { id: process.env.NAVER_APIHUB_CLIENT_ID, secret: process.env.NAVER_APIHUB_CLIENT_SECRET };
  const dev = { id: process.env.NAVER_SEARCH_CLIENT_ID, secret: process.env.NAVER_SEARCH_CLIENT_SECRET };
  let url, headers;
  if (hub.id && hub.secret) { url = "https://naverapihub.apigw.ntruss.com/search/v1/local"; headers = { "X-NCP-APIGW-API-KEY-ID": hub.id, "X-NCP-APIGW-API-KEY": hub.secret }; }
  else if (dev.id && dev.secret) { url = "https://openapi.naver.com/v1/search/local.json"; headers = { "X-Naver-Client-Id": dev.id, "X-Naver-Client-Secret": dev.secret }; }
  else throw Object.assign(new Error("NOT_CONFIGURED"), { reason: "NOT_CONFIGURED" });
  const r = await fetch(`${url}?query=${encodeURIComponent(q)}&display=5&sort=random&format=json`, { headers, signal: AbortSignal.timeout(8000) });
  const data = await r.json();
  if (!r.ok) throw Object.assign(new Error(String(data.errorMessage || data.error?.message || r.status).slice(0, 120)), { reason: "UPSTREAM" });
  // mapx/mapy: WGS84 경도·위도 × 10^7
  return (data.items ?? []).map((it) => ({ found_name: String(it.title).replace(/<[^>]+>/g, ""), address: it.roadAddress || it.address, category: it.category, lat: Number(it.mapy) / 1e7, lng: Number(it.mapx) / 1e7 })).filter((p) => p.lat && p.lng);
}

/** 주소·동 이름 → {lat, lng, found_name} 또는 null */
export async function naverGeocode(q) {
  const id = process.env.NAVER_CLIENT_ID, secret = process.env.NAVER_CLIENT_SECRET;
  if (id && secret) {
    const r = await fetch(`https://maps.apigw.ntruss.com/map-geocode/v2/geocode?query=${encodeURIComponent(q)}`, { headers: { "x-ncp-apigw-api-key-id": id, "x-ncp-apigw-api-key": secret }, signal: AbortSignal.timeout(8000) });
    const a = (await r.json()).addresses?.[0];
    if (a) return { lat: Number(a.y), lng: Number(a.x), found_name: a.roadAddress || a.jibunAddress || q, via: "geocode" };
  }
  // Geocoding Secret이 없으면: 동 행정복지센터(주민센터) 위치를 동의 중심으로 쓴다
  const dong = q.trim().split(/\s+/).pop();
  for (const term of [`${q} 행정복지센터`, `${q} 주민센터`, q]) {
    const hit = (await naverLocal(term)).find((p) => !dong || `${p.address} ${p.found_name}`.includes(dong.replace(/(동|읍|면)$/, ""))) ;
    if (hit) return { lat: hit.lat, lng: hit.lng, found_name: hit.address || hit.found_name, via: "local" };
  }
  return null;
}

/** 좌표 → 행정동 이름 ("대전광역시 중구 석교동"). 네이버 Reverse Geocoding — NAVER_CLIENT_ID + NAVER_CLIENT_SECRET 필요(콘솔에서 Reverse Geocoding 사용 신청).
 *  설정이 없으면 Error(reason NO_REVERSE) → 화면은 "동 이름을 적어 주세요"로 안내 */
export async function naverReverse(lat, lng) {
  const id = process.env.NAVER_CLIENT_ID, secret = process.env.NAVER_CLIENT_SECRET;
  if (!id || !secret) throw Object.assign(new Error("NO_REVERSE"), { reason: "NO_REVERSE" });
  const r = await fetch(`https://maps.apigw.ntruss.com/map-reversegeocode/v2/gc?coords=${lng},${lat}&orders=admcode&output=json`, { headers: { "x-ncp-apigw-api-key-id": id, "x-ncp-apigw-api-key": secret }, signal: AbortSignal.timeout(8000) });
  const data = await r.json();
  const g = data.results?.[0]?.region;
  if (!r.ok || !g) throw Object.assign(new Error(String(data.status?.message || data.error?.message || r.status).slice(0, 120)), { reason: r.status === 401 || r.status === 403 ? "NO_REVERSE" : "UPSTREAM" });
  return [g.area1?.name, g.area2?.name, g.area3?.name].filter(Boolean).join(" ");
}

/** 동 이름 → 후보 동네 목록 (배민 주소 검색처럼 고르게). 같은 이름 동이 여러 도시에 있고, 네이버 검색은 요청 위치 근처를 먼저 주므로
 *  "○○동주민센터"(붙여 쓰기)·"○○동 행정복지센터"·"○○동" 을 모두 찾아 주민센터·행정복지센터만 모은다.
 *  반환 [{label:"대전광역시 중구 석교동", lat, lng, address}] (최대 6) */
export async function naverDongCandidates(q) {
  const full = q.trim().replace(/\s+/g, " ");
  const name = full.split(" ").pop();                 // "대전 중구 석교동" → "석교동"
  const stem = name.replace(/(동|읍|면|리)$/, "");     // "석교"
  const scope = full.split(" ").slice(0, -1);          // ["대전","중구"] — 적었으면 그 안에서만
  const queries = [...new Set([`${full}주민센터`, `${full} 행정복지센터`, `${name}주민센터`, `${name} 행정복지센터`, full])];
  const seen = new Map();
  for (const term of queries) {
    let items = [];
    try { items = await naverLocal(term); } catch (e) { if (e.reason === "NOT_CONFIGURED") throw e; }
    for (const p of items) {
      const nm = p.found_name.replace(/\s+/g, "");
      if (!/(주민센터|행정복지센터)/.test(nm) || !nm.includes(stem)) continue;
      const dong = (nm.match(new RegExp(`(${stem}[0-9가-힣]*?(?:동|읍|면|리))`)) ?? [])[1] ?? name;
      const t = String(p.address ?? "").split(/\s+/);
      if (scope.length && !scope.every((s) => t.some((x) => x.startsWith(s.replace(/(시|도|구|군)$/, ""))))) continue;
      const label = [t[0], /(구|군|시)$/.test(t[1] ?? "") ? t[1] : null, dong].filter(Boolean).join(" ");
      if (!seen.has(label)) seen.set(label, { label, lat: p.lat, lng: p.lng, address: p.address });
    }
    if (seen.size >= 6) break;
  }
  return [...seen.values()].slice(0, 6);
}
