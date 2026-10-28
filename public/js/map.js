// 지도: OpenStreetMap + Leaflet (키·계정 불필요). 장소 이름 → 좌표는 Nominatim(OSM 공개 지오코더).
// 카카오맵은 2026-10-28 밤에 제외 (계정·도메인·쿼터 결정 부담). 도보 경로·교차로는 여전히 미연동 (직선거리).
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

const cache = new Map();
let lastCall = 0;
/** Nominatim 검색 (이용 규칙: 1초에 1회 이하). near={lat,lng}가 있으면 그 주변 약 10km를 우선 */
export async function findPlace(name, near) {
  const key = `${name}|${near ? near.lat.toFixed(2) + "," + near.lng.toFixed(2) : ""}`;
  if (cache.has(key)) return cache.get(key);
  const wait = 1100 - (Date.now() - lastCall);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
  const p = new URLSearchParams({ q: name, format: "jsonv2", limit: "1", countrycodes: "kr", "accept-language": "ko" });
  if (near) { p.set("viewbox", `${near.lng - 0.1},${near.lat + 0.1},${near.lng + 0.1},${near.lat - 0.1}`); p.set("bounded", "0"); }
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?${p}`, { headers: { accept: "application/json" } });
    const arr = await r.json();
    const d = arr?.[0];
    const out = d ? { lat: Number(d.lat), lng: Number(d.lon), found_name: d.display_name?.split(",")[0] ?? name, address: d.display_name } : null;
    cache.set(key, out); return out;
  } catch { return null; }
}

/** 장소 이름으로 못 찾으면 더 단순한 이름으로 다시: "삼성동 옛 동네" → "삼성동", "중앙시장 정육점" → "중앙시장" */
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

/** 지도 만들기. 반환: { map, setMarkers(list), circle } */
export function createMap(L, el, center, rMax) {
  const map = L.map(el, { zoomControl: true, attributionControl: true }).setView([center.lat, center.lng], 14);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' }).addTo(map);
  let circle = null;
  if (rMax) circle = L.circle([center.lat, center.lng], { radius: rMax, color: "#1f5a95", weight: 2, opacity: .6, fillColor: "#1f5a95", fillOpacity: .08 }).addTo(map);
  const home = L.marker([center.lat, center.lng], { title: "집·마지막 본 곳" }).addTo(map).bindTooltip("집", { permanent: true, direction: "top" });
  let layer = L.layerGroup().addTo(map);
  return {
    map, circle,
    setMarkers(list) {
      layer.clearLayers();
      const pts = [[center.lat, center.lng]];
      list.forEach((c, i) => {
        if (!c.lat) return;
        const icon = L.divIcon({ className: "", html: `<div style="background:#1f5a95;color:#fff;font-weight:800;border-radius:999px;padding:2px 8px;font-size:13px;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,.3)">${i + 1} ${c.name}</div>`, iconAnchor: [10, 10] });
        L.marker([c.lat, c.lng], { icon }).addTo(layer); pts.push([c.lat, c.lng]);
      });
      if (pts.length > 1) map.fitBounds(pts, { padding: [30, 30], maxZoom: 16 });
      else if (circle) map.fitBounds(circle.getBounds(), { padding: [10, 10] });
    },
  };
}
