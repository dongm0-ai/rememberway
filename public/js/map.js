// 지도: 네이버 지도만 쓴다 (2026-11-02, 한국 서비스). 키(Client ID)는 /api/config 가 주는 공개용 값, 도메인 제한.
//  - 장소 이름 → 좌표, 집 근처 가게: 네이버 지역 검색 (/api/search, 서버에서 Secret 사용)
//  - 집: 처음에 설정한 주소의 좌표(이 기기 저장)를 바로 씀. 없을 때만 동 이름 → 좌표 (/api/geocode)
//  - 도보 길찾기: Valhalla 보행자 경로(공개 서버) → 실패하면 OSRM. 네이버 길찾기 API는 자동차용·유료라 걷는 길은 이것을 쓴다.
let loading = null;
const engine = "naver";

/** 네이버 지도 로드. cfg = /api/config 의 map 객체. 반환: window.naver 또는 null(키 없음·불러오기 실패) */
export function loadMap(cfg = {}) {
  if (loading) return loading;
  if (!cfg.naverClientId) return Promise.resolve(null);
  loading = new Promise((resolve) => {
    if (window.naver?.maps) return resolve(window.naver);
    const s = document.createElement("script");
    s.src = `https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=${encodeURIComponent(cfg.naverClientId)}`;
    s.onload = () => resolve(window.naver?.maps ? window.naver : null); s.onerror = () => resolve(null);
    document.head.append(s);
  });
  return loading;
}
export function mapEngine() { return engine; }

// ---------------------------------------------------------------- 장소 찾기 (네이버 지역 검색)
/** 이름 하나 → 좌표 하나 (집 근처 우선) */
export async function findPlace(name, near) {
  const arr = await naverSearch(name, near, 1);
  return arr?.[0] ?? null;
}

/** "카페", "편의점"처럼 종류만 말한 곳 → 집 반경 안 실제 가게 (네이버 지역 검색). 최대 n곳, 가까운 순 */
const GENERIC_KINDS = ["카페","커피숍","커피","편의점","슈퍼","마트","세탁소","무인세탁","무인세탁실","세탁","빨래방","약국","병원","의원","시장","경로당","노인정","교회","성당","절","공원","은행","우체국","목욕탕","사우나","미용실","이발소","정류장","버스정류장","지하철역","역","학교","놀이터","주민센터","복지관"];
/** "무인세탁소", "집 앞 편의점", "동네 카페"처럼 종류만 말한 이름인지. 고유명("GS25 석교점", "중앙시장")은 아님 */
export function isGeneric(name) {
  const s = name.replace(/\s+/g, "").replace(/^(집앞|집근처|근처|동네|우리동네|앞|옆)/, "");
  return GENERIC_KINDS.includes(s) || GENERIC_KINDS.some((k) => k.length >= 2 && s.endsWith(k) && s.length - k.length <= 2 && /^(무인|셀프|24시|작은|큰)?$/.test(s.slice(0, s.length - k.length)));
}
let homeLabel = ""; // 네이버 검색어에 붙일 동 이름 ("대전 중구 석교동")
export function setHomeLabel(s) { homeLabel = s || ""; }
async function naverSearch(q, near, n) {
  try {
    const r = await fetch(`/api/search?q=${encodeURIComponent(q)}&lat=${near?.lat ?? ""}&lng=${near?.lng ?? ""}&n=${n}`, { signal: AbortSignal.timeout(10000) });
    const d = await r.json();
    return d.ok ? d.places : null; // null = 설정 없음/실패
  } catch { return null; }
}
const KIND_ALIASES = { "무인세탁소": ["무인세탁소", "셀프빨래방", "세탁소"], "무인세탁실": ["무인세탁소", "셀프빨래방", "세탁소"], "무인세탁": ["무인세탁소", "셀프빨래방"], "세탁": ["세탁소"], "빨래방": ["셀프빨래방", "무인세탁소"], "커피": ["카페"], "커피숍": ["카페"], "노인정": ["경로당"], "슈퍼": ["슈퍼마켓", "마트"] };
export async function findNearby(kind, home, radiusM = 1500, n = 3) {
  const limit = Math.max(radiusM, 2000);
  const near = (p) => Number.isFinite(p.distance_m) ? p.distance_m <= limit : haversineM(home.lat, home.lng, p.lat, p.lng) <= limit; // 집 반경 밖(엉뚱한 먼 가게)은 버린다
  for (const q of KIND_ALIASES[kind.replace(/\s+/g, "")] ?? [kind]) {
    const nv = await naverSearch(`${homeLabel} ${q}`.trim(), home, 5);
    if (nv === null) break; // 네이버 검색 실패
    // 가게 종류를 물었는데 버스정류장·지하철 출입구("○○성당입구" 정류장 등)가 섞이면 뺀다 (정류장을 물은 경우는 제외)
    const wantStop = /정류장|역$/.test(kind);
    const ok = nv.filter(near).filter((p) => (wantStop ? !/자전거|대여소|주차/.test(p.found_name ?? "") : !/정류장|교통|지하철/.test(p.category ?? "")));
    if (ok.length) return ok.slice(0, n);
  }
  return [];
}

/** 이름으로 못 찾으면 더 단순한 이름으로 다시: "삼성동 옛 동네" → "삼성동", "중앙시장 정육점" → "중앙시장" */
export async function findPlaceLoose(name, near) {
  const tooFar = (p) => near && haversineM(near.lat, near.lng, p.lat, p.lng) > 30000; // 집에서 30km 넘으면 이름만 같은 다른 곳일 가능성이 커서 버린다
  const q = name.includes(" ") || !homeLabel ? name : `${homeLabel.split(/\s+/).slice(-1)[0]} ${name}`;
  for (const [term, approx] of [[q, false], [name, false]]) {
    const nv = await naverSearch(term, near, 1);
    if (nv?.length && !tooFar(nv[0])) return { ...nv[0], approx };
  }
  const core = name.split(/\s+/).find((t) => /(동|읍|면|리|시장|역|병원|공원|학교|교회|성당|절|마트|터미널|정류장|경로당|센터)$/.test(t));
  if (core && core !== name) { const nv = await naverSearch(core, near, 1); if (nv?.length && !tooFar(nv[0])) return { ...nv[0], approx: true }; }
  return null;
}

/** 집(동 단위) 좌표. "대전 중구 석교동"처럼 시·구까지 적으면 정확도가 올라간다 (네이버) */
export async function findHome(dong) {
  try { const r = await fetch(`/api/geocode?q=${encodeURIComponent(dong)}`); const d = await r.json(); if (d.ok) return { lat: d.lat, lng: d.lng, found_name: d.found_name }; } catch {}
  return null;
}

// ---------------------------------------------------------------- 도보 길찾기
// 1순위 Valhalla(OSM 재단 공개 서버, costing=pedestrian: 인도·골목·계단을 타고 일방통행 무시) → 실패하면 OSRM 공개 서버(자동차 도로망 기준이라 참고용).
// 2026-10-29 검증: OSRM은 1→2 1,544m / 2→1 1,318m 로 방향마다 달라(일방통행) 동선 순서가 왜곡됐다. Valhalla 보행은 1,323m.
export let routerUsed = ""; // "valhalla" | "osrm" | ""  (화면 문구용)
const VALHALLA = "https://valhalla1.openstreetmap.de";

/** Valhalla polyline6 → [[lat,lng],...] */
function decodePolyline6(str) {
  const out = []; let i = 0, lat = 0, lng = 0;
  while (i < str.length) {
    for (const which of [0, 1]) {
      let b, shift = 0, res = 0;
      do { b = str.charCodeAt(i++) - 63; res |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const d = res & 1 ? ~(res >> 1) : res >> 1;
      if (which === 0) lat += d; else lng += d;
    }
    out.push([lat / 1e6, lng / 1e6]);
  }
  return out;
}

async function valhallaRoute(points) {
  const body = { locations: points.map((p) => ({ lat: p.lat, lon: p.lng, type: "break" })), costing: "pedestrian", units: "kilometers", directions_options: { language: "ko-KR" } };
  const r = await fetch(`${VALHALLA}/route`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
  const data = await r.json();
  const trip = data.trip; if (!trip?.legs?.length) return null;
  const geometry = [], legs = [], intersections = [];
  let acc = 0;
  for (const leg of trip.legs) {
    const shape = decodePolyline6(leg.shape);
    geometry.push(...shape);
    legs.push({ distance_m: Math.round(leg.summary.length * 1000), duration_s: Math.round(leg.summary.time) });
    for (const mv of leg.maneuvers ?? []) {
      // 갈림길: 방향을 바꾸는 지점(좌·우회전 계열, type 9~16·22~26)이고 길 이름이 있는 곳. 집 150m 안은 제외
      const turn = (mv.type >= 9 && mv.type <= 16) || (mv.type >= 22 && mv.type <= 26);
      const name = (mv.street_names ?? [])[0];
      if (turn && name && acc >= 150 && !intersections.some((x) => x.name === `${name} 갈림길`)) {
        const [lat, lng] = shape[mv.begin_shape_index] ?? shape[0];
        intersections.push({ lat, lng, name: `${name} 갈림길`, distance_m: Math.round(acc) });
      }
      acc += mv.length * 1000;
    }
  }
  return { geometry, distance_m: Math.round(trip.summary.length * 1000), duration_s: Math.round(trip.summary.time), legs, intersections };
}

async function osrmRoute(points) {
  const coords = points.map((p) => `${p.lng},${p.lat}`).join(";");
  const r = await fetch(`https://router.project-osrm.org/route/v1/foot/${coords}?overview=full&geometries=geojson&steps=true`, { signal: AbortSignal.timeout(8000) });
  const data = await r.json();
  const route = data.routes?.[0];
  if (!route) return null;
  const geometry = route.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
  const intersections = [];
  let acc = 0;
  for (const leg of route.legs) {
    for (const step of leg.steps) {
      const m = step.maneuver;
      const big = (step.intersections ?? []).some((x) => (x.bearings ?? []).length >= 3);
      if (big && !["depart", "arrive"].includes(m.type) && step.name && acc >= 150 && !intersections.some((x) => x.name === `${step.name} 갈림길`)) {
        intersections.push({ lat: m.location[1], lng: m.location[0], name: `${step.name} 갈림길`, distance_m: Math.round(acc) });
      }
      acc += step.distance;
    }
  }
  return { geometry, distance_m: Math.round(route.distance), duration_s: Math.round(route.duration), legs: route.legs.map((l) => ({ distance_m: Math.round(l.distance), duration_s: Math.round(l.duration) })), intersections };
}

/** points: [{lat,lng}, ...] 순서대로 걷는 경로. 반환 { geometry:[[lat,lng]...], distance_m, duration_s, legs:[{distance_m,duration_s}], intersections:[{lat,lng,name,distance_m}], router } | null */
export async function walkRoute(points) {
  if (points.length < 2) return null;
  try { const r = await valhallaRoute(points); if (r) { routerUsed = "valhalla"; return { ...r, router: "valhalla" }; } } catch {}
  try { const r = await osrmRoute(points); if (r) { routerUsed = "osrm"; return { ...r, router: "osrm" }; } } catch {}
  return null;
}

/** 점들 사이 도보 거리표(m). Valhalla sources_to_targets → 실패하면 OSRM table → 실패하면 null(직선거리로 대신) */
export async function walkMatrix(points) {
  try {
    const locs = points.map((p) => ({ lat: p.lat, lon: p.lng }));
    const r = await fetch(`${VALHALLA}/sources_to_targets`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sources: locs, targets: locs, costing: "pedestrian", units: "kilometers" }), signal: AbortSignal.timeout(8000) });
    const d = await r.json();
    const m = d.sources_to_targets?.map((row) => row.map((c) => (c.distance == null ? null : c.distance * 1000)));
    if (m && m.length === points.length && !m.some((row) => row.some((v) => v == null))) { routerUsed = "valhalla"; return m; }
  } catch {}
  const coords = points.map((p) => `${p.lng},${p.lat}`).join(";");
  try {
    const r = await fetch(`https://router.project-osrm.org/table/v1/foot/${coords}?annotations=distance`, { signal: AbortSignal.timeout(8000) });
    const d = await r.json();
    const m = d.distances;
    if (!m || m.length !== points.length || m.some((row) => row.some((v) => v == null))) return null;
    routerUsed = "osrm"; return m;
  } catch { return null; }
}

/** start(점 번호)에서 출발해 idx(점 번호들)를 모두 들르는 "걷는 거리 합이 가장 짧은" 순서 (돌아오지 않는 열린 경로).
 *  14곳 이하는 Held-Karp 동적계획법으로 정확한 최단(2^14×14² ≈ 320만 연산, 폰에서도 1초 안). 그보다 많으면 최근접+2-opt 근사(approx=true).
 *  (2026-10-29 검증: 9곳을 근사로 돌리니 최단보다 304m(4.4%) 길었다 → 정확한 방법으로 교체) */
export const EXACT_LIMIT = 14;
function bestOpenPath(start, idx, D) {
  const n = idx.length;
  if (!n) return [];
  if (n <= EXACT_LIMIT) {
    const FULL = (1 << n) - 1;
    const dp = new Float64Array((1 << n) * n).fill(Infinity), par = new Int16Array((1 << n) * n).fill(-1);
    for (let j = 0; j < n; j++) dp[(1 << j) * n + j] = D[start][idx[j]];
    for (let mask = 1; mask <= FULL; mask++) for (let j = 0; j < n; j++) {
      if (!(mask & (1 << j))) continue;
      const cur = dp[mask * n + j]; if (cur === Infinity) continue;
      for (let k = 0; k < n; k++) {
        if (mask & (1 << k)) continue;
        const nm = mask | (1 << k), v = cur + D[idx[j]][idx[k]];
        if (v < dp[nm * n + k]) { dp[nm * n + k] = v; par[nm * n + k] = j; }
      }
    }
    let end = 0; for (let j = 1; j < n; j++) if (dp[FULL * n + j] < dp[FULL * n + end]) end = j;
    const order = []; let mask = FULL, j = end;
    while (j >= 0) { order.push(idx[j]); const pj = par[mask * n + j]; mask ^= 1 << j; j = pj; }
    return order.reverse();
  }
  const cost = (ord) => { let s = D[start][ord[0]]; for (let i = 1; i < ord.length; i++) s += D[ord[i - 1]][ord[i]]; return s; };
  const left = [...idx]; let cur = start, best = [];
  while (left.length) { left.sort((a, b) => D[cur][a] - D[cur][b]); cur = left.shift(); best.push(cur); }
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < best.length - 1; i++) for (let j = i + 1; j < best.length; j++) {
      const cand = [...best.slice(0, i), ...best.slice(i, j + 1).reverse(), ...best.slice(j + 1)];
      if (cost(cand) < cost(best) - 1) { best = cand; improved = true; }
    }
  }
  return best;
}
const distMatrix = (pts, matrix) => matrix ?? pts.map((a) => pts.map((b) => haversineM(a.lat, a.lng, b.lat, b.lng)));

/** 집에서 출발해 후보를 모두 들르는 최단 순서 (우선순위 무시). matrix 없으면 직선거리 */
export function tourOrder(home, candidates, matrix = null) {
  const list = candidates.filter((c) => c.lat && c.lng);
  if (!list.length) return [];
  const D = distMatrix([home, ...list], matrix);
  return bestOpenPath(0, list.map((_, i) => i + 1), D).map((i) => list[i - 1]);
}

/** 우선순위를 지키는 동선: 점수(tierOf)가 높은 묶음부터 차례로 들르고, 묶음 안에서는 1순위를 먼저 간 뒤 나머지를 걷는 거리가 가장 짧은 순서로.
 *  예비 후보를 따로 두지 않는다 — 점수 낮은 곳도 맨 뒤에 반드시 들른다. 다음 묶음은 앞 묶음의 마지막 지점에서 출발 */
export function tourOrderByPriority(home, candidates, matrix = null, tierOf = (c) => c.score ?? 0) {
  const list = candidates.filter((c) => c.lat && c.lng);
  if (!list.length) return [];
  const D = distMatrix([home, ...list], matrix);
  const tiers = [...new Set(list.map(tierOf))].sort((a, b) => b - a);
  const order = []; let cur = 0;
  for (const t of tiers) {
    const idx = list.map((_, i) => i + 1).filter((i) => tierOf(list[i - 1]) === t);
    // 묶음의 첫 번째(우선 확인 순서 1위, candidates 순서 기준)는 먼저 간다. 나머지만 최단 순서로
    const first = idx[0], rest = idx.slice(1);
    const part = [first, ...bestOpenPath(first, rest, D)];
    order.push(...part); cur = part[part.length - 1];
  }
  return order.map((i) => list[i - 1]);
}

// ---------------------------------------------------------------- 지도 그리기 (두 엔진 같은 인터페이스: setMarkers(list), setRoute(geometry))
export function createMap(lib, el, center, rMax) {
  return createNaverMap(lib, el, center, rMax);
}
// 핀 글자: c.pin — 동선 순서 번호("1"…), 갈림길 "✕", 동선에 없는 후보는 "·"(작은 회색 점).
// 이름표: 멀리서는(줌 < LABEL_ZOOM) "편의점"·"카페"처럼 종류만, 가까이서는(줌 ≥ LABEL_ZOOM) 가게 전체 이름. 화면 픽셀 기준으로 겹치는 이름표는 숨긴다 (번호 핀 → 점 → ✕ 순으로 우선, 오른쪽이 막히면 왼쪽). 핀을 누르면 언제나 말풍선으로 전체 이름.
const LABEL_ZOOM = 16;
const pinLabel = (c, i) => c.kind === "intersection" ? "✕" : (c.pin ?? String(i + 1));
const pinHtml = (c, i) => {
  const lbl = pinLabel(c, i), isX = lbl === "✕", isDot = lbl === "·";
  const size = isX ? 20 : isDot ? 16 : 28, bg = isX ? "#8a5a00" : isDot ? "#7d8796" : "#2f6fe4";
  return `<div title="${c.name}" style="width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center;background:${bg};color:#fff;font-weight:800;border-radius:50%;border:2px solid #fff;font-size:${isX ? 11 : isDot ? 12 : 14}px;box-shadow:0 1px 4px rgba(0,0,0,.35)">${isDot ? "" : lbl}</div>`;
};
const pinTitle = (c, i) => { const l = pinLabel(c, i); return l === "·" || l === "✕" ? c.name : `${l}. ${c.name}`; };
const pinAnchor = (c, i) => { const l = pinLabel(c, i); return l === "✕" ? 10 : l === "·" ? 8 : 14; };
/** 이름표 글: "편의점: GS25 대전석교중앙점" → "편의점 GS25 대전석교중앙점" 를 14자로 */
/** 이름표 글. 멀리서: "편의점", "카페", "갈림길" (종류). 가까이: "편의점 GS25 대전석교중앙점" (전체, 자르지 않음) */
const labelText = (c, i, zoom) => {
  if (c.kind === "intersection") return null; // 갈림길은 이름표 없음 (누르면 말풍선)
  const full = c.name.replace(/\s*\(.*?\)\s*/g, "").replace(/\s+/g, " ").trim();
  if (zoom >= LABEL_ZOOM) return full.replace(":", "");
  return c.kindOf || (full.includes(":") ? full.split(":")[0].trim() : full.length > 6 ? full.slice(0, 6) + "…" : full);
};
const labelHtml = (c, i, text) => { const l = pinLabel(c, i); const bg = l === "✕" ? "#fff4d6" : "#fff"; return `<div style="padding:1px 7px;font-size:12px;font-weight:700;color:#1c1b1a;background:${bg};border:1px solid rgba(0,0,0,.25);border-radius:6px;white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,.25);line-height:16px">${text}</div>`; };
const labelW = (text) => { let w = 16; for (const ch of text) w += ch.charCodeAt(0) > 0x7f ? 12 : 7; return w; };
const labelPriority = (c, i) => { const l = pinLabel(c, i); return l === "✕" ? 2 : l === "·" ? 1 : 0; };
/** 겹침 검사: items [{c,i,px,py}] (px,py = 핀 중심 화면 픽셀). 보이게 할 항목의 index 집합을 돌려준다 */
function pickVisibleLabels(items, viewW = Infinity) {
  const placed = [], show = new Map();
  const order = items.map((it, k) => ({ ...it, k })).sort((a, b) => labelPriority(a.c, a.i) - labelPriority(b.c, b.i) || a.i - b.i);
  const pinBoxes = items.map((it) => { const a = pinAnchor(it.c, it.i); return { x1: it.px - a, y1: it.py - a, x2: it.px + a, y2: it.py + a }; });
  const hit = (r, q) => !(r.x2 < q.x1 || r.x1 > q.x2 || r.y2 < q.y1 || r.y1 > q.y2);
  for (const it of order) {
    if (!it.text) continue;
    const a = pinAnchor(it.c, it.i), w = labelW(it.text), h = 20;
    const right = { x1: it.px + a + 2, y1: it.py - h / 2, x2: it.px + a + 2 + w, y2: it.py + h / 2 };
    const left = { x1: it.px - a - 2 - w, y1: it.py - h / 2, x2: it.px - a - 2, y2: it.py + h / 2 };
    const free = (r) => r.x1 >= 0 && r.x2 <= viewW && !placed.some((q) => hit(r, q)) && !pinBoxes.some((q, k) => k !== it.k && hit(r, q)); // 지도 밖으로 나가거나 다른 이름표·핀과 겹치면 안 됨
    if (free(right)) { placed.push(right); show.set(it.k, "right"); }
    else if (free(left)) { placed.push(left); show.set(it.k, "left"); }
  }
  return show; // Map(index → "right"|"left")
}


// 반경 원 색: 걸어서(실선 파랑), 버스·지하철(점선 초록), 택시(점선 주황). 버스·택시 원은 "최대로 갈 수 있는 거리"일 뿐 그 안에 있다는 뜻이 아니다
export const RING = { walk: { color: "#2f6fe4", name: "걸어서" }, bus: { color: "#1e7b4f", name: "버스·지하철" }, taxi: { color: "#b85c00", name: "택시" } };
const ringLabelHtml = (k, r) => `<div style="padding:1px 8px;font-size:12px;font-weight:800;color:#fff;background:${RING[k].color};border-radius:999px;white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,.3)">${RING[k].name} 최대 ${r >= 1000 ? (r / 1000).toFixed(r >= 10000 ? 0 : 1) + "km" : r + "m"}</div>`;
const ringTop = (center, r) => ({ lat: center.lat + r / 111320, lng: center.lng }); // 원 맨 위(북쪽) 점에 이름표
// 보호자 "나" 위치: 파란 점 + 흰 테두리 (이 기기에서만 쓰고 저장·전송하지 않음)
const meHtml = '<div style="width:18px;height:18px;border-radius:50%;background:#1a73e8;border:3px solid #fff;box-shadow:0 0 0 2px rgba(26,115,232,.35),0 1px 4px rgba(0,0,0,.4)"></div>';
const meTagHtml = '<div style="margin-top:2px;padding:0 6px;font-size:11px;font-weight:800;color:#fff;background:#1a73e8;border-radius:999px">나</div>';

function createNaverMap(naver, el, center, rMax) {
  const M = naver.maps;
  const map = new M.Map(el, { center: new M.LatLng(center.lat, center.lng), zoom: 15, zoomControl: true });
  let circle = null;
  if (rMax) circle = new M.Circle({ map, center: new M.LatLng(center.lat, center.lng), radius: rMax, strokeColor: RING.walk.color, strokeWeight: 2, strokeOpacity: .7, fillColor: RING.walk.color, fillOpacity: .06 });
  new M.Marker({ map, position: new M.LatLng(center.lat, center.lng), icon: { content: '<div style="background:#fff;border:2px solid #191f28;border-radius:999px;padding:2px 8px;font-weight:800;font-size:13px;color:#1c1b1a">집</div>', anchor: new M.Point(14, 14) } });
  let markers = [], labels = [], route = null, current = [];
  const info = new M.InfoWindow({ borderWidth: 1, backgroundColor: "#fff", anchorSize: new M.Size(10, 10) });
  M.Event.addListener(map, "click", () => info.close());
  function updateLabels() {
    labels.forEach((m) => m.setMap(null)); labels = [];
    const zoom = map.getZoom(), proj = map.getProjection();
    const items = current.map(({ c, i }) => { const p = proj.fromCoordToOffset(new M.LatLng(c.lat, c.lng)); return { c, i, px: p.x, py: p.y, text: labelText(c, i, zoom) }; });
    const show = pickVisibleLabels(items, map.getSize().width);
    items.forEach((it, k) => {
      if (!show.has(k)) return;
      const a = pinAnchor(it.c, it.i), ax = show.get(k) === "left" ? labelW(it.text) + a + 2 : -(a + 2);
      labels.push(new M.Marker({ map, position: new M.LatLng(it.c.lat, it.c.lng), icon: { content: labelHtml(it.c, it.i, it.text), anchor: new M.Point(ax, 10) }, clickable: false, zIndex: 50 }));
    });
  }
  M.Event.addListener(map, "idle", updateLabels);
  let ringObjs = [], rings = [], me = null, meAcc = null, lastBounds = null;
  const fitPins = () => { if (lastBounds) map.fitBounds(lastBounds, { top: 30, right: 30, bottom: 30, left: 30 }); else if (circle) map.fitBounds(circle.getBounds()); };
  return {
    map, circle,
    setRings(list) {
      ringObjs.forEach((o) => o.setMap(null)); ringObjs = [];
      const grew = list.some((x) => !rings.some((y) => y.key === x.key)); rings = list;
      for (const { key, r } of list) {
        const c = new M.Circle({ map, center: new M.LatLng(center.lat, center.lng), radius: r, strokeColor: RING[key].color, strokeWeight: 2, strokeOpacity: .8, strokeStyle: "shortdash", fillOpacity: 0, clickable: false });
        const t = ringTop(center, r);
        ringObjs.push(c, new M.Marker({ map, position: new M.LatLng(t.lat, t.lng), icon: { content: ringLabelHtml(key, r), anchor: new M.Point(50, 10) }, clickable: false, zIndex: 40 }));
        if (grew && r === Math.max(...list.map((x) => x.r))) map.fitBounds(c.getBounds());
      }
      if (!list.length) fitPins();
    },
    setMe(pos) {
      if (!pos) { if (me) { me.setMap(null); meAcc.setMap(null); me = meAcc = null; } return; }
      const ll = new M.LatLng(pos.lat, pos.lng);
      if (!me) {
        meAcc = new M.Circle({ map, center: ll, radius: pos.acc || 20, strokeColor: "#1a73e8", strokeWeight: 1, strokeOpacity: .4, fillColor: "#1a73e8", fillOpacity: .12, clickable: false });
        me = new M.Marker({ map, position: ll, icon: { content: `<div style="display:flex;flex-direction:column;align-items:center">${meHtml}${meTagHtml}</div>`, anchor: new M.Point(15, 9) }, zIndex: 1000, clickable: false });
      } else { me.setPosition(ll); meAcc.setCenter(ll); meAcc.setRadius(pos.acc || 20); }
    },
    centerOn(pos) { map.setCenter(new M.LatLng(pos.lat, pos.lng)); if (map.getZoom() < 16) map.setZoom(16); },
    setMarkers(list) {
      markers.forEach((m) => m.setMap(null)); markers = []; current = []; info.close();
      const bounds = new M.LatLngBounds(new M.LatLng(center.lat, center.lng), new M.LatLng(center.lat, center.lng));
      let any = false;
      list.forEach((c, i) => {
        if (!c.lat) return;
        const pos = new M.LatLng(c.lat, c.lng);
        const a = pinAnchor(c, i);
        const mk = new M.Marker({ map, position: pos, icon: { content: pinHtml(c, i), anchor: new M.Point(a, a) }, title: c.name, zIndex: 100 });
        M.Event.addListener(mk, "click", () => { info.setContent(`<div style="padding:6px 10px;font-size:14px;font-weight:700;color:#1c1b1a;white-space:nowrap">${pinTitle(c, i)}</div>`); info.open(map, mk); });
        markers.push(mk); current.push({ c, i });
        if (c.kind !== "intersection" && pinLabel(c, i) !== "·") { bounds.extend(pos); any = true; } // 화면 맞춤은 동선 핀 기준
      });
      lastBounds = any ? bounds : null;
      if (!rings.length) fitPins();
      updateLabels();
    },
    setRoute(geometry) {
      if (route) { route.setMap(null); route = null; }
      if (geometry?.length) route = new M.Polyline({ map, path: geometry.map(([lat, lng]) => new M.LatLng(lat, lng)), strokeColor: "#b3261e", strokeWeight: 5, strokeOpacity: .75 });
    },
  };
}

/** 두 좌표 사이 직선거리(m) */
export function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371000, toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}
