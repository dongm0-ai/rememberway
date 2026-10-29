// 지도: OpenStreetMap + Leaflet (키·계정 불필요, 한국어 일반 지도).
//  - 장소 이름 → 좌표: Nominatim (OSM 공개 지오코더). "카페·편의점·세탁소"처럼 종류만 말한 곳은 집 근처에서 여러 개 찾는다.
//  - 도보 길찾기: OSRM 공개 서버 (foot). 경로선·거리·교차로(갈림길)를 받아 "경로 위 교차로" 가중치에 쓴다.
//  이 둘은 공개 데모 서버라 호출을 아끼고(1초 1회), 실패하면 직선거리로 내려간다. 결정표 2026-10-29.
const LEAFLET_CSS = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
const LEAFLET_JS = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
let loading = null;
let engine = "osm"; // "osm" | "naver" — /api/config 의 map.provider 로 정해짐 (.env MAP_PROVIDER)

/** 지도 엔진 로드. cfg = /api/config 의 map 객체. 반환: 엔진 객체(window.L 또는 window.naver) 또는 null */
export function loadMap(cfg = {}) {
  if (loading) return loading;
  if (cfg.provider === "naver" && cfg.naverClientId) {
    engine = "naver";
    loading = new Promise((resolve) => {
      if (window.naver?.maps) return resolve(window.naver);
      const s = document.createElement("script");
      s.src = `https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=${encodeURIComponent(cfg.naverClientId)}`;
      s.onload = () => resolve(window.naver?.maps ? window.naver : null); s.onerror = () => resolve(null);
      document.head.append(s);
    });
    return loading;
  }
  engine = "osm";
  if (window.L?.map) return Promise.resolve(window.L);
  loading = new Promise((resolve) => {
    const css = document.createElement("link"); css.rel = "stylesheet"; css.href = LEAFLET_CSS; document.head.append(css);
    const s = document.createElement("script"); s.src = LEAFLET_JS;
    s.onload = () => resolve(window.L); s.onerror = () => resolve(null);
    document.head.append(s);
  });
  return loading;
}
export function mapEngine() { return engine; }

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

/** "카페", "편의점"처럼 종류만 말한 곳 → 집 반경 안 실제 가게 (서버 함수 /api/nearby 가 OSM Overpass를 대신 호출). 최대 n곳, 가까운 순 */
const GENERIC_KINDS = ["카페","커피숍","커피","편의점","슈퍼","마트","세탁소","무인세탁","무인세탁실","세탁","빨래방","약국","병원","의원","시장","경로당","노인정","교회","성당","절","공원","은행","우체국","목욕탕","사우나","미용실","이발소","정류장","버스정류장","지하철역","역","학교","놀이터","주민센터","복지관"];
export function isGeneric(name) { return GENERIC_KINDS.includes(name.replace(/\s+/g, "")); }
let homeLabel = ""; // 네이버 검색어에 붙일 동 이름 ("대전 중구 석교동")
export function setHomeLabel(s) { homeLabel = s || ""; }
async function naverSearch(q, near, n) {
  try {
    const r = await fetch(`/api/search?q=${encodeURIComponent(q)}&lat=${near?.lat ?? ""}&lng=${near?.lng ?? ""}&n=${n}`, { signal: AbortSignal.timeout(10000) });
    const d = await r.json();
    return d.ok ? d.places : null; // null = 설정 없음/실패 → 다른 방법으로
  } catch { return null; }
}
export async function findNearby(kind, home, radiusM = 1500, n = 3) {
  const nv = await naverSearch(`${homeLabel} ${kind}`.trim(), home, n);
  if (nv && nv.length) return nv.filter((p) => !p.distance_m || p.distance_m <= Math.max(radiusM, 2000));
  try {
    const r = await fetch(`/api/nearby?kind=${encodeURIComponent(kind)}&lat=${home.lat}&lng=${home.lng}&r=${Math.round(radiusM)}&n=${n}`, { signal: AbortSignal.timeout(15000) });
    const d = await r.json();
    return d.ok ? d.places : [];
  } catch { return []; }
}

/** 이름으로 못 찾으면 더 단순한 이름으로 다시: "삼성동 옛 동네" → "삼성동", "중앙시장 정육점" → "중앙시장" */
export async function findPlaceLoose(name, near) {
  // 네이버 검색이 설정돼 있으면 가게·시설 이름은 거기가 훨씬 정확 ("석교동 경로당", "중앙시장 ○○정육점")
  const nv = await naverSearch(name.includes(" ") || !homeLabel ? name : `${homeLabel.split(/\s+/).slice(-1)[0]} ${name}`, near, 1);
  if (nv && nv.length) return { ...nv[0], approx: false };
  const direct = await findPlace(name, near);
  if (direct) return { ...direct, approx: false };
  const tokens = name.split(/\s+/).filter(Boolean);
  const core = tokens.find((t) => /(동|읍|면|리|시장|역|병원|공원|학교|교회|성당|절|마트|터미널|정류장|경로당|센터)$/.test(t));
  if (core && core !== name) { const f = await findPlace(core, near); if (f) return { ...f, approx: true }; }
  return null;
}

/** 집(동 단위) 좌표. "대전 중구 석교동"처럼 시·구까지 적으면 정확도가 올라간다 */
export async function findHome(dong) {
  // 네이버가 설정돼 있으면 서버의 네이버 Geocoding 먼저 (주소 정확도 높음), 아니면 OSM
  try { const r = await fetch(`/api/geocode?q=${encodeURIComponent(dong)}`); const d = await r.json(); if (d.ok) return { lat: d.lat, lng: d.lng, found_name: d.found_name }; } catch {}
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

// ---------------------------------------------------------------- 지도 그리기 (두 엔진 같은 인터페이스: setMarkers(list), setRoute(geometry))
export function createMap(lib, el, center, rMax) {
  return engine === "naver" ? createNaverMap(lib, el, center, rMax) : createLeafletMap(lib, el, center, rMax);
}
const pinHtml = (c, i) => { const isX = c.kind === "intersection"; return `<div style="background:${isX ? "#8a5a00" : "#1f5a95"};color:#fff;font-weight:800;border-radius:999px;padding:2px 8px;font-size:${isX ? 11 : 13}px;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,.3)">${isX ? "✕ " : i + 1 + " "}${c.name}</div>`; };

function createLeafletMap(L, el, center, rMax) {
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
        const icon = L.divIcon({ className: "", html: pinHtml(c, i), iconAnchor: [10, 10] });
        L.marker([c.lat, c.lng], { icon }).addTo(layer); if (c.kind !== "intersection") pts.push([c.lat, c.lng]);
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

function createNaverMap(naver, el, center, rMax) {
  const M = naver.maps;
  const map = new M.Map(el, { center: new M.LatLng(center.lat, center.lng), zoom: 15, zoomControl: true });
  let circle = null;
  if (rMax) circle = new M.Circle({ map, center: new M.LatLng(center.lat, center.lng), radius: rMax, strokeColor: "#1f5a95", strokeWeight: 2, strokeOpacity: .6, fillColor: "#1f5a95", fillOpacity: .06 });
  new M.Marker({ map, position: new M.LatLng(center.lat, center.lng), icon: { content: '<div style="background:#fff;border:2px solid #1f5a95;border-radius:999px;padding:2px 8px;font-weight:800;font-size:13px;color:#1c1b1a">집</div>', anchor: new M.Point(14, 14) } });
  let markers = [], route = null;
  return {
    map, circle,
    setMarkers(list) {
      markers.forEach((m) => m.setMap(null)); markers = [];
      const bounds = new M.LatLngBounds(new M.LatLng(center.lat, center.lng), new M.LatLng(center.lat, center.lng));
      let any = false;
      list.forEach((c, i) => {
        if (!c.lat) return;
        const pos = new M.LatLng(c.lat, c.lng);
        markers.push(new M.Marker({ map, position: pos, icon: { content: pinHtml(c, i), anchor: new M.Point(10, 10) } }));
        if (c.kind !== "intersection") { bounds.extend(pos); any = true; }
      });
      if (any) map.fitBounds(bounds, { top: 30, right: 30, bottom: 30, left: 30 });
      else if (circle) map.fitBounds(circle.getBounds());
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
