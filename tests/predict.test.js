import test from "node:test";
import assert from "node:assert/strict";
import { distM } from "../public/lib/gps.js";
import { WALK_SPEED } from "../public/lib/schema.js";
import { lastMotion, projectPath, reachM, candidateFeatures, fallbackOrder } from "../public/lib/predict.js";

const MIN = 60000;
const T0 = Date.UTC(2026, 10, 17, 5, 0, 0);          // 14:00 KST
const LAT = 36.6, LNG = 127.4;
const M_LAT = 1 / 111195;                              // 위도 1m ≈ 이 각도(°)
const M_LNG = M_LAT / Math.cos((LAT * Math.PI) / 180);  // 경도 1m ≈ 이 각도(°)

/** 점 n개, 10초 간격, 위도 +0.00009°씩(≈10m) = 북쪽으로 1m/s */
const northPoints = (n = 6, extra = {}) => Array.from({ length: n }, (_, i) => ({ t: T0 + i * 10000, lat: LAT + 0.00009 * i, lng: LNG, ...extra }));
const north = () => lastMotion(northPoints());

test("no points → none", () => assert.equal(lastMotion([]).state, "none"));
test("non-array / junk points → none", () => {
  assert.equal(lastMotion(undefined).state, "none");
  assert.equal(lastMotion([{ t: "x", lat: 1, lng: 1 }, { t: 1, lat: NaN, lng: 1 }, null]).state, "none");
});

test("single point → stayed, finite coords", () => {
  const m = lastMotion([{ t: 0, lat: 36.6, lng: 127.4 }]);
  assert.equal(m.state, "stayed");
  assert.ok(Number.isFinite(m.lat));
  assert.ok(Number.isFinite(m.lng));
  assert.equal(m.t, 0);
});

test("last speed 0.5km/h → stayed", () => {
  const pts = northPoints();
  pts[pts.length - 1].speed_kmh = 0.5;
  const m = lastMotion(pts);
  assert.equal(m.state, "stayed");
  assert.equal(m.lat, pts[5].lat);
  assert.equal(m.t, pts[5].t);
});

test("last speed exactly 1km/h is not a stay by speed rule", () => {
  assert.equal(lastMotion(northPoints(6, { speed_kmh: 1 })).state, "moving_lost");
});

test("last two points within 30m and 3+ min apart → stayed", () => {
  const m = lastMotion([{ t: T0, lat: LAT, lng: LNG }, { t: T0 + 3 * MIN, lat: LAT + 20 * M_LAT, lng: LNG }]);
  assert.equal(m.state, "stayed");
  assert.equal(m.t, T0 + 3 * MIN);
});

test("last two points within 30m but under 3 min apart → still moving", () => {
  const m = lastMotion([{ t: T0, lat: LAT, lng: LNG }, { t: T0 + 2 * MIN, lat: LAT + 20 * M_LAT, lng: LNG }]);
  assert.equal(m.state, "moving_lost");
});

test("moving north 1m/s → bearing ≈ 0, speed ≈ 1", () => {
  const m = north();
  assert.equal(m.state, "moving_lost");
  assert.ok(Math.abs(m.speedMps - 1) < 0.05, `speed ${m.speedMps}`);
  const b = m.bearingDeg > 180 ? m.bearingDeg - 360 : m.bearingDeg;
  assert.ok(Math.abs(b) < 1, `bearing ${m.bearingDeg}`);
  assert.equal(m.t, T0 + 50000);
  assert.equal(m.lat, LAT + 0.00009 * 5);
  assert.equal(m.lng, LNG);
});

test("point order does not matter", () => {
  const shuffled = [3, 0, 5, 1, 4, 2].map((i) => northPoints()[i]);
  assert.deepEqual(lastMotion(shuffled), north());
});

test("point speed_kmh (median) wins over distance/time", () => {
  const pts = northPoints().map((p, i) => ({ ...p, speed_kmh: [7.2, 7.2, 7.2, 3.6, 3.6, 3.6][i] }));  // 중앙값 (3.6+7.2)/2 = 5.4km/h = 1.5m/s
  const m = lastMotion(pts);
  assert.equal(m.state, "moving_lost");
  assert.ok(Math.abs(m.speedMps - 1.5) < 1e-9, `speed ${m.speedMps}`);
});

test("moving east → bearing ≈ 90, west → ≈ 270", () => {
  const dir = (s) => lastMotion(Array.from({ length: 6 }, (_, i) => ({ t: T0 + i * 10000, lat: LAT, lng: LNG + s * 10 * M_LNG * i }))).bearingDeg;
  assert.ok(Math.abs(dir(1) - 90) < 0.5, `east ${dir(1)}`);
  assert.ok(Math.abs(dir(-1) - 270) < 0.5, `west ${dir(-1)}`);
});

test("only the latest 6 points within 10 min of the last point are used", () => {
  const old = Array.from({ length: 4 }, (_, i) => ({ t: T0 - 30 * MIN + i * 10000, lat: LAT - 0.1, lng: LNG - 0.1 }));   // 30분 전, 멀리, 남서쪽
  const recent = northPoints().map((p) => ({ ...p, t: p.t + 20 * MIN }));
  const m = lastMotion([...old, ...recent]);
  assert.equal(m.state, "moving_lost");
  assert.ok(Math.abs(m.speedMps - 1) < 0.05);
  assert.ok(m.bearingDeg < 1 || m.bearingDeg > 359);
  // 6점 제한: 7번째로 오래된 점(방향이 다름)은 쓰지 않는다
  const seven = [{ t: T0 - 10000, lat: LAT, lng: LNG - 50 * M_LNG }, ...northPoints()];
  const m7 = lastMotion(seven);
  assert.ok(m7.bearingDeg < 1 || m7.bearingDeg > 359, `bearing ${m7.bearingDeg}`);
});

test("only one point within 10 min of the last → stayed (coords only)", () => {
  const m = lastMotion([{ t: T0, lat: LAT, lng: LNG }, { t: T0 + 15 * MIN, lat: LAT + 0.01, lng: LNG }]);
  assert.equal(m.state, "stayed");
  assert.equal(m.lat, LAT + 0.01);
  assert.equal(m.t, T0 + 15 * MIN);
});

test("no movement across window (same coords, no speeds) → stayed", () => {
  const pts = Array.from({ length: 4 }, (_, i) => ({ t: T0 + i * 10000, lat: LAT, lng: LNG }));
  assert.equal(lastMotion(pts).state, "stayed");
});

test("stayed result carries only coords and time", () => {
  const m = lastMotion([{ t: 5, lat: LAT, lng: LNG }]);
  assert.deepEqual(Object.keys(m).sort(), ["lat", "lng", "state", "t"]);
});

test("projectPath 30min at 1m/s north ends ≈1800m away", () => {
  const m = north();
  const path = projectPath(m, m.t + 30 * MIN);
  assert.equal(path.length, 3);
  assert.deepEqual(path.map((p) => p.t), [m.t + 10 * MIN, m.t + 20 * MIN, m.t + 30 * MIN]);
  const end = path[path.length - 1];
  assert.ok(Math.abs(distM(m, end) - m.speedMps * 1800) < 1, `end ${distM(m, end)}`);
  assert.ok(Math.abs(distM(m, end) - 1800) < 5);
  assert.ok(end.lat > m.lat);
  assert.ok(Math.abs(end.lng - m.lng) * 111000 < 5, "straight north");
});

test("projectPath follows the bearing (east)", () => {
  const motion = { state: "moving_lost", lat: LAT, lng: LNG, t: T0, speedMps: 1, bearingDeg: 90 };
  const end = projectPath(motion, T0 + 20 * MIN).at(-1);
  assert.ok(Math.abs(distM(motion, end) - 1200) < 1);
  assert.ok(end.lng > LNG && Math.abs(end.lat - LAT) * 111000 < 5);
});

test("projectPath honours stepMin and ends at nowMs when it is not on a step", () => {
  const m = north();
  const path = projectPath(m, m.t + 25 * MIN, 5);
  assert.deepEqual(path.map((p) => p.t), [1, 2, 3, 4, 5].map((k) => m.t + k * 5 * MIN));
  const odd = projectPath(m, m.t + 25 * MIN);                       // 10분 단계: 10·20분 + 끝점 25분
  assert.deepEqual(odd.map((p) => p.t), [m.t + 10 * MIN, m.t + 20 * MIN, m.t + 25 * MIN]);
  assert.ok(Math.abs(distM(m, odd.at(-1)) - m.speedMps * 1500) < 1);
  const short = projectPath(m, m.t + 4 * MIN);                      // 한 단계도 안 지났어도 지금 위치 한 점
  assert.deepEqual(short.map((p) => p.t), [m.t + 4 * MIN]);
});

test("projectPath for stayed / none → []", () => {
  assert.deepEqual(projectPath(lastMotion([{ t: T0, lat: LAT, lng: LNG }]), T0 + 60 * MIN), []);
  assert.deepEqual(projectPath(lastMotion([]), T0 + 60 * MIN), []);
  assert.deepEqual(projectPath(undefined, T0), []);
});

test("projectPath edge cases → []", () => {
  const m = north();
  assert.deepEqual(projectPath(m, m.t), []);
  assert.deepEqual(projectPath(m, m.t - MIN), []);
  assert.deepEqual(projectPath(m, NaN), []);
  assert.deepEqual(projectPath(m, m.t + 30 * MIN, 0), []);
  assert.deepEqual(projectPath(m, m.t + 30 * MIN, -5), []);
  assert.deepEqual(projectPath({ ...m, bearingDeg: undefined }, m.t + 30 * MIN), []);
  assert.deepEqual(projectPath({ ...m, speedMps: 0 }, m.t + 30 * MIN), []);
});

test("projectPath is bounded when nowMs is absurdly far", () => {
  const m = north();
  const path = projectPath(m, m.t + 365 * 24 * 60 * MIN);
  assert.ok(path.length > 0 && path.length <= 1000);
});

test("reachM = elapsed seconds × walking speed", () => {
  const m = lastMotion([{ t: T0, lat: LAT, lng: LNG }]);
  assert.equal(reachM(m, T0 + 10 * MIN), 600 * WALK_SPEED.normal);
  assert.equal(reachM(m, T0 + 10 * MIN, WALK_SPEED.fast), 600 * WALK_SPEED.fast);
  assert.equal(reachM(m, T0 + 10 * MIN, 2), 1200);
});

test("reachM never negative or NaN", () => {
  const m = lastMotion([{ t: T0, lat: LAT, lng: LNG }]);
  assert.equal(reachM(m, T0 - 5 * MIN), 0);
  assert.equal(reachM(m, T0), 0);
  assert.equal(reachM(lastMotion([]), T0), 0);
  assert.equal(reachM(m, NaN), 0);
  assert.equal(reachM(undefined, T0), 0);
});

const ahead = (m, meters) => ({ lat: m.lat + meters * M_LAT, lng: m.lng });

test("candidateFeatures: place ahead has bearing_diff < 10, place behind > 170", () => {
  const m = north(), now = m.t + 10 * MIN;
  const f = candidateFeatures(m, now, [
    { id: "a", name: "앞", ...ahead(m, 500), source: "memory" },
    { id: "b", name: "뒤", ...ahead(m, -500), source: "memory" },
    { id: "c", name: "옆", lat: m.lat, lng: m.lng + 500 * M_LNG, source: "places" },
  ]);
  const by = Object.fromEntries(f.map((x) => [x.id, x]));
  assert.ok(by.a.bearing_diff_deg < 10, `ahead ${by.a.bearing_diff_deg}`);
  assert.ok(by.b.bearing_diff_deg > 170, `behind ${by.b.bearing_diff_deg}`);
  assert.ok(Math.abs(by.c.bearing_diff_deg - 90) < 5, `side ${by.c.bearing_diff_deg}`);
});

test("candidateFeatures: shape, integer rounding, original fields kept", () => {
  const m = north(), now = m.t + 10 * MIN;                        // 지금까지 걸어서 480m, 예상 경로 600m 앞
  const place = { id: "p1", name: "시장", ...ahead(m, 400), source: "memory", evidence: "자주 가던 시장" };
  const [f] = candidateFeatures(m, now, [place]);
  for (const k of ["id", "name", "lat", "lng", "source", "evidence"]) assert.equal(f[k], place[k]);
  for (const k of ["dist_m", "bearing_diff_deg", "path_dist_m"]) assert.ok(Number.isInteger(f[k]), `${k} ${f[k]}`);
  assert.ok(Math.abs(f.dist_m - 400) <= 1);
  assert.equal(f.reachable, true);                                 // 400 ≤ 480
  assert.ok(Math.abs(f.path_dist_m - Math.round(Math.abs(600 * m.speedMps - 400))) <= 2, `path ${f.path_dist_m}`);
  assert.equal(Object.keys(place).includes("dist_m"), false, "input not mutated");
});

test("candidateFeatures: reachable uses walking speed × elapsed", () => {
  const m = north();
  const places = [{ id: "near", ...ahead(m, 470), source: "memory" }, { id: "far", ...ahead(m, 490), source: "memory" }];
  const f = candidateFeatures(m, m.t + 10 * MIN, places);           // 도달 반경 600초 × 0.8 = 480m
  assert.deepEqual(f.map((x) => x.reachable), [true, false]);
});

test("candidateFeatures: path_dist_m is distance to the nearest projected point", () => {
  const m = north();
  const path = projectPath(m, m.t + 30 * MIN);
  const place = { id: "x", lat: path[1].lat, lng: path[1].lng + 100 * M_LNG, source: "memory" };   // 20분 지점에서 동쪽 100m
  const [f] = candidateFeatures(m, m.t + 30 * MIN, [place]);
  assert.ok(Math.abs(f.path_dist_m - 100) <= 1, `path ${f.path_dist_m}`);
});

test("candidateFeatures skips places without coords", () => {
  const m = north();
  const f = candidateFeatures(m, m.t + 10 * MIN, [
    { id: "ok", lat: 36.61, lng: 127.41, source: "memory" },
    { id: "nolat", lng: 127.41, source: "memory" },
    { id: "null", lat: null, lng: null, source: "memory" },
    { id: "nan", lat: NaN, lng: 127.4, source: "memory" },
    { id: "str", lat: "36.61", lng: "127.41", source: "memory" },
    { id: "zero", lat: 0, lng: 0, source: "memory" },
    null,
  ]);
  assert.deepEqual(f.map((x) => x.id), ["ok"]);
});

test("candidateFeatures: stayed → bearing_diff null, path_dist null, dist and reach from last point", () => {
  const m = lastMotion([{ t: T0, lat: LAT, lng: LNG }]);
  const [f] = candidateFeatures(m, T0 + 20 * MIN, [{ id: "s", lat: LAT + 900 * M_LAT, lng: LNG, source: "places" }]);
  assert.equal(f.bearing_diff_deg, null);
  assert.equal(f.path_dist_m, null);
  assert.ok(Math.abs(f.dist_m - 900) <= 1);
  assert.equal(f.reachable, true);                                 // 20분 × 0.8m/s = 960m
});

test("candidateFeatures: no GPS (none) or empty places → []", () => {
  assert.deepEqual(candidateFeatures(lastMotion([]), T0, [{ id: "a", lat: LAT, lng: LNG, source: "memory" }]), []);
  assert.deepEqual(candidateFeatures(north(), T0, []), []);
  assert.deepEqual(candidateFeatures(north(), T0, undefined), []);
});

test("candidateFeatures: place exactly at last position → bearing_diff 0", () => {
  const m = north();
  const [f] = candidateFeatures(m, m.t + 10 * MIN, [{ id: "here", lat: m.lat, lng: m.lng, source: "memory" }]);
  assert.equal(f.dist_m, 0);
  assert.equal(f.bearing_diff_deg, 0);
});

test("candidateFeatures: bearing_diff wraps across north (bearing 350 vs place at 10)", () => {
  const m = { state: "moving_lost", lat: LAT, lng: LNG, t: T0, speedMps: 1, bearingDeg: 350 };
  const place = { id: "w", lat: LAT + 1000 * M_LAT * Math.cos((10 * Math.PI) / 180), lng: LNG + 1000 * M_LNG * Math.sin((10 * Math.PI) / 180), source: "memory" };
  const [f] = candidateFeatures(m, T0 + 10 * MIN, [place]);
  assert.ok(Math.abs(f.bearing_diff_deg - 20) <= 1, `diff ${f.bearing_diff_deg}`);
});

test("fallbackOrder puts reachable memory place first", () => {
  const list = [
    { id: "far", reachable: false, path_dist_m: 100, dist_m: 100, source: "memory" },
    { id: "r-places", reachable: true, path_dist_m: 500, dist_m: 500, source: "places" },
    { id: "r-memory", reachable: true, path_dist_m: 500, dist_m: 500, source: "memory" },
  ];
  assert.deepEqual(fallbackOrder(list).map((x) => x.id), ["r-memory", "r-places", "far"]);
});

test("fallbackOrder: reachable first, then path_dist_m ascending", () => {
  const list = [
    { id: "c", reachable: true, path_dist_m: 900, dist_m: 100, source: "memory" },
    { id: "d", reachable: false, path_dist_m: 50, dist_m: 50, source: "memory" },
    { id: "a", reachable: true, path_dist_m: 100, dist_m: 900, source: "places" },
    { id: "e", reachable: false, path_dist_m: 30, dist_m: 30, source: "memory" },
  ];
  assert.deepEqual(fallbackOrder(list).map((x) => x.id), ["a", "c", "e", "d"]);
});

test("fallbackOrder: without path_dist_m falls back to dist_m", () => {
  const list = [
    { id: "far", reachable: true, path_dist_m: null, dist_m: 800, source: "memory" },
    { id: "near", reachable: true, path_dist_m: null, dist_m: 200, source: "places" },
    { id: "mid", reachable: true, dist_m: 500, source: "memory" },
  ];
  assert.deepEqual(fallbackOrder(list).map((x) => x.id), ["near", "mid", "far"]);
});

test("fallbackOrder does not mutate its input and tolerates junk", () => {
  const list = [{ id: "b", reachable: false, dist_m: 2, source: "memory" }, { id: "a", reachable: true, dist_m: 9, source: "memory" }];
  const copy = structuredClone(list);
  const out = fallbackOrder(list);
  assert.deepEqual(list, copy);
  assert.notEqual(out, list);
  assert.deepEqual(fallbackOrder(undefined), []);
  assert.deepEqual(fallbackOrder([]), []);
});

test("end to end: lost walking north, memory place ahead outranks a nearer place behind", () => {
  const m = north(), now = m.t + 20 * MIN;
  const places = [
    { id: "behind", name: "뒤쪽 공원", ...ahead(m, -200), source: "places" },
    { id: "ahead", name: "앞쪽 시장", ...ahead(m, 900), source: "memory" },
  ];
  const order = fallbackOrder(candidateFeatures(m, now, places)).map((x) => x.id);
  assert.deepEqual(order, ["ahead", "behind"]);
});
