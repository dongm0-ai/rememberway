// 오늘 GPS 기록 → 보호자가 고쳐 쓸 "오늘 움직임" 문장 (규칙, AI 아님. 브라우저·서버 공용)
// 쓰는 곳: 실종자 찾기 첫 화면(report.html). 문장을 입력칸에 넣어 주면 보호자가 그 위에 살을 붙여 말한다.
// GPS를 정답으로 쓰지 않는다 — 보호자가 고치고 덧붙이는 출발점일 뿐이다. 그래서 문장에 "GPS 기록으로는"을 붙인다.
// 집 주소는 문장에 넣지 않는다 (집에서 가까우면 "집 근처"). 다른 곳은 동·길 이름까지만 (shortPlace).
import { lastMotion, direction8 } from "./predict.js";
import { distM } from "./gps.js";

const MIN = 60000;
export const TRIP_GAP_MS = 5 * MIN;   // 이보다 오래 기록이 비면 다른 나들이로 본다
export const HOME_NEAR_M = 150;       // 출발점이 집에서 이 안이면 "집 근처"
export const TOWARD_DEG = 30;         // 가던 방향 ±이 각도 안의 등록 장소를 "○○ 쪽"으로 적는다
export const TOWARD_MAX_M = 1500;

const num = (v) => typeof v === "number" && Number.isFinite(v);
const ok = (p) => !!p && num(p.t) && num(p.lat) && num(p.lng);
const bearing = (a, b) => {
  const r = (x) => (x * Math.PI) / 180, y = Math.sin(r(b.lng - a.lng)) * Math.cos(r(b.lat));
  const x = Math.cos(r(a.lat)) * Math.sin(r(b.lat)) - Math.sin(r(a.lat)) * Math.cos(r(b.lat)) * Math.cos(r(b.lng - a.lng));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
};
const angleDiff = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

/** 오늘 점 중 마지막 나들이(기록이 TRIP_GAP_MS 넘게 비지 않고 이어진 구간) */
export function lastTrip(points) {
  const pts = (Array.isArray(points) ? points : []).filter(ok).sort((a, b) => a.t - b.t);
  let i = pts.length - 1;
  while (i > 0 && pts[i].t - pts[i - 1].t <= TRIP_GAP_MS) i--;
  return pts.slice(i);
}

/**
 * 문장에 쓸 세 점과 움직임. 주소 이름은 화면이 이 점들로 찾아서 storyText 에 넘긴다.
 * @returns {null | {start, mid, end, motion, startNearHome:boolean, toward:string|null}}
 */
export function storyPoints(points, { home = null, places = [] } = {}) {
  const trip = lastTrip(points);
  if (trip.length < 2) return null;
  const start = trip[0], end = trip[trip.length - 1], mid = trip[Math.floor(trip.length / 2)];
  const motion = lastMotion(trip);
  const startNearHome = !!home && num(home.lat) && num(home.lng) && distM(start, home) <= HOME_NEAR_M;
  let toward = null;
  if (motion.state === "moving_lost" && num(motion.bearingDeg)) {
    const hit = (Array.isArray(places) ? places : [])
      .filter((p) => num(p?.lat) && num(p?.lng) && typeof p?.name === "string" && p.name.trim())
      .map((p) => ({ name: p.name.trim(), d: distM(end, p), a: angleDiff(bearing(end, p), motion.bearingDeg) }))
      .filter((p) => p.d <= TOWARD_MAX_M && p.a <= TOWARD_DEG)
      .sort((a, b) => a.a - b.a || a.d - b.d)[0];
    toward = hit?.name ?? null;
  }
  return { start, mid, end, motion, startNearHome, toward };
}

/** "오후 3시 4분" */
export function koTime(ms) {
  const d = new Date(ms), h = d.getHours(), m = d.getMinutes();
  return `${h < 12 ? "오전" : "오후"} ${h % 12 === 0 ? 12 : h % 12}시${m ? ` ${m}분` : ""}`;
}

/** 역지오코딩 결과 → "부사동 보문로47번길" 처럼 동·길까지 (시·구와 번지는 뺌) */
export function shortPlace(g) {
  if (!g || typeof g !== "object") return null;
  const dong = typeof g.label === "string" ? g.label.trim().split(/\s+/).pop() : "";
  const road = typeof g.road === "string" ? g.road.trim().split(/\s+/).filter((w) => !/(시|도|구|군)$/.test(w) && !/^\d[\d-]*$/.test(w)).join(" ") : "";
  const s = [dong, road].filter(Boolean).join(" ").trim();
  return s || null;
}

/**
 * 보호자가 고쳐 쓸 문장. labels = { start, mid, end } (shortPlace 결과, 없으면 null)
 * 예) "GPS 기록으로는 오늘 오후 3시 4분쯤 집 근처에서 걷기 시작해 부사동 보문로 쪽을 지나 북동쪽(믿음건강원 쪽)으로 가고 계셨어요.
 *      오후 3시 12분 부사동 보문로47번길 근처에서 목걸이 GPS가 끊겼어요."
 */
export function storyText(sp, labels = {}) {
  if (!sp) return "";
  const { start, end, motion, startNearHome, toward } = sp;
  const from = startNearHome ? "집 근처" : labels.start || "어느 곳";
  const via = labels.mid && labels.mid !== labels.end && labels.mid !== labels.start ? `${labels.mid} 쪽을 지나 ` : "";
  const at = labels.end ? `${labels.end} 근처` : "마지막 위치";
  if (motion.state === "moving_lost") {
    const dir = direction8(motion.bearingDeg);
    const kmh = num(motion.speedMps) ? Math.round(motion.speedMps * 3.6) : null;
    return `GPS 기록으로는 오늘 ${koTime(start.t)}쯤 ${from}에서 걷기 시작해 ${via}${dir ? `${dir}쪽` : "어느 쪽"}${toward ? `(${toward} 쪽)` : ""}으로 가고 계셨어요. ` +
      `${koTime(end.t)} ${at}에서${kmh ? ` 시속 약 ${kmh}km로 걷던 중` : ""} 목걸이 GPS가 끊겼어요. `;
  }
  return `GPS 기록으로는 오늘 ${koTime(start.t)}쯤 ${from}에서 나가 ${via}${at}에 머무신 뒤, ${koTime(end.t)}부터 목걸이 GPS 기록이 더 오지 않아요. `;
}
