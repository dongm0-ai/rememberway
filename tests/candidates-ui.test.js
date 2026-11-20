// 📍 예상 후보지 카드(public/js/candidates.js)의 순수 부분 + 지도 겹그림(public/js/map.js drawPrediction)
import test from "node:test";
import assert from "node:assert/strict";
import { liveLine, refreshHeadline, addressLike, LIVE_MS, pointsToday, parseDirection, motionFromClue, buildPlaces, toAICandidate, forAI, codeReason, mergeRanked, headline, computeCandidates, sourceBadge, safeEvidence, hhmm, MAX_AI } from "../public/js/candidates.js";
import { drawPrediction, candPinHtml } from "../public/js/map.js";
import { fmtDist } from "../public/lib/verify.js";

const HOME = { lat: 36.31, lng: 127.43 };
const off = (p, dx, dy) => ({ lat: p.lat + dy / 111000, lng: p.lng + dx / (111000 * Math.cos((p.lat * Math.PI) / 180)) });
const MIN = 60000;
// 오늘 정오 기준 고정 시각 (날짜 경계에 걸리지 않게)
const NOON = (() => { const d = new Date(); d.setHours(12, 0, 0, 0); return d.getTime(); })();

// 북동쪽으로 10초마다 걷다가 끊긴 기록 (/api/loc latest 모양, 새것부터)
function neTrack(endMs, n = 30) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = endMs - (n - 1 - i) * 10000, d = i * 9;   // 0.9 m/s
    const p = off(HOME, d * Math.SQRT1_2, d * Math.SQRT1_2);
    out.push({ lat: p.lat, lng: p.lng, gps_time: new Date(t).toISOString(), received_at: new Date(t + 2000).toISOString(), speed_kmh: 3.2 });
  }
  return out.reverse();
}

test("pointsToday: 오늘 점만, t·좌표로 바꾼다", () => {
  const pts = [...neTrack(NOON - 40 * MIN, 3), { lat: 36.3, lng: 127.4, gps_time: new Date(NOON - 86400000).toISOString() }, { lat: 0, lng: 0, gps_time: new Date(NOON).toISOString() }];
  const out = pointsToday(pts, NOON);
  assert.equal(out.length, 3);
  assert.ok(out.every((p) => typeof p.t === "number" && p.speed_kmh === 3.2));
  assert.deepEqual(pointsToday(null, NOON), []);
});

test("parseDirection: 방향 말만", () => {
  assert.equal(parseDirection("북동쪽"), 45);
  assert.equal(parseDirection("남서 방향"), 225);
  assert.equal(parseDirection("서"), 270);
  assert.equal(parseDirection("석교동"), null);
  assert.equal(parseDirection(null), null);
});

test("motionFromClue: 방향 → moving_lost, 목적지 → 그 쪽, 둘 다 없으면 none", () => {
  const mode = { elapsedMin: 40, gait: "normal", started_at: new Date(NOON).toISOString() };
  const a = motionFromClue({ direction: "동쪽" }, mode, HOME, NOON);
  assert.equal(a.state, "moving_lost"); assert.equal(a.bearingDeg, 90); assert.equal(a.t, NOON - 40 * MIN); assert.equal(a.fromClue, true); assert.equal(a.dirFrom, "direction");
  const b = motionFromClue({ today_destination: "시장" }, mode, HOME, NOON, off(HOME, 0, -800));
  assert.equal(b.state, "moving_lost"); assert.ok(Math.abs(b.bearingDeg - 180) < 1); assert.equal(b.dirFrom, "destination");
  const c = motionFromClue({}, mode, HOME, NOON);
  assert.equal(c.state, "none"); assert.equal(c.lat, HOME.lat);
  assert.equal(motionFromClue({}, mode, null, NOON), null);
});

test("buildPlaces: 집 근처·집 이름·중복 이름·같은 자리는 빼고, id 는 공백 없이 40자 이하", () => {
  const places = buildPlaces({
    home: HOME,
    memory: [{ name: "집", source: "memory", ...off(HOME, 900, 0) }, { name: "옛 직장", source: "memory", evidence: "30년 다니신 곳", ...off(HOME, 800, 800) },
      { name: "옛 직장", source: "memory", ...off(HOME, 0, 900) }, { name: "집앞 벤치", source: "guardian", ...off(HOME, 20, 20) }, { name: "좌표없음", source: "memory" },
      { name: "경로당", source: "rising", evidence: "대전 중구 대종로 123-4", ...off(HOME, -500, 0) }],
    frequent: [{ lat: off(HOME, 800, 810).lat, lng: off(HOME, 800, 810).lng, days: ["a", "b"] }, { ...off(HOME, 0, -700), days: ["a", "b", "c"], hour_band: "오후 3시쯤" }, { ...off(HOME, 5, 5), home: true }],
    basic: [{ kindOf: "공원", found_name: "석교공원", ...off(HOME, 1500, 1500) }],
  });
  assert.deepEqual(places.map((p) => p.name), ["옛 직장", "경로당", "자주 머문 곳 1", "공원: 석교공원"]);
  assert.equal(places.find((p) => p.name === "경로당").source, "frequent");
  assert.equal(places.find((p) => p.name === "경로당").evidence, null);   // 주소처럼 보이는 근거는 보내지 않는다
  assert.match(places.find((p) => p.name === "자주 머문 곳 1").evidence, /3일/);
  for (const p of places) assert.ok(/^\S{1,40}$/.test(p.id), p.id);
  assert.equal(new Set(places.map((p) => p.id)).size, places.length);
});

test("safeEvidence: 주소·좌표 모양은 null", () => {
  assert.equal(safeEvidence("대종로 12번길 3"), null);
  assert.equal(safeEvidence("36.31234, 127.4321"), null);
  assert.equal(safeEvidence("젊을 때 자주 가시던 시장"), "젊을 때 자주 가시던 시장");
});

test("toAICandidate: 좌표 없음 / forAI: 최대 15개", () => {
  const f = { id: "m1", name: "옛 직장", source: "memory", evidence: "e", lat: 1, lng: 2, dist_m: 1200, bearing_diff_deg: 5, reachable: true, path_dist_m: 40 };
  const c = toAICandidate(f);
  assert.ok(!("lat" in c) && !("lng" in c));
  assert.deepEqual(Object.keys(c).sort(), ["bearing_diff_deg", "dist_m", "evidence", "id", "name", "path_dist_m", "reachable", "source"]);
  const many = Array.from({ length: 20 }, (_, i) => ({ ...f, id: `x${i}`, dist_m: 100 * i, path_dist_m: 100 * i }));
  assert.equal(forAI(many).length, MAX_AI);
  assert.equal(forAI(many)[0].id, "x0");
});

const F = [
  { id: "a", name: "A", source: "basic", dist_m: 300, bearing_diff_deg: 170, reachable: true, path_dist_m: 600, lat: 1, lng: 1 },
  { id: "b", name: "B", source: "memory", dist_m: 1200, bearing_diff_deg: 3, reachable: true, path_dist_m: 40, lat: 1, lng: 1 },
  { id: "c", name: "C", source: "frequent", dist_m: 5000, bearing_diff_deg: 90, reachable: false, path_dist_m: 3000, lat: 1, lng: 1 },
  { id: "d", name: "D", source: "basic", dist_m: 900, bearing_diff_deg: 20, reachable: true, path_dist_m: 150, lat: 1, lng: 1 },
];
const MOVING = { state: "moving_lost", lat: 1, lng: 1, t: NOON - 40 * MIN, speedMps: 0.9, bearingDeg: 45 };

test("codeReason: 가던 방향·거리(fmtDist)·닿을 수 있는지", () => {
  assert.equal(codeReason(F[1], MOVING), `가던 방향 ${fmtDist(1200)}, 예상 경로 바로 옆, 지금 걸어서 닿을 수 있음`);
  assert.equal(codeReason(F[1], MOVING).startsWith("가던 방향 1.2km"), true);
  assert.match(codeReason(F[2], MOVING), /옆쪽 5km, 걸어서 닿기엔 아직 멂$/);
  assert.equal(codeReason({ ...F[0], bearing_diff_deg: null, path_dist_m: null }, { state: "stayed" }), "마지막 위치에서 300m, 지금 걸어서 닿을 수 있음");
  assert.equal(codeReason({ ...F[0], bearing_diff_deg: null, path_dist_m: null }, { state: "none", fromClue: true }), "집에서 300m, 지금 걸어서 닿을 수 있음");
});

test("mergeRanked: AI 순서 먼저, 목록 밖·중복 버림, 모자라면 코드 순서로 채움", () => {
  const out = mergeRanked([{ id: "c", reason: "AI 이유", warn: true }, { id: "zz", reason: "x" }, { id: "c", reason: "again" }], F, MOVING);
  assert.deepEqual(out.map((c) => c.id), ["c", "b", "d"]);
  assert.deepEqual(out.map((c) => c.by), ["ai", "code", "code"]);
  assert.equal(out[0].warn, true); assert.equal(out[0].reason, "AI 이유");
  assert.equal(out[1].reason, codeReason(F[1], MOVING));
  const none = mergeRanked([], F, MOVING);
  assert.deepEqual(none.map((c) => c.id), ["b", "d", "a"]);
  assert.ok(none.every((c) => c.by === "code" && c.warn === false));
  assert.equal(mergeRanked(null, F.slice(0, 2), MOVING).length, 2);
  assert.equal(mergeRanked([{ id: "a", reason: "1" }, { id: "b", reason: "2" }, { id: "c", reason: "3" }, { id: "d", reason: "4" }], F, MOVING).length, 3);
});

test("headline: 상태별 부제", () => {
  const t = NOON - 40 * MIN;
  assert.equal(headline(MOVING, NOON), `${hhmm(t)} 북동쪽 시속 3km 이후 끊김, 40분 지남`);
  assert.equal(headline({ state: "stayed", lat: 1, lng: 1, t: NOON - 75 * MIN }, NOON), `${hhmm(NOON - 75 * MIN)}부터 그 자리에 머무시는 중일 수 있어요 (1시간 15분 지남) · 마지막 위치에서 가까운 순`);
  assert.match(headline({ ...MOVING, fromClue: true, dirFrom: "direction", bearingDeg: 90 }, NOON), /^보호자 말: .*집에서 나가심, 동쪽으로 걸으셨다고 보고 계산, 40분 지남$/);
  assert.match(headline({ state: "none", lat: 1, lng: 1, t, fromClue: true }, NOON), /방향을 몰라 집에서 가까운 순$/);
});

test("sourceBadge", () => {
  assert.equal(sourceBadge("memory"), "추억의 장소");
  assert.equal(sourceBadge("frequent"), "자주 머문 곳");
  assert.equal(sourceBadge("basic"), "기본 장소");
});

// ---------------------------------------------------------------- 전체 흐름 (가짜 검색·서버)
function deps(over = {}) {
  const sent = [];
  const memoryNE = off(HOME, 1100, 1100);   // 가던 방향(북동) 위 추억의 장소
  return {
    sent,
    d: {
      points: pointsToday(neTrack(NOON - 40 * MIN), NOON), nowMs: NOON, home: HOME, elderId: "e1",
      profile: { honorific: "아버지", places: [{ name: "옛 직장", source: "memory", evidence: "30년 다니신 곳" }, { name: "남쪽 시장", source: "memory" }] },
      clue: null, mode: null,
      findPlaceLoose: async (name) => (name === "옛 직장" ? { ...memoryNE } : name === "남쪽 시장" ? off(HOME, 0, -900) : null),
      findNearby: async (kind, near) => (kind === "공원" ? [{ found_name: "작은공원", ...off(near, 50, 0) }] : []),
      authFetch: async (b) => (b.action === "places" ? { ok: true, places: [{ ...off(HOME, -800, 0), days: ["1", "2", "3"] }, { ...HOME, days: ["1"], home: false }] } : { ok: false }),
      api: async (name, body) => { sent.push({ name, body }); return { ok: false, reason: "TIMEOUT" }; },
      ...over,
    },
  };
}

test("computeCandidates: AI 실패 → 코드 순서 3곳, 1번은 가던 방향의 추억의 장소, 좌표·주소는 AI에 안 감", async () => {
  const { d, sent } = deps();
  const r = await computeCandidates(d);
  assert.equal(r.status, "ok");
  assert.equal(r.motion.state, "moving_lost");
  assert.equal(r.top.length, 3);
  assert.equal(r.top[0].name, "옛 직장");
  assert.ok(r.top.every((c) => c.by === "code"));
  assert.equal(r.ai, false); assert.equal(r.aiReason, "TIMEOUT");
  assert.ok(r.path.length > 0 && r.reach > 0);
  assert.equal(sent.length, 1);
  const body = sent[0].body;
  assert.equal(body.mode, "candidates");
  assert.deepEqual(Object.keys(body.motion).sort(), ["direction_8", "minutes_since", "speed_kmh", "state"]);
  assert.equal(body.motion.direction_8, "북동");
  assert.ok(body.candidates.length >= 1 && body.candidates.length <= 15);
  const json = JSON.stringify(body);
  assert.ok(!/"lat"|"lng"/.test(json), json);
  assert.ok(!json.includes(String(HOME.lat)) && !json.includes("36.3"), json);
  assert.ok(!body.candidates.some((c) => c.dist_m < 100), "집은 후보가 아니다");
});

test("computeCandidates: AI가 1곳만 → 나머지 코드 순서로 채움, warn 유지", async () => {
  const { d } = deps({ api: async (n, b) => ({ ok: true, mock: true, ranked: [{ id: b.candidates[b.candidates.length - 1].id, reason: "AI가 고른 이유", warn: true }] }) });
  const r = await computeCandidates(d);
  assert.equal(r.top.length, 3);
  assert.equal(r.top[0].by, "ai"); assert.equal(r.top[0].warn, true);
  assert.deepEqual(r.top.slice(1).map((c) => c.by), ["code", "code"]);
  assert.equal(new Set(r.top.map((c) => c.id)).size, 3);
  assert.equal(r.ai, true); assert.equal(r.mock, true);
});

test("computeCandidates: GPS 없음 → 단서(방향)로 같은 흐름, 둘 다 없으면 nodata", async () => {
  const mode = { elapsedMin: 45, gait: "normal", started_at: new Date(NOON).toISOString() };
  const { d } = deps({ points: [], clue: { direction: "북동쪽", memory_places: [] }, mode });
  const r = await computeCandidates(d);
  assert.equal(r.status, "ok"); assert.equal(r.motion.fromClue, true); assert.equal(r.motion.state, "moving_lost");
  assert.equal(r.top[0].name, "옛 직장");
  const none = await computeCandidates({ ...d, clue: null });
  assert.equal(none.status, "nodata");
  const noHome = await computeCandidates({ ...d, home: null });
  assert.equal(noHome.status, "nodata");
});

test("computeCandidates: 머묾 → 마지막 위치 기준 가까운 순", async () => {
  const p = off(HOME, 400, 400);
  const pts = [{ t: NOON - 50 * MIN, ...p, speed_kmh: 0 }];
  const { d } = deps({ points: pts });
  const r = await computeCandidates(d);
  assert.equal(r.motion.state, "stayed");
  assert.deepEqual(r.path, []);
  const dists = r.top.map((c) => c.dist_m);
  assert.deepEqual(dists, [...dists].sort((a, b) => a - b));
});

// ---------------------------------------------------------------- 지도 겹그림 (가짜 naver.maps)
function fakeNaver() {
  const made = [];
  class Obj { constructor(o) { this.o = o; this.map = o?.map ?? null; made.push(this); } setMap(m) { this.map = m; } }
  const maps = {
    LatLng: class { constructor(lat, lng) { this.lat = lat; this.lng = lng; } },
    Point: class { constructor(x, y) { this.x = x; this.y = y; } },
    LatLngBounds: class { constructor(a) { this.pts = [a]; } extend(p) { this.pts.push(p); } },
    Circle: class extends Obj { kind = "circle"; }, Polyline: class extends Obj { kind = "line"; }, Marker: class extends Obj { kind = "marker"; },
  };
  const map = { fitted: null, fitBounds(b) { this.fitted = b; } };
  return { naver: { maps }, map, made };
}

test("drawPrediction: 점선 경로(마지막 위치부터)·원·번호 핀, clear 로 지움", () => {
  const { naver, map, made } = fakeNaver();
  const from = { lat: 36.31, lng: 127.43 };
  const h = drawPrediction(naver, map, { from, path: [{ lat: 36.32, lng: 127.44 }, { lat: 36.33, lng: 127.45 }], reachM: 1500, pins: [{ name: "A", lat: 36.32, lng: 127.43 }, { name: "B", lat: 36.3, lng: 127.4 }], fit: true });
  const line = made.find((o) => o.kind === "line"), circle = made.find((o) => o.kind === "circle"), pins = made.filter((o) => o.kind === "marker");
  assert.equal(line.o.strokeStyle, "shortdash");
  assert.equal(line.o.path.length, 3); assert.equal(line.o.path[0].lat, from.lat);
  assert.equal(circle.o.radius, 1500); assert.equal(circle.o.center.lat, from.lat);
  assert.equal(pins.length, 2); assert.match(pins[0].o.icon.content, />1<\/div>$/); assert.match(pins[1].o.icon.content, />2<\/div>$/);
  assert.ok(map.fitted);
  h.clear();
  assert.ok(made.every((o) => o.map === null));
  assert.doesNotThrow(() => drawPrediction(null, map, { from }).clear());
});

test("candPinHtml: 이름 이스케이프", () => {
  const h = candPinHtml("1", `x"><img src=x onerror=alert(1)>`);
  assert.ok(!h.includes("<img"));
  assert.equal((h.match(/</g) || []).length, 2);
});

// ---------------------------------------------------------------- 고침 1회차: 이동 중(live)·AI 순서 기억·주소 같은 이름·부제만 갱신
test("computeCandidates: 아직 움직이는 중(마지막 위치 20초 전) → live, AI·검색 없음", async () => {
  let nearby = 0;
  const { d, sent } = deps({ points: pointsToday(neTrack(NOON - 20000), NOON), findNearby: async () => { nearby++; return []; } });
  const r = await computeCandidates(d);
  assert.equal(r.status, "live");
  assert.equal(sent.length, 0); assert.equal(nearby, 0);
  assert.ok(!("path" in r) && !("top" in r));
  assert.equal(liveLine(r.motion, NOON), "지금 북동쪽으로 시속 3km로 이동 중이세요 (마지막 위치 20초 전). 위치가 끊기면 예상 후보지를 계산해요.");
  // 2분 30초가 넘으면 끊김으로 본다
  const lost = await computeCandidates({ ...d, points: pointsToday(neTrack(NOON - LIVE_MS - 1000), NOON) });
  assert.equal(lost.status, "ok"); assert.equal(sent.length, 1);
});

test("computeCandidates: 시간만 지난 재계산은 AI 순서를 다시 쓰고, 후보 묶음이 바뀌면 다시 묻는다", async () => {
  const stay = [{ t: NOON - 30 * MIN, ...off(HOME, 400, 400), speed_kmh: 0 }];
  const aiCache = new Map();
  const { d, sent } = deps({ points: stay, aiCache, api: async (name, body) => { sent.push(body); return { ok: true, ranked: [{ id: body.candidates[0].id, reason: "AI 이유" }] }; } });
  const r1 = await computeCandidates(d);
  const r2 = await computeCandidates({ ...d, nowMs: NOON + 5 * MIN });
  const r3 = await computeCandidates({ ...d, nowMs: NOON + 10 * MIN });
  assert.equal(sent.length, 1);
  assert.equal(r2.top[0].reason, "AI 이유"); assert.equal(r3.top[0].by, "ai");
  assert.match(headline(r3.motion, NOON + 10 * MIN), /40분 지남/);
  await computeCandidates({ ...d, nowMs: NOON + 15 * MIN, findNearby: async (kind, near) => (kind === "편의점" ? [{ found_name: "새 편의점", ...off(near, 0, 300) }] : []) });
  assert.equal(sent.length, 2);   // 후보 묶음이 바뀜
  await computeCandidates({ ...d, points: [{ ...stay[0], t: NOON - 20 * MIN }] });
  assert.equal(sent.length, 3);   // 마지막 위치가 바뀜
  // 실패한 답은 기억하지 않는다
  const failCache = new Map(); let calls = 0;
  const f = deps({ points: stay, aiCache: failCache, api: async () => { calls++; return { ok: false, reason: "TIMEOUT" }; } }).d;
  await computeCandidates(f); await computeCandidates(f);
  assert.equal(calls, 2);
});

test("toAICandidate: 주소·좌표처럼 보이는 이름은 출처 이름 + 번호로", () => {
  assert.equal(addressLike("대종로 12번길 3"), true);
  assert.equal(addressLike("옛 직장"), false);
  const c = toAICandidate({ id: "m2", name: "대전 중구 대종로 123-4", source: "memory", dist_m: 1, bearing_diff_deg: null, reachable: true, path_dist_m: null });
  assert.equal(c.name, "추억의 장소 2");
  assert.equal(toAICandidate({ id: "m1", name: "36.3101, 127.4302", source: "guardian", dist_m: 1, bearing_diff_deg: null, reachable: true, path_dist_m: null }).name, "보호자가 말한 곳 1");
  assert.equal(toAICandidate({ id: "m1", name: "옛 직장", source: "memory", dist_m: 1, bearing_diff_deg: null, reachable: true, path_dist_m: null }).name, "옛 직장");
});

test("refreshHeadline: 부제만 새 시각으로 (네트워크 없음)", () => {
  const p = { textContent: "old" }, box = { querySelector: (sel) => (sel === ".cand-sub" ? p : null) };
  assert.equal(refreshHeadline(box, { status: "ok", motion: MOVING }, NOON + 5 * MIN), true);
  assert.match(p.textContent, /45분 지남$/);
  refreshHeadline(box, { status: "live", motion: { ...MOVING, t: NOON - 30000 } }, NOON);
  assert.match(p.textContent, /마지막 위치 30초 전/);
  assert.equal(refreshHeadline({ querySelector: () => null }, { status: "ok", motion: MOVING }, NOON), false);
});

test("mergeRanked: 이름표가 섞여 서버가 비운 이유(leak) → AI 순서는 두고 이유는 코드 문장", () => {
  const out = mergeRanked([{ id: "c", reason: "", leak: true }], F, MOVING);
  assert.equal(out[0].id, "c");
  assert.equal(out[0].by, "ai");
  assert.equal(out[0].reason, codeReason(F.find((f) => f.id === "c"), MOVING));
});
