// 지도: OpenStreetMap + Leaflet (키·계정 불필요, 한국어 일반 지도).
//  - 장소 이름 → 좌표: Nominatim (OSM 공개 지오코더). "카페·편의점·세탁소"처럼 종류만 말한 곳은 집 근처에서 여러 개 찾는다.
//  - 도보 길찾기: OSRM 공개 서버 (foot). 경로선·거리·교차로(갈림길)를 받아 "경로 위 교차로" 가중치에 쓴다.
//  이 둘은 공개 데모 서버라 호출을 아끼고(1초 1회), 실패하면 직선거리로 내려간다. 결정표 2026-10-29.
const LEAFLET_CSS = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
const LEAFLET_JS = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
let loading = null;

export function loadMap() {
  if (window.L?.map) return Promise.resolve(window.L);
  if (loading) return loading;
  loading = new Promise((resolve) => {
    const css = document.createElement("link"); css.rel = "stylesheet"; css.href = LEAFLET_CSS; document.head.append(css);
    const s = document.createElement("script"); s.src = LEAFLET_JS;
    s.onload = () => resolve(window.L); s.onerror = () => resolve(null);
    document.head.append(s);
  });
  return loading;
}

// ---------------------------------------------------------------- 장소 찾기 (Nominatim)
const cache = new Map();
let lastCall = 0;
async function throttle() { const wait = 1100 - (Date.now() - lastCall); if (wait > 0) await new Promise((r) => setTimeout(r, wait)); lastCall = Date.now(); }

async function nominatim(params) {
  const key = params.toString();
  if (cache.has(key)) return cache.get(key);
  await throttle();
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, { headers: { accept: "application/json" } });
    const arr = await r.json();
    cache.set(key, arr); return arr;
  } catch { return []; }
}
const toPlace = (d, name) => ({ lat: Number(d.lat), lng: Number(d.lon), found_name: d.namedetails?.["name:ko"] || d.namedetails?.name || d.display_name?.split(",")[0] || name, address: d.display_name, category: d.type });

/** 이름 하나 → 좌표 하나. near={lat,lng}면 그 주변(±0.1도 ≈ 10km) 우선 */
export async function findPlace(name, near, limit = 1) {
  const p = new URLSearchParams({ q: name, format: "jsonv2", limit: String(limit), countrycodes: "kr", "accept-language": "ko", namedetails: "1" });
  if (near) { p.set("viewbox", `${near.lng - 0.1},${near.lat + 0.1},${near.lng + 0.1},${near.lat - 0.1}`); p.set("bounded", "0"); }
  const arr = await nominatim(p);
  return arr?.[0] ? toPlace(arr[0], name) : null;
}

/** "카페", "편의점"처럼 종류만 말한 곳 → OSM 태그로 집 반경 안 실제 가게를 찾는다 (Overpass 공개 API). 최대 n곳, 가까운 순 */
const KIND_TAGS = {
  카페: ['amenity=cafe'], 커피숍: ['amenity=cafe'], 커피: ['amenity=cafe'],
  편의점: ['shop=convenience'], 슈퍼: ['shop=supermarket', 'shop=convenience'], 마트: ['shop=supermarket'],
  세탁소: ['shop=laundry', 'shop=dry_cleaning'], 무인세탁: ['shop=laundry'], 세탁: ['shop=laundry', 'shop=dry_cleaning'], 빨래방: ['shop=laundry'],
  약국: ['amenity=pharmacy'], 병원: ['amenity=hospital', 'amenity=clinic'], 의원: ['amenity=clinic', 'amenity=doctors'],
  시장: ['amenity=marketplace'], 경로당: ['amenity=social_facility', 'amenity=community_centre'], 노인정: ['amenity=social_facility', 'amenity=community_centre'],
  교회: ['amenity=place_of_worship'], 성당: ['amenity=place_of_worship'], 절: ['amenity=place_of_worship'],
  공원: ['leisure=park'], 은행: ['amenity=bank'], 우체국: ['amenity=post_office'], 목욕탕: ['amenity=public_bath'], 사우나: ['amenity=public_bath'],
  미용실: ['shop=hairdresser'], 이발소: ['shop=hairdresser'], 정류장: ['highway=bus_stop'], 버스정류장: ['highway=bus_stop'],
  지하철역: ['railway=station'], 역: ['railway=station'], 학교: ['amenity=school'], 놀이터: ['leisure=playground'], 주민센터: ['amenity=townhall'], 복지관: ['amenity=social_facility'],
};
export function isGeneric(name) { return Boolean(KIND_TAGS[name.replace(/\s+/g, "")]); }
export async function findNearby(kind, home, radiusM = 1500, n = 3) {
  const tags = KIND_TAGS[kind.replace(/\s+/g, "")];
  if (!tags) return [];
  const q = `[out:json][timeout:10];(${tags.map((t) => { const [k, v] = t.split("="); return `nwr["${k}"="${v}"](around:${Math.round(radiusM)},${home.lat},${home.lng});`; }).join("")});out center ${n * 4};`;
  try {
    await throttle();
    const r = await fetch("https://overpass-api.de/api/interpreter", { method: "POST", body: "data=" + encodeURIComponent(q), headers: { "content-type": "application/x-www-form-urlencoded" }, signal: AbortSignal.timeout(12000) });
    const data = await r.json();
    const list = (data.elements ?? []).map((e) => ({ lat: e.lat ?? e.center?.lat, lng: e.lon ?? e.center?.lon, found_name: e.tags?.["name:ko"] || e.tags?.name || `(이름 없는 ${kind})`, category: kind }))
      .filter((x) => x.lat && x.lng)
      .map((x) => ({ ...x, distance_m: haversineM(home.lat, home.lng, x.lat, x.lng) }))
      .sort((a, b) => a.distance_m - b.distance_m);
    // 같은 이름 중복 제거, 가까운 n곳
    const seen = new Set();
    return list.filter((x) => (seen.has(x.found_name) ? false : seen.add(x.found_name))).slice(0, n);
  } catch { return []; }
}

/** 이름으로 못 찾으면 더 단순한 이름으로 다시: "삼성동 옛 동네" → "삼성동", "중앙시장 정육점" → "중앙시장" */
export async function findPlaceLoose(name, near) {
  const direct = await findPlace(name, near);
  if (direct) return { ...direct, approx: false };
  const tokens = name.split(/\s+/).filter(Boolean);
  const core = tokens.find((t) => /(동|읍|면|리|시장|역|병원|공원|학교|교회|성당|절|마트|터미널|정류장|경로당|센터)$/.test(t));
  if (core && core !== name) { const f = await findPlace(core, near); if (f) return { ...f, approx: true }; }
  return null;
}

/** 집(동 단위) 좌표. "대전 중구 석교동"처럼 시·구까지 적으면 정확도가 올라간다 */
export async function findHome(dong) {
  return (await findPlace(dong, null)) ?? (await findPlace(dong.split(/\s+/).slice(-1)[0], null));
}

// ---------------------------------------------------------------- 도보 길찾기 (OSRM)
/** points: [{lat,lng}, ...] 순서대로 걷는 경로. 반환 { geometry:[[lat,lng]...], distance_m, duration_s, legs:[{distance_m,duration_s}], intersections:[{lat,lng,name,distance_m}] } | null */
export async function walkRoute(points) {
  if (points.length < 2) return null;
  const coords = points.map((p) => `${p.lng},${p.lat}`).join(";");
  try {
    const r = await fetch(`https://router.project-osrm.org/route/v1/foot/${coords}?overview=full&geometries=geojson&steps=true`, { signal: AbortSignal.timeout(8000) });
    const data = await r.json();
    const route = data.routes?.[0];
    if (!route) return null;
    const geometry = route.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
    const intersections = [];
    let acc = 0;
    for (const leg of route.legs) {
      for (const step of leg.steps) {
        // 갈림길: 길이 3갈래 이상 만나는 지점에서 방향을 바꾸는 곳 (배회가 시작되기 쉬운 곳)
        const m = step.maneuver;
        const big = (step.intersections ?? []).some((x) => (x.bearings ?? []).length >= 3);
        if (big && !["depart", "arrive"].includes(m.type) && step.name && acc >= 150 && !intersections.some((x) => x.name === `${step.name} 갈림길`)) {
          intersections.push({ lat: m.location[1], lng: m.location[0], name: `${step.name} 갈림길`, distance_m: Math.round(acc) });
        }
        acc += step.distance;
      }
    }
    return { geometry, distance_m: Math.round(route.distance), duration_s: Math.round(route.duration), legs: route.legs.map((l) => ({ distance_m: Math.round(l.distance), duration_s: Math.round(l.duration) })), intersections };
  } catch { return null; }
}

/** 집에서 출발해 후보들을 가까운 순으로 차례로 도는 순서 (탐욕적 최근접). 반환 후보 배열 */
export function tourOrder(home, candidates) {
  const left = candidates.filter((c) => c.lat && c.lng).map((c) => ({ ...c }));
  const order = []; let cur = home;
  while (left.length) {
    left.sort((a, b) => dist2(cur, a) - dist2(cur, b));
    const next = left.shift(); order.push(next); cur = next;
  }
  return order;
}
const dist2 = (a, b) => (a.lat - b.lat) ** 2 + ((a.lng - b.lng) * Math.cos((a.lat * Math.PI) / 180)) ** 2;

// ---------------------------------------------------------------- 지도 그리기
export function createMap(L, el, center, rMax) {
  const map = L.map(el, { zoomControl: true, attributionControl: true }).setView([center.lat, center.lng], 15);
  // OSM 표준 타일: 한국 지역은 한국어 지명으로 표시되는 일반(도로) 지도. 위성 아님.
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' }).addTo(map);
  let circle = null;
  if (rMax) circle = L.circle([center.lat, center.lng], { radius: rMax, color: "#1f5a95", weight: 2, opacity: .6, fillColor: "#1f5a95", fillOpacity: .06 }).addTo(map);
  L.marker([center.lat, center.lng], { title: "집·마지막 본 곳" }).addTo(map).bindTooltip("집", { permanent: true, direction: "top" });
  const layer = L.layerGroup().addTo(map);
  const routeLayer = L.layerGroup().addTo(map);
  return {
    map, circle,
    setMarkers(list) {
      layer.clearLayers();
      const pts = [[center.lat, center.lng]];
      list.forEach((c, i) => {
        if (!c.lat) return;
        const isX = c.kind === "intersection";
        const icon = L.divIcon({ className: "", html: `<div style="background:${isX ? "#8a5a00" : "#1f5a95"};color:#fff;font-weight:800;border-radius:999px;padding:2px 8px;font-size:${isX ? 11 : 13}px;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,.3)">${isX ? "✕ " : i + 1 + " "}${c.name}</div>`, iconAnchor: [10, 10] });
        L.marker([c.lat, c.lng], { icon }).addTo(layer); if (!isX) pts.push([c.lat, c.lng]);
      });
      if (pts.length > 1) map.fitBounds(pts, { padding: [30, 30], maxZoom: 16 });
      else if (circle) map.fitBounds(circle.getBounds(), { padding: [10, 10] });
    },
    setRoute(geometry) {
      routeLayer.clearLayers();
      if (geometry?.length) L.polyline(geometry, { color: "#b3261e", weight: 5, opacity: .75 }).addTo(routeLayer);
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
