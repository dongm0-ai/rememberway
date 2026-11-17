// Task 11 (서버 부분) — 예상 후보지: AI는 코드가 만든 후보 목록 안에서만 순서·이유. verifyCandidates, motionSummary/direction8, 프롬프트 규칙, 모의 응답, /api/diary mode "candidates"
import test from "node:test";
import assert from "node:assert/strict";
import { verifyCandidates, fmtDist, fmtElapsed } from "../public/lib/verify.js";
import { motionSummary, direction8 } from "../public/lib/predict.js";
import { SYSTEM_CANDIDATES, userCandidates, SYSTEM_EXTRACT, SYSTEM_FOLLOWUP, SYSTEM_DIARY, SYSTEM_WEEKLY, SYSTEM_RECORD, SYSTEM_GPS, SYSTEM_MEMORY } from "../lib/prompts.js";
import { askJSON } from "../lib/claude.js";
import handler from "../api/diary.js";

// ---------------------------------------------------------------- 검증 (브리프의 4개)
test("drops ids not in candidates", () => assert.deepEqual(verifyCandidates({ ranked: [{ id: "zz", reason: "r" }] }, [{ id: "c1" }], {}), []));
test("keeps max 3, no duplicates", () => {
  const cands = ["c1", "c2", "c3", "c4", "c5"].map((id) => ({ id }));
  const raw = { ranked: ["c2", "c2", "c1", "c4", "c3", "c5"].map((id) => ({ id, reason: "이유예요" })) };
  assert.deepEqual(verifyCandidates(raw, cands, {}).map((r) => r.id), ["c2", "c1", "c4"]);
});
test("number not in input → warn true", () => assert.equal(verifyCandidates({ ranked: [{ id: "c1", reason: "5km 떨어져 있어요" }] }, [{ id: "c1", dist_m: 1200 }], {})[0].warn, true));
test("number from input → warn false", () => assert.equal(verifyCandidates({ ranked: [{ id: "c1", reason: "마지막 위치에서 1200m 거리예요" }] }, [{ id: "c1", dist_m: 1200 }], {})[0].warn, false));

// ---------------------------------------------------------------- 검증 (추가)
test("result shape is exactly {id, reason, warn} and AI order is kept", () => {
  const out = verifyCandidates({ ranked: [{ id: "b", reason: "  둘째예요  ", extra: 1 }, { id: "a", reason: "첫째예요" }] }, [{ id: "a" }, { id: "b" }], {});
  assert.deepEqual(out, [{ id: "b", reason: "둘째예요", warn: false }, { id: "a", reason: "첫째예요", warn: false }]);
});
test("reason over 200 chars is dropped (not truncated); exactly 200 is kept", () => {
  const cands = [{ id: "a" }, { id: "b" }];
  const out = verifyCandidates({ ranked: [{ id: "a", reason: "가".repeat(201) }, { id: "b", reason: "나".repeat(200) }] }, cands, {});
  assert.deepEqual(out.map((r) => r.id), ["b"]);
  assert.equal(out[0].reason.length, 200);
});
test("a dropped entry (unknown id / bad reason) does not use up a slot or block a later valid duplicate", () => {
  const cands = ["a", "b", "c", "d"].map((id) => ({ id }));
  const raw = { ranked: [{ id: "a", reason: "x".repeat(300) }, { id: "zz", reason: "r" }, { id: "a", reason: "다시 짧게 써요" }, { id: "b", reason: "ok요" }, { id: "c", reason: "ok요" }, { id: "d", reason: "ok요" }] };
  assert.deepEqual(verifyCandidates(raw, cands, {}).map((r) => r.id), ["a", "b", "c"]);
});
test("missing, empty, or non-string reason is dropped", () => {
  const cands = [{ id: "a" }];
  for (const reason of [undefined, null, "", "   ", 5, {}, []]) assert.deepEqual(verifyCandidates({ ranked: [{ id: "a", reason }] }, cands, {}), [], String(reason));
});
test("non-string id is dropped (no loose matching)", () => {
  assert.deepEqual(verifyCandidates({ ranked: [{ id: 1, reason: "r요" }, { id: ["a"], reason: "r요" }, { id: null, reason: "r요" }] }, [{ id: "1" }, { id: "a" }], {}), []);
});
test("garbage AI output gives []", () => {
  for (const raw of [null, undefined, "text", 5, [], {}, { ranked: "x" }, { ranked: {} }, { ranked: [null, 3, "a", {}, { id: "a" }] }])
    assert.deepEqual(verifyCandidates(raw, [{ id: "a" }], {}), []);
});
test("garbage candidates / motion gives [] or does not throw", () => {
  const raw = { ranked: [{ id: "a", reason: "r요" }] };
  for (const cands of [null, undefined, "x", 5, {}, [], [null, 3, {}, { id: 7 }]]) assert.deepEqual(verifyCandidates(raw, cands, {}), []);
  assert.equal(verifyCandidates(raw, [{ id: "a" }], null).length, 1);
  assert.equal(verifyCandidates(raw, [{ id: "a" }], undefined).length, 1);
});
test("warn is false when the reason has no number at all", () => assert.equal(verifyCandidates({ ranked: [{ id: "a", reason: "가던 방향에 있는 단골 시장이에요" }] }, [{ id: "a", dist_m: 300 }], {})[0].warn, false));
test("one number outside the input flags the whole reason (warn true, entry kept)", () => {
  const out = verifyCandidates({ ranked: [{ id: "a", reason: "300m 거리이고 15분이면 닿아요" }] }, [{ id: "a", dist_m: 300 }], {});
  assert.equal(out.length, 1);
  assert.equal(out[0].warn, true);
});
test("numbers from motion count as input numbers (minutes, speed, bearing diff, path distance, evidence text)", () => {
  const cands = [{ id: "a", dist_m: 1200, bearing_diff_deg: 12, path_dist_m: 80, evidence: "1975년에 장사하셨어요" }];
  const motion = { state: "moving_lost", minutes_since: 40, speed_kmh: 3.6, direction_8: "북동" };
  const ok = (reason) => verifyCandidates({ ranked: [{ id: "a", reason }] }, cands, motion)[0].warn;
  assert.equal(ok("40분 전 시속 3.6km로 가시던 방향에서 12도 차이, 예상 경로까지 80m예요"), false);
  assert.equal(ok("1975년에 장사하셨던 곳이에요"), false);
  assert.equal(ok("41분 전에 끊겼어요"), true);
});
test("candidate id digits are not input numbers (ids are handles, not computed values)", () => {
  assert.equal(verifyCandidates({ ranked: [{ id: "c1", reason: "1km 떨어져 있어요" }] }, [{ id: "c1", dist_m: 3000 }], {})[0].warn, true);
  assert.equal(verifyCandidates({ ranked: [{ id: "c1", reason: "3km 떨어져 있어요" }] }, [{ id: "c1", dist_m: 3000 }], {})[0].warn, false);
});
test("coordinates left in a candidate or motion are not input numbers either", () => {
  const cands = [{ id: "a", dist_m: 3000, lat: 36.6123, lng: 127.4123 }];
  assert.equal(verifyCandidates({ ranked: [{ id: "a", reason: "36.6123 에 있어요" }] }, cands, { lat: 36.6, lng: 127.4 })[0].warn, true);
});

// ---------------------------------------------------------------- 같은 값의 다른 꼴(km·시간·반올림)은 새 숫자가 아니다
const warnOf = (reason, cand, motion = {}) => verifyCandidates({ ranked: [{ id: "a", reason }] }, [{ id: "a", ...cand }], motion)[0].warn;
test("derived forms of the same value do not warn: km (1 decimal and rounded), hours + minutes, rounded speed", () => {
  assert.equal(warnOf("마지막 위치에서 1.2km 거리예요", { dist_m: 1200 }), false);
  assert.equal(warnOf("마지막 위치에서 2.4km 거리예요", { dist_m: 2400 }), false);
  assert.equal(warnOf("마지막 위치에서 약 1km 거리예요", { dist_m: 1200 }), false);
  assert.equal(warnOf("예상 경로에서 0.8km 떨어져 있어요", { dist_m: 100, path_dist_m: 800 }), false);
  assert.equal(warnOf("예상 경로에서 약 1km 떨어져 있어요", { dist_m: 100, path_dist_m: 800 }), false);
  assert.equal(warnOf("시속 약 4km로 가시던 방향이에요", { dist_m: 100 }, { speed_kmh: 3.6 }), false);
  assert.equal(warnOf("시속 3.6km로 가시다 끊겼어요", { dist_m: 100 }, { speed_kmh: 3.6 }), false);
  assert.equal(warnOf("1시간 15분 전에 끊겼어요", { dist_m: 100 }, { minutes_since: 75 }), false);
  assert.equal(warnOf("약 1.3시간 전에 끊겼어요", { dist_m: 100 }, { minutes_since: 75 }), false);
  assert.equal(warnOf("40분 전에 끊겼어요", { dist_m: 100 }, { minutes_since: 40 }), false);
});
test("numbers that are not the same value in another form still warn", () => {
  assert.equal(warnOf("5km 떨어져 있어요", { dist_m: 1200 }), true);
  assert.equal(warnOf("12km 떨어져 있어요", { dist_m: 1200 }), true);
  assert.equal(warnOf("시속 6.3km로 가셨어요", { dist_m: 100 }, { speed_kmh: 3.6 }), true);
  assert.equal(warnOf("40분 전에 끊겼어요", { dist_m: 100 }, { minutes_since: 75 }), true);
  assert.equal(warnOf("1.5km 거리예요", { dist_m: 1200 }), true);
  assert.equal(warnOf("1시간 20분 전이에요", { dist_m: 100 }, { minutes_since: 75 }), true);
});
test("decimals are one number: 1.2 is not 1 and 2, and 3.60 equals 3.6", () => {
  assert.equal(warnOf("2km 거리예요", { dist_m: 3000, name: "1.2번 출구" }), true);   // 2 는 입력에 없다 (1.2 한 덩어리)
  assert.equal(warnOf("1.2번 출구 쪽이에요", { dist_m: 3000, name: "1.2번 출구" }), false);
  assert.equal(warnOf("시속 3.60km예요", { dist_m: 100 }, { speed_kmh: 3.6 }), false);
});
test("derived values are accepted only with their own unit: a rounded km is not an hour, a minute is not a metre", () => {
  assert.equal(warnOf("1시간 전에 끊겼어요", { dist_m: 1200 }), true);                      // 1200m → 반올림 1km 는 "1시간"이 아니다
  assert.equal(warnOf("1시간 전에 끊겼어요", { dist_m: 1200 }, { minutes_since: 75 }), false);
  assert.equal(warnOf("1km 떨어져 있어요", { dist_m: 100 }, { minutes_since: 75 }), true);   // 75분 → 1시간 의 1 은 km 가 아니다
  assert.equal(warnOf("45분 걸려요", { dist_m: 100, path_dist_m: 45 }), true);                // 45m 는 45분이 아니다
  assert.equal(warnOf("예상 경로에서 45m 떨어져 있어요", { dist_m: 100, path_dist_m: 45 }), false);
  assert.equal(warnOf("15분 전에 끊겼어요", { dist_m: 15 }, {}), true);
  assert.equal(warnOf("15m 거리예요", { dist_m: 15 }, {}), false);
  assert.equal(warnOf("12km 가까이 가셨어요", { dist_m: 100, bearing_diff_deg: 12 }), true);  // 방향 차이 12도 는 12km 가 아니다
  assert.equal(warnOf("방향이 12도 달라요", { dist_m: 100, bearing_diff_deg: 12 }), false);
  assert.equal(warnOf("약 2km 가셨어요", { dist_m: 100 }, { speed_kmh: 2.4 }), true);        // 시속 값은 시속 문맥에서만 (거리 2km 가 아니다)
  assert.equal(warnOf("시속 약 2km로 가셨어요", { dist_m: 100 }, { speed_kmh: 2.4 }), false);
  assert.equal(warnOf("시속 2.4km/h 정도예요", { dist_m: 100 }, { speed_kmh: 2.4 }), false);
  assert.equal(warnOf("2.4km/h 정도예요", { dist_m: 100 }, { speed_kmh: 2.4 }), false);
  assert.equal(warnOf("시속 2.4킬로로 가셨어요", { dist_m: 100 }, { speed_kmh: 2.4 }), false);
  assert.equal(warnOf("2킬로 떨어져 있어요", { dist_m: 2000 }), false);
});
test("a number written with a thousands separator is one number (1,200m = 1200m)", () => {
  assert.equal(warnOf("마지막 위치에서 1,200m 거리예요", { dist_m: 1200 }), false);
  assert.equal(warnOf("마지막 위치에서 1,200m 거리예요", { dist_m: 1300 }), true);
  assert.equal(warnOf("1,200 미터 거리예요", { dist_m: 1200 }), false);
  assert.equal(warnOf("1,2km 거리예요", { dist_m: 1200 }), true);   // 쉼표 뒤가 3자리가 아니면 두 숫자 (1 과 2)
});
test("a unit written in the candidate's own text (evidence, name) is kept: 30분 there is not 30m", () => {
  assert.equal(warnOf("걸어서 30분 거리라고 하셨어요", { dist_m: 100, evidence: "걸어서 30분 거리" }), false);
  assert.equal(warnOf("30m 거리라고 하셨어요", { dist_m: 100, evidence: "걸어서 30분 거리" }), true);
  assert.equal(warnOf("3번 출구 쪽이에요", { dist_m: 100, name: "3번 출구" }), false);
});
test("a reason may only use the numbers of its own candidate plus motion (not another candidate's)", () => {
  const cands = [{ id: "c1", dist_m: 1200 }, { id: "c2", dist_m: 800 }];
  const motion = { minutes_since: 40 };
  const out = verifyCandidates({ ranked: [{ id: "c1", reason: "800m 거리예요" }, { id: "c2", reason: "800m 거리예요" }, { id: "c1x", reason: "x" }] }, cands, motion);
  assert.deepEqual(out.map((r) => [r.id, r.warn]), [["c1", true], ["c2", false]]);
  const own = verifyCandidates({ ranked: [{ id: "c1", reason: "40분 전에 끊겼고 1.2km 거리예요" }, { id: "c2", reason: "40분 전에 끊겼고 800m 거리예요" }] }, cands, motion);
  assert.deepEqual(own.map((r) => r.warn), [false, false]);
});

// ---------------------------------------------------------------- 화면·AI가 같이 쓰는 문구 (fmtDist, fmtElapsed)
test("fmtDist: under 1000m in metres, otherwise km with one decimal (trailing .0 dropped)", () => {
  const cases = [[0, "0m"], [80, "80m"], [800, "800m"], [999, "999m"], [999.6, "1km"], [1000, "1km"], [1049, "1km"], [1050, "1.1km"], [1200, "1.2km"], [2400, "2.4km"], [12000, "12km"]];
  for (const [m, text] of cases) assert.equal(fmtDist(m), text, String(m));
  for (const v of [-1, NaN, Infinity, null, undefined, "5", {}]) assert.equal(fmtDist(v), null, String(v));
});
test("fmtElapsed: minutes under an hour, otherwise hours + minutes", () => {
  const cases = [[0, "0분"], [40, "40분"], [59, "59분"], [60, "1시간"], [75, "1시간 15분"], [120, "2시간"], [135, "2시간 15분"], [59.6, "1시간"]];
  for (const [m, text] of cases) assert.equal(fmtElapsed(m), text, String(m));
  for (const v of [-1, NaN, Infinity, null, undefined, "5"]) assert.equal(fmtElapsed(v), null, String(v));
});
test("the formatted texts never warn for their own candidate/motion (what the AI is told to quote)", () => {
  for (const dist_m of [0, 80, 800, 999, 1000, 1049, 1050, 1200, 2400, 12000, 45678]) assert.equal(warnOf(`${fmtDist(dist_m)} 거리예요`, { dist_m }), false, String(dist_m));
  for (const minutes_since of [0, 5, 59, 60, 75, 120, 135, 1439, 10080]) assert.equal(warnOf(`${fmtElapsed(minutes_since)} 전에 끊겼어요`, { dist_m: 100 }, { minutes_since }), false, String(minutes_since));
});
test("numbers are compared as whole digit runs, not substrings", () => {
  assert.equal(verifyCandidates({ ranked: [{ id: "a", reason: "120m 거리예요" }] }, [{ id: "a", dist_m: 1200 }], {})[0].warn, true);
  assert.equal(verifyCandidates({ ranked: [{ id: "a", reason: "12000m 거리예요" }] }, [{ id: "a", dist_m: 1200 }], {})[0].warn, true);
});
test("does not mutate its inputs", () => {
  const raw = { ranked: [{ id: "a", reason: " 이유요 " }] }, cands = [{ id: "a", dist_m: 5 }], motion = { state: "stayed" };
  const copy = structuredClone([raw, cands, motion]);
  verifyCandidates(raw, cands, motion);
  assert.deepEqual([raw, cands, motion], copy);
});

// ---------------------------------------------------------------- direction8 / motionSummary
test("direction8: 45° sectors centered on each direction, 0° = 북", () => {
  const cases = [[0, "북"], [22.4, "북"], [22.5, "북동"], [45, "북동"], [67.4, "북동"], [67.5, "동"], [90, "동"], [135, "남동"], [180, "남"], [225, "남서"], [270, "서"], [315, "북서"], [337.4, "북서"], [337.5, "북"], [359.9, "북"], [360, "북"], [-45, "북서"], [405, "북동"]];
  for (const [deg, name] of cases) assert.equal(direction8(deg), name, String(deg));
});
test("direction8: non-numbers give null", () => {
  for (const v of [NaN, Infinity, undefined, null, "x", {}]) assert.equal(direction8(v), null, String(v));
});
const MIN = 60000, T0 = Date.UTC(2026, 10, 17, 5, 0, 0);
test("motionSummary: moving_lost → minutes since, km/h, 8-way direction", () => {
  const m = { state: "moving_lost", lat: 36.6, lng: 127.4, t: T0, speedMps: 1, bearingDeg: 45 };
  assert.deepEqual(motionSummary(m, T0 + 40 * MIN), { state: "moving_lost", minutes_since: 40, speed_kmh: 3.6, direction_8: "북동" });
});
test("motionSummary: rounds minutes to whole and speed to one decimal", () => {
  const m = { state: "moving_lost", lat: 36.6, lng: 127.4, t: T0, speedMps: 0.9, bearingDeg: 200 };
  assert.deepEqual(motionSummary(m, T0 + 12.4 * MIN), { state: "moving_lost", minutes_since: 12, speed_kmh: 3.2, direction_8: "남" });
});
test("motionSummary: stayed keeps minutes only (no speed, no direction)", () => {
  assert.deepEqual(motionSummary({ state: "stayed", lat: 36.6, lng: 127.4, t: T0 }, T0 + 25 * MIN), { state: "stayed", minutes_since: 25, speed_kmh: null, direction_8: null });
});
test("motionSummary: none / junk → none with nulls; carries no coordinates", () => {
  const none = { state: "none", minutes_since: null, speed_kmh: null, direction_8: null };
  for (const m of [{ state: "none" }, null, undefined, "x", {}, { state: "weird" }]) assert.deepEqual(motionSummary(m, T0), none, String(m));
  const s = JSON.stringify(motionSummary({ state: "moving_lost", lat: 36.6, lng: 127.4, t: T0, speedMps: 1, bearingDeg: 0 }, T0 + MIN));
  assert.ok(!/lat|lng|36\.6|127\.4/.test(s), s);
});
test("motionSummary: now before the last fix gives 0 minutes; bad now/t gives null", () => {
  const m = { state: "stayed", lat: 1, lng: 1, t: T0 };
  assert.equal(motionSummary(m, T0 - 5 * MIN).minutes_since, 0);
  assert.equal(motionSummary(m, NaN).minutes_since, null);
  assert.equal(motionSummary(m, undefined).minutes_since, null);
  assert.equal(motionSummary({ state: "stayed", lat: 1, lng: 1 }, T0).minutes_since, null);
});
test("motionSummary: moving_lost with unusable speed/bearing still returns finite-or-null fields", () => {
  const s = motionSummary({ state: "moving_lost", lat: 1, lng: 1, t: T0 }, T0 + MIN);
  assert.equal(s.speed_kmh, null);
  assert.equal(s.direction_8, null);
});

// ---------------------------------------------------------------- 프롬프트 규칙 (고치면 안 되는 문구)
test("SYSTEM_CANDIDATES keeps the required rules", () => {
  for (const s of ["최대 3개", "목록 안", "존댓말", "입력에 없는 숫자", "입력에 없는 장소", "evidence", "추억의 장소", "JSON", `{"ranked":[{"id":"","reason":""}]}`, "확률", "%", "AI가 추천", "dist_text", "path_dist_text", "elapsed_text", "그대로 인용", "다른 후보의 숫자", "none"]) assert.ok(SYSTEM_CANDIDATES.includes(s), s);
});
test("mock routing phrases do not collide between SYSTEM_CANDIDATES and the other prompts", () => {
  const routing = ["되물을 질문", "하루 기록을 정리", "자주 머문 곳", "기억 꺼내기", "지난주 기록을 짧게", "찾은 뒤 보호자가 남기는 기록"];
  for (const phrase of routing) assert.ok(!SYSTEM_CANDIDATES.includes(phrase), `mock routing collision: ${phrase}`);
  for (const [name, p] of Object.entries({ SYSTEM_EXTRACT, SYSTEM_FOLLOWUP, SYSTEM_DIARY, SYSTEM_WEEKLY, SYSTEM_RECORD, SYSTEM_GPS, SYSTEM_MEMORY }))
    assert.ok(!p.includes("예상 후보지"), `${name} contains the candidates routing phrase`);
  assert.ok(SYSTEM_CANDIDATES.includes("예상 후보지"));
});
test("userCandidates puts honorific, motion and the candidate list in the prompt", () => {
  const motion = { state: "moving_lost", minutes_since: 40, speed_kmh: 3.6, direction_8: "북동" };
  const cands = [{ id: "c1", name: "육거리시장", source: "memory", evidence: "장사하셨어요", dist_m: 1200, bearing_diff_deg: 10, reachable: true, path_dist_m: 80 }];
  const u = userCandidates("아버지", motion, cands);
  assert.ok(u.includes("아버지") && u.includes("북동") && u.includes("육거리시장") && u.includes('"c1"'));
  assert.deepEqual(JSON.parse((u.match(/후보 목록[^\n]*\n(\[[\s\S]*\])/) ?? [, "[]"])[1]), cands);
});

// ---------------------------------------------------------------- 모의 응답 (MOCK_AI=1) + /api/diary mode "candidates"
async function withMock(fn) {
  const prev = process.env.MOCK_AI; process.env.MOCK_AI = "1";
  try { return await fn(); } finally { if (prev === undefined) delete process.env.MOCK_AI; else process.env.MOCK_AI = prev; }
}
let n = 0;
function post(body) {
  return new Promise((resolve) => {
    const res = { setHeader() {}, end(s) { resolve(JSON.parse(s)); } };
    handler({ method: "POST", headers: { origin: "http://localhost:3000", "x-forwarded-for": `candidates-test-${++n}` }, body }, res);
  });
}
const motion = (over = {}) => ({ state: "moving_lost", minutes_since: 40, speed_kmh: 3.6, direction_8: "북동", ...over });
const cand = (id, over = {}) => ({ id, name: `장소${id}`, source: "memory", evidence: "예전에 다니셨어요", dist_m: 1200, bearing_diff_deg: 10, reachable: true, path_dist_m: 80, ...over });
const body = (over = {}) => ({ mode: "candidates", honorific: "아버지", motion: motion(), candidates: [cand("c1"), cand("c2"), cand("c3"), cand("c4")], ...over });

/** 실제 제공자(Claude)를 가짜 fetch로 대신해 AI에 나간 요청을 붙잡고 원하는 JSON을 돌려준다 */
async function withFakeAI(reply, fn) {
  const keys = ["MOCK_AI", "UPSTAGE_API_KEY", "GEMINI_API_KEY", "ANTHROPIC_API_KEY"], prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const realFetch = globalThis.fetch, sent = [];
  delete process.env.MOCK_AI; delete process.env.UPSTAGE_API_KEY; delete process.env.GEMINI_API_KEY; process.env.ANTHROPIC_API_KEY = "test-key";
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), body: JSON.parse(init.body) });
    const text = typeof reply === "function" ? reply(sent.at(-1)) : reply;
    return { ok: true, status: 200, async json() { return { content: [{ type: "text", text: typeof text === "string" ? text : JSON.stringify(text) }] }; }, async text() { return ""; } };
  };
  try { return await fn(sent); } finally { globalThis.fetch = realFetch; for (const k of keys) if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
}

test("mock reply for the candidates prompt is JSON whose ids come from the list and survives verifyCandidates without ⚠", () => withMock(async () => {
  const cands = [cand("c1"), cand("c2", { dist_m: 300 }), cand("c3"), cand("c4")];
  const raw = await askJSON(SYSTEM_CANDIDATES, userCandidates("아버지", motion(), cands));
  const v = verifyCandidates(raw, cands, motion());
  assert.equal(v.length, 3);
  assert.ok(v.every((r) => cands.some((c) => c.id === r.id) && r.warn === false), JSON.stringify(v));
}));
test("mock reply quotes the code-made dist_text (not a hand-built `${dist_m}m`) and never warns for it", () => withMock(async () => {
  const cands = [cand("c1", { dist_m: 1234.6, dist_text: "1.2km" }), cand("c2", { dist_m: 800, dist_text: "800m" })];
  const raw = await askJSON(SYSTEM_CANDIDATES, userCandidates("아버지", motion(), cands));
  assert.ok(raw.ranked[0].reason.includes("1.2km") && !raw.ranked[0].reason.includes("1234"), raw.ranked[0].reason);
  assert.ok(raw.ranked[1].reason.includes("800m"), raw.ranked[1].reason);
  assert.deepEqual(verifyCandidates(raw, cands, motion()).map((r) => r.warn), [false, false]);
}));
test("mock reply with an empty list is an empty ranking", () => withMock(async () => {
  assert.deepEqual((await askJSON(SYSTEM_CANDIDATES, userCandidates("아버지", motion(), []))).ranked, []);
}));

test("/api/diary mode candidates: ranked ≤3, ids from the list, reason string, warn boolean, mock flagged", () => withMock(async () => {
  const out = await post(body());
  assert.equal(out.ok, true);
  assert.equal(out.mock, true);
  assert.ok(out.ranked.length >= 1 && out.ranked.length <= 3);
  for (const r of out.ranked) {
    assert.ok(["c1", "c2", "c3", "c4"].includes(r.id));
    assert.equal(typeof r.reason, "string");
    assert.ok(r.reason.length > 0 && r.reason.length <= 200);
    assert.equal(typeof r.warn, "boolean");
  }
  assert.equal(new Set(out.ranked.map((r) => r.id)).size, out.ranked.length);
}));
test("/api/diary mode candidates: 15 candidates ok, 16 is BAD_INPUT, 0 is BAD_INPUT", () => withMock(async () => {
  const many = (k) => Array.from({ length: k }, (_, i) => cand(`c${i}`));
  assert.equal((await post(body({ candidates: many(15) }))).ok, true);
  for (const candidates of [many(16), [], undefined, null, "x", {}]) {
    const out = await post(body({ candidates }));
    assert.deepEqual([out.ok, out.reason], [false, "BAD_INPUT"]);
  }
}));
test("/api/diary mode candidates: bad motion or bad candidate fields are BAD_INPUT", () => withMock(async () => {
  const bad = [
    body({ motion: undefined }), body({ motion: "x" }), body({ motion: motion({ state: "flying" }) }),
    body({ motion: motion({ direction_8: "북북동" }) }), body({ motion: motion({ minutes_since: -1 }) }), body({ motion: motion({ minutes_since: "40" }) }),
    body({ motion: motion({ speed_kmh: NaN }) }), body({ motion: motion({ speed_kmh: 500 }) }),
    body({ candidates: [cand("c1", { id: "" })] }), body({ candidates: [cand("c1", { id: 7 })] }), body({ candidates: [cand("c1"), cand("c1")] }),
    body({ candidates: [cand(" c1")] }), body({ candidates: [cand("c1 ")] }), body({ candidates: [cand("c1\n")] }), body({ candidates: [cand("c".repeat(41))] }), body({ candidates: [cand("   ")] }),
    body({ candidates: [cand("c1", { name: "" })] }), body({ candidates: [cand("c1", { name: 3 })] }),
    body({ candidates: [cand("c1", { dist_m: "12" })] }), body({ candidates: [cand("c1", { dist_m: -5 })] }), body({ candidates: [cand("c1", { dist_m: null })] }),
    body({ candidates: [cand("c1", { bearing_diff_deg: 181 })] }), body({ candidates: [cand("c1", { reachable: "yes" })] }), body({ candidates: [cand("c1", { path_dist_m: -1 })] }),
    body({ candidates: [null] }), body({ candidates: [3] }),
  ];
  for (const b of bad) {
    const out = await post(b);
    assert.deepEqual([out.ok, out.reason], [false, "BAD_INPUT"], JSON.stringify(b).slice(0, 160));
  }
}));
test("/api/diary mode candidates: an id is taken exactly as sent (40 chars ok, not trimmed or cut)", () => withFakeAI((r) => ({ ranked: JSON.parse(r.body.messages[0].content.match(/후보 목록[^\n]*\n(\[[\s\S]*\])/)[1]).map((c) => ({ id: c.id, reason: "가던 방향이에요" })) }), async () => {
  const id = "c".repeat(40);
  const out = await post(body({ candidates: [cand(id), cand("ok-2")] }));
  assert.equal(out.ok, true);
  assert.deepEqual(out.ranked.map((r) => r.id), [id, "ok-2"]);
}));
test("/api/diary mode candidates: stayed motion and null optional fields are accepted", () => withMock(async () => {
  const out = await post(body({ motion: { state: "stayed", minutes_since: 25, speed_kmh: null, direction_8: null }, candidates: [cand("c1", { source: "frequent", evidence: null, bearing_diff_deg: null, path_dist_m: null })] }));
  assert.equal(out.ok, true);
  assert.equal(out.ranked[0].id, "c1");
}));

test("/api/diary mode candidates: coordinates and other extra fields never reach the AI", () => withFakeAI({ ranked: [{ id: "c1", reason: "가던 방향에 있어요" }] }, async (sent) => {
  const dirty = cand("c1", { lat: 36.6123456, lng: 127.4123456, latitude: 36.6123456, longitude: 127.4123456, address: "충북 청주시 어딘가 1번지", phone: "010-1234-5678" });
  const out = await post(body({ candidates: [dirty, cand("c2")], motion: { ...motion(), lat: 36.6234567, lng: 127.4234567, t: 1731819600000, speedMps: 1, bearingDeg: 45 }, home: { lat: 36.5, lng: 127.3 }, utterance: "아버지가 두시쯤 나가셨어요" }));
  assert.equal(out.ok, true);
  assert.equal(sent.length, 1);
  const prompt = sent[0].body.messages[0].content;
  for (const leak of ["36.6", "127.4", "36.5", "127.3", "충북 청주시 어딘가", "010-1234", "나가셨어요", "1731819600000", "speedMps", "bearingDeg"]) assert.ok(!prompt.includes(leak), `leaked: ${leak}`);
  assert.ok(!/\b(lat|lng|latitude|longitude|address|phone|utterance|home)\b/i.test(prompt), prompt);
  assert.ok(sent[0].body.system.includes("예상 후보지"));
}));
test("/api/diary mode candidates: the AI gets code-made texts (dist_text, path_dist_text, elapsed_text) and the same ones verify the reply", () => withFakeAI({ ranked: [{ id: "c1", reason: "40분 전에 끊겼고 마지막 위치에서 1.2km, 예상 경로에서 80m 거리예요" }, { id: "c2", reason: "1시간 15분 전이라고 해요" }] }, async (sent) => {
  const out = await post(body({ motion: motion({ minutes_since: 40 }), candidates: [cand("c1", { dist_m: 1200, path_dist_m: 80 }), cand("c2", { dist_m: 2400, path_dist_m: null })] }));
  assert.equal(out.ok, true);
  const prompt = sent[0].body.messages[0].content;
  assert.ok(prompt.includes('"elapsed_text":"40분"'), prompt);
  assert.ok(prompt.includes('"dist_text":"1.2km"') && prompt.includes('"dist_text":"2.4km"') && prompt.includes('"path_dist_text":"80m"') && prompt.includes('"path_dist_text":null'), prompt);
  assert.deepEqual(out.ranked.map((r) => [r.id, r.warn]), [["c1", false], ["c2", true]]); // c2 의 "1시간 15분"은 입력에 없다
}));
test("/api/diary mode candidates: an hour-plus elapsed time is told to the AI as hours and minutes", () => withFakeAI({ ranked: [{ id: "c1", reason: "1시간 15분 전에 끊겼어요" }] }, async (sent) => {
  const out = await post(body({ motion: motion({ minutes_since: 75 }) }));
  assert.ok(sent[0].body.messages[0].content.includes('"elapsed_text":"1시간 15분"'));
  assert.equal(out.ranked[0].warn, false);
}));

test("/api/diary mode candidates: AI picks outside the list are dropped, duplicates dropped, max 3", () => withFakeAI({ ranked: [{ id: "zz", reason: "목록 밖이에요" }, { id: "c3", reason: "가장 가까워요" }, { id: "c3", reason: "또 나왔어요" }, { id: "c1", reason: "다음이에요" }, { id: "c2", reason: "그다음이에요" }, { id: "c4", reason: "넷째예요" }] }, async () => {
  const out = await post(body());
  assert.equal(out.ok, true);
  assert.deepEqual(out.ranked.map((r) => r.id), ["c3", "c1", "c2"]);
}));
test("/api/diary mode candidates: a reason with a number not in the input is kept with warn true", () => withFakeAI({ ranked: [{ id: "c1", reason: "5km 떨어져 있어요" }, { id: "c2", reason: "마지막 위치에서 1200m 거리예요" }] }, async () => {
  const out = await post(body());
  assert.deepEqual(out.ranked.map((r) => [r.id, r.warn]), [["c1", true], ["c2", false]]);
}));
test("/api/diary mode candidates: reasons with 확률 / % / AI가 추천 are dropped", () => withFakeAI({ ranked: [{ id: "c1", reason: "여기일 확률이 높아요" }, { id: "c2", reason: "가능성 40%예요" }, { id: "c3", reason: "AI가 추천한 곳이에요" }, { id: "c4", reason: "가던 방향에 있어요" }] }, async () => {
  const out = await post(body());
  assert.equal(out.ok, true);
  assert.deepEqual(out.ranked.map((r) => r.id), ["c4"]);
}));
test("/api/diary mode candidates: a banned reason does not use up one of the 3 slots", () => withFakeAI({ ranked: [{ id: "c1", reason: "확률이 높아요" }, { id: "c2", reason: "첫째예요" }, { id: "c3", reason: "둘째예요" }, { id: "c4", reason: "셋째예요" }] }, async () => {
  assert.deepEqual((await post(body())).ranked.map((r) => r.id), ["c2", "c3", "c4"]);
}));
test("/api/diary mode candidates: nothing usable from the AI is ok with an empty ranking (screen uses code order)", async () => {
  for (const reply of [{ ranked: [] }, { ranked: [{ id: "zz", reason: "x" }] }, { nope: 1 }, "[]"])
    await withFakeAI(reply, async () => { const out = await post(body()); assert.deepEqual([out.ok, out.ranked], [true, []]); });
});
test("/api/diary mode candidates: AI failure becomes ok:false (screen uses code order)", async () => {
  const keys = ["MOCK_AI", "UPSTAGE_API_KEY", "GEMINI_API_KEY", "ANTHROPIC_API_KEY"], prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  try {
    const out = await post(body());
    assert.equal(out.ok, false);
    assert.ok(!("ranked" in out));
  } finally { for (const k of keys) if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
});
test("/api/diary: gps / memory / default paths still work next to candidates", () => withMock(async () => {
  const g = await post({ mode: "gps", honorific: "아버지", track: { days: 10, period_days: 30 }, places: [{ id: "g1", label: "석교동 어딘가", days_n: 6, avg_min: 40, weekdays: ["월"], hour_band: "오전" }] });
  assert.equal(g.ok, true);
  const m = await post({ mode: "memory", honorific: "아버지", topic: "market", question: "q", answer: "육거리시장에 다니셨어요", knownPlaces: [] });
  assert.equal(m.places[0].name, "육거리시장");
  const d = await post({ spoken: "오늘은 약국에 다녀오셨어요", knownPlaces: [], date: "2026-11-17" });
  assert.equal(d.extracted.new_places[0].name, "약국");
}));
