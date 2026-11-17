// REMEMBER WAY AI — 예상 경로·닿을 수 있는 범위·후보지 특징 (규칙, 코드). 생성형 AI는 숫자를 계산하지 않는다.
// 브라우저(후보지 카드·지도)와 Node(테스트)가 같이 쓴다. 순수 함수 — DOM·네트워크·저장소를 쓰지 않는다.
//
// 직선 진행 가정: 길 잃은 치매 어르신이 한 방향으로 계속 가는 경향이 있다는 연구를 근거로, 마지막 방향·속도로 직선 이동한다고 가정한다.
//   Koester & Stooksbury (1995), Wilderness & Environmental Medicine (사용자 결정으로 기재 — 이 코드에서 본문을 확인하지 않았다).
//   예상은 단정이 아니다. 후보를 줄여 보여 주는 계산이고, 위치는 보호자가 지도에서 직접 확인한다.
//
// ① lastMotion  GPS 점 → 마지막 움직임: 움직이다 끊김(moving_lost) / 그 자리에 머묾(stayed) / 기록 없음(none)
//    머묾: 마지막 점 속도 1km/h 미만, 또는 마지막 두 점이 30m 안이고 3분 이상 떨어짐. 속도·방향은 마지막 점과 10분 안의 최근 6점 이하로.
// ② projectPath  마지막 시각부터 지금까지 같은 방향·속도로 직선 이동한 예상 위치 (대권 목적지 공식, 10분마다 + 지금)
// ③ reachM       끊긴 뒤 걸어서 닿을 수 있는 최대 거리 (경과 시간 × 걸음 속도 WALK_SPEED.normal)
// ④ candidateFeatures  후보 장소마다 마지막 위치까지 거리·진행 방향과의 각도 차·닿을 수 있는지·예상 경로까지 거리 (정수 반올림)
// ⑤ fallbackOrder  AI가 안 될 때 쓰는 코드 순서: 닿을 수 있는 곳 먼저 → 예상 경로에 가까운 순 → 같으면 추억의 장소(memory) 먼저

import { distM } from "./gps.js";
import { WALK_SPEED } from "./schema.js";

const R = 6371000;                       // distM(gps.js)과 같은 지구 반지름(m)
const rad = (x) => (x * Math.PI) / 180, deg = (x) => (x * 180) / Math.PI;
const MIN_MS = 60000;
const STAY_KMH = 1, STAY_M = 30, STAY_GAP_MS = 3 * MIN_MS;   // 머묾 판정
const WINDOW_MS = 10 * MIN_MS, WINDOW_N = 6;                 // 속도·방향 계산에 쓰는 최근 점
const MAX_PATH_POINTS = 1000;                                // 끝없이 오래된 기록에도 배열이 무한히 커지지 않게

const num = (v) => typeof v === "number" && Number.isFinite(v);
const validPoint = (p) => !!p && num(p.t) && num(p.lat) && num(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180 && !(p.lat === 0 && p.lng === 0);
const median = (a) => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** a → b 처음 방위각(0~360, 북 0·동 90) */
function bearing(a, b) {
  const f1 = rad(a.lat), f2 = rad(b.lat), dl = rad(b.lng - a.lng);
  return (deg(Math.atan2(Math.sin(dl) * Math.cos(f2), Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl))) + 360) % 360;
}
/** 두 방위각 차이(0~180) */
const angleDiff = (a, b) => Math.abs((((a - b) % 360) + 540) % 360 - 180);
/** p에서 방위각 brg(°)로 distance(m) 직진한 점 — 대권 목적지 공식 */
function destination(p, brg, distance) {
  const d = distance / R, th = rad(brg), f1 = rad(p.lat), l1 = rad(p.lng);
  const f2 = Math.asin(Math.sin(f1) * Math.cos(d) + Math.cos(f1) * Math.sin(d) * Math.cos(th));
  const l2 = l1 + Math.atan2(Math.sin(th) * Math.sin(d) * Math.cos(f1), Math.cos(d) - Math.sin(f1) * Math.sin(f2));
  let lng = deg(l2);
  if (lng > 180 || lng < -180) lng = ((lng + 540) % 360) - 180;
  return { lat: deg(f2), lng };
}
const hasCoord = (p) => !!p && num(p.lat) && num(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180 && !(p.lat === 0 && p.lng === 0);

/**
 * GPS 점 → 마지막 움직임.
 * @param {{t:number, lat:number, lng:number, speed_kmh?:number}[]} points t는 ms, 순서 무관
 * @returns {{state:"none"} | {state:"stayed", lat:number, lng:number, t:number}
 *   | {state:"moving_lost", lat:number, lng:number, t:number, speedMps:number, bearingDeg:number}}
 */
export function lastMotion(points) {
  const pts = (Array.isArray(points) ? points : []).filter(validPoint).sort((a, b) => a.t - b.t);
  if (!pts.length) return { state: "none" };
  const last = pts[pts.length - 1];
  const stayed = { state: "stayed", lat: last.lat, lng: last.lng, t: last.t };
  if (num(last.speed_kmh) && last.speed_kmh < STAY_KMH) return stayed;
  const prev = pts[pts.length - 2];
  if (prev && distM(prev, last) < STAY_M && last.t - prev.t >= STAY_GAP_MS) return stayed;
  const win = pts.filter((p) => last.t - p.t <= WINDOW_MS).slice(-WINDOW_N);
  if (win.length < 2) return stayed;                          // 방향을 계산할 수 없다
  const first = win[0], d = distM(first, last);
  if (!(d > 0)) return stayed;                                // 제자리 — 방위각이 없다
  const speeds = win.map((p) => p.speed_kmh).filter(num).map((v) => v / 3.6);
  const secs = (last.t - first.t) / 1000;
  const speedMps = speeds.length ? median(speeds) : secs > 0 ? d / secs : 0;
  if (!(speedMps > 0)) return stayed;
  return { state: "moving_lost", lat: last.lat, lng: last.lng, t: last.t, speedMps, bearingDeg: bearing(first, last) };
}

/**
 * 예상 경로: moving_lost일 때만. 마지막 시각 + stepMin마다, 마지막 점은 nowMs(지금)까지. 마지막 위치 자체는 넣지 않는다.
 * @returns {{t:number, lat:number, lng:number}[]}
 */
export function projectPath(motion, nowMs, stepMin = 10) {
  if (!motion || motion.state !== "moving_lost" || !num(motion.t) || !num(motion.lat) || !num(motion.lng) || !num(motion.speedMps) || !(motion.speedMps > 0) || !num(motion.bearingDeg)) return [];
  const step = stepMin * MIN_MS;
  if (!num(nowMs) || !(step > 0) || !(nowMs > motion.t)) return [];
  const at = (t) => ({ t, ...destination(motion, motion.bearingDeg, (motion.speedMps * (t - motion.t)) / 1000) });
  const n = Math.floor((nowMs - motion.t) / step), out = [];
  for (let k = 1; k <= Math.min(n, MAX_PATH_POINTS); k++) out.push(at(motion.t + k * step));
  if (n < MAX_PATH_POINTS && motion.t + n * step < nowMs) out.push(at(nowMs));
  return out;
}

/** 끊긴 뒤 걸어서 닿을 수 있는 최대 거리(m). 기록이 없거나 시각이 거꾸로면 0 */
export function reachM(motion, nowMs, speedMps = WALK_SPEED.normal) {
  if (!motion || !num(motion.t) || !num(nowMs) || !num(speedMps)) return 0;
  return Math.max(0, ((nowMs - motion.t) / 1000) * speedMps);
}

/**
 * 후보 장소마다 계산값을 붙인다. 좌표 없는 장소는 뺀다. GPS 기록이 없으면(none) 거리를 잴 수 없어 [].
 * @param {{id:string, name:string, lat:number, lng:number, source:string, evidence?:string}[]} places
 * @returns {Array<object>} 입력 필드 + dist_m(마지막 위치까지) · bearing_diff_deg(moving_lost만 0~180, 아니면 null)
 *   · reachable(걸어서 닿을 수 있나) · path_dist_m(예상 경로 점들까지 최소 거리, 경로 없으면 null) — 모두 정수
 */
export function candidateFeatures(motion, nowMs, places) {
  if (!motion || !num(motion.lat) || !num(motion.lng) || !Array.isArray(places)) return [];
  const reach = reachM(motion, nowMs), path = projectPath(motion, nowMs);
  const heading = motion.state === "moving_lost" && num(motion.bearingDeg);
  return places.filter(hasCoord).map((p) => {
    const dist = distM(motion, p);
    const diff = !heading ? null : dist > 0 ? angleDiff(bearing(motion, p), motion.bearingDeg) : 0;
    const onPath = path.length ? path.reduce((m, q) => Math.min(m, distM(q, p)), Infinity) : null;
    return { ...p, dist_m: Math.round(dist), bearing_diff_deg: diff === null ? null : Math.round(diff), reachable: dist <= reach, path_dist_m: onPath === null ? null : Math.round(onPath) };
  });
}

/** AI가 안 될 때 코드 순서: 닿을 수 있는 곳 먼저 → path_dist_m(없으면 dist_m) 가까운 순 → 같으면 추억의 장소(memory) 먼저. 새 배열 */
export function fallbackOrder(features) {
  const key = (f) => f.path_dist_m ?? f.dist_m ?? Infinity;
  return [...(Array.isArray(features) ? features : [])].sort((a, b) =>
    Number(b.reachable === true) - Number(a.reachable === true)
    || key(a) - key(b)
    || Number(b.source === "memory") - Number(a.source === "memory"));
}
