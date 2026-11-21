// 꾸민 사례 20개(data/scenarios_dongmyeong.json)와 그 결과 문서가 서로 맞는지 지킨다
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { loadData, runAll, summarize, renderDoc, publicJson, buildTrail, walkBetween, searchWalk, nearestFirst, searchSummary, foundSummary, hm, DOC_PATH, PUBLIC_PATH, NEAR_M, GUARDIAN_MPS, LOOK_MIN, DETOUR } from "../scripts/run_scenarios.js";
import { distM } from "../public/lib/gps.js";

const data = loadData();
const rows = await runAll(data);

test("the file says plainly that the cases are made up and where the places come from", () => {
  assert.match(data._note, /지어낸/);
  assert.match(data._note, /성능이 아니다/);
  assert.match(data.source.map, /OpenStreetMap/);
  assert.equal(data.home.name, "대전 동명중학교");
});

test("20 cases, each pointing only at places that exist in the file", () => {
  assert.equal(data.scenarios.length, 20);
  assert.equal(new Set(data.scenarios.map((s) => s.id)).size, 20);
  for (const s of data.scenarios) {
    assert.ok(data.types[s.type], `${s.id} type`);
    assert.ok(data.places[s.found.place], `${s.id} found place`);
    for (const p of s.registered) assert.ok(data.places[p.name], `${s.id} registered ${p.name}`);
    for (const l of s.gps?.legs ?? []) {
      assert.ok(l.stay_min > 0 || (l.toward && l.min > 0 && l.kmh > 0), `${s.id} leg shape`);
      if (l.toward) { assert.ok(data.places[l.toward], `${s.id} leg ${l.toward}`); assert.ok(data.routes[l.toward]?.shape.length >= 2, `${s.id} walking route to ${l.toward}`); }
    }
    if (s.clue.today_destination) assert.ok(data.places[s.clue.today_destination], `${s.id} destination`);
    assert.ok(s.gps ? s.gps.since_cut_min > 0 : s.elapsed_min > 0, `${s.id} elapsed`);
  }
});

test("the made-up guardian words follow the project's wording and privacy rules", () => {
  for (const s of data.scenarios) {
    assert.ok(s.utterance.length > 30, s.id);
    assert.ok(["아버지", "어머니", "어르신"].includes(s.honorific), `${s.id} 호칭만`);
    for (const banned of ["확률", "예측", "AI가 추천"]) assert.ok(!s.utterance.includes(banned) && !s.title.includes(banned), `${s.id} ${banned}`);
    assert.doesNotMatch(s.utterance, /\d+\s*(번길|길|로)\s*\d|\d+동\s*\d+호|번지/, `${s.id} 주소 상세 없음`);
  }
});

test("every case is physically possible and gets candidates from the real code", () => {
  for (const r of rows) {
    assert.equal(r.status, "ok", r.id);
    assert.ok(r.possible, `${r.id}: found place is farther than the fastest walk allows`);
    assert.ok(r.top.length >= 1 && r.top.length <= 3, r.id);
    assert.equal(r.has_gps, r.points > 0, r.id);
    if (!r.has_gps) assert.notEqual(r.state, "stayed", r.id);
    // 3곳은 전체 코드 순서의 앞 3개와 같아야 한다 (AI 없이 돌렸으므로)
    assert.deepEqual(r.top.map((c) => c.name), r.order_names.slice(0, 3), r.id);
    assert.equal(r.hit3, r.top.some((c) => c.to_found_m <= NEAR_M), r.id);
  }
});

test("a trail follows the real walking route, ends when the GPS was cut, and stops on arrival", () => {
  const cut = Date.parse("2026-11-21T10:00:00+09:00");
  const route = data.routes["문창시장"];
  const trail = buildTrail(data.home, [{ toward: "문창시장", min: 60, kmh: 3 }, { stay_min: 5 }], cut, data.routes);
  assert.equal(Date.parse(trail.at(-1).gps_time), cut);
  assert.equal(trail.at(-1).speed_kmh, 0.2);
  assert.ok(distM({ lat: trail.at(-1).lat, lng: trail.at(-1).lng }, data.places["문창시장"]) < 80, "arrived at the market");
  assert.ok(trail.length < 60 * 6, "did not keep walking past the market for the full hour");
  // 길을 따라 걸었다: 모든 점이 도보 경로에서 5m 안, 걸은 길이는 직선거리보다 길다
  const pts = route.shape.map(([lat, lng]) => ({ lat, lng }));
  const offRoute = (p) => Math.min(...pts.slice(1).map((b, i) => { const a = pts[i], ab = distM(a, b), ap = distM(a, p), bp = distM(b, p); if (ab === 0) return ap; const s = (ab + ap + bp) / 2; return Math.min(ap, bp, ap ** 2 + ab ** 2 < bp ** 2 || bp ** 2 + ab ** 2 < ap ** 2 ? Infinity : (2 * Math.sqrt(Math.max(0, s * (s - ab) * (s - ap) * (s - bp)))) / ab); }));
  for (const p of trail.slice(1)) assert.ok(offRoute(p) < 5, "point is on the walking route");
  assert.ok(route.m > data.places["문창시장"].from_home_m * 1.2, "the walking route is longer than the straight line");
  // 걷는 시간이 모자라면 길 중간에서 끊긴다
  const short = buildTrail(data.home, [{ toward: "문창시장", min: 5, kmh: 3 }], cut, data.routes);
  assert.equal(short.length, 1 + 5 * 6);
  assert.ok(distM({ lat: short.at(-1).lat, lng: short.at(-1).lng }, data.places["문창시장"]) > 200);
});

test("cases where the elder stays somewhere really arrive there first", () => {
  for (const s of data.scenarios.filter((x) => x.gps?.legs.some((l) => l.stay_min))) {
    const r = rows.find((x) => x.id === s.id), target = data.places[s.gps.legs[0].toward];
    assert.equal(r.state, "stayed", s.id);
    const end = data.routes[s.gps.legs[0].toward].shape.at(-1);
    assert.ok(distM({ lat: end[0], lng: end[1] }, target) < 80, `${s.id}: route ends at the place`);
    assert.ok(s.gps.legs[0].min * 60 * (s.gps.legs[0].kmh / 3.6) >= data.routes[s.gps.legs[0].toward].m, `${s.id}: walks long enough to arrive`);
  }
});

test("the groups add up to the total", () => {
  const sum = summarize(rows);
  for (const key of ["by_type", "by_gps", "by_registered", "by_state"]) {
    const g = Object.values(sum[key]);
    assert.equal(g.reduce((n, v) => n + v.n, 0), sum.all.n, key);
    assert.equal(g.reduce((n, v) => n + v.hit3, 0), sum.all.hit3, key);
  }
  assert.ok(sum.all.hit1 <= sum.all.hit3 && sum.all.hit3 <= sum.all.in_list);
});

test("docs/시나리오_동명중_결과.md is what the script produces now (rerun the script after editing cases)", () => {
  const norm = (s) => s.replace(/\r\n/g, "\n");
  assert.equal(norm(fs.readFileSync(DOC_PATH, "utf8")), norm(renderDoc(data, rows, summarize(rows))));
});

test("public/data/scenario_results.json (read by /scenarios) is what the script produces now", () => {
  const sum = summarize(rows);
  const now = JSON.parse(JSON.stringify(publicJson(data, rows, sum)));
  assert.deepEqual(JSON.parse(fs.readFileSync(PUBLIC_PATH, "utf8")), now);
  // 화면에 그대로 나가는 자료: 지어낸 사례라는 말이 있고, 금지어·큰 원자료(기본 장소 풀·경로 좌표)는 없다
  assert.equal(now.made_up, true);
  assert.match(now.note, /지어낸/);
  assert.match(now.note, /성능이 아닙니다/);
  const text = JSON.stringify(now);
  for (const banned of ["확률", "예측", "AI가 추천"]) assert.ok(!text.includes(banned), banned);
  assert.ok(!("basic_pool" in now) && !("routes" in now));
  assert.equal(now.cases.length, 20);
  assert.equal(now.cases.filter((c) => c.hit3).length, now.total.hit3);
});

test("the /scenarios page says up front that the cases are made up and never injects data as HTML", () => {
  const html = fs.readFileSync(new URL("../public/scenarios.html", import.meta.url), "utf8");
  assert.match(html, /지어낸 사례입니다/);
  assert.match(html, /보여 주는 숫자가 아닙니다/);
  assert.ok(!/innerHTML|insertAdjacentHTML|document\.write/.test(html), "data goes in through textContent only");
  assert.ok(!/background:\s*#|[^-]color:\s*#/.test(html.replace(/<meta[^>]*>/g, "")), "colors come from the theme variables");
  for (const banned of ["확률", "예측", "AI가 추천"]) assert.ok(!html.includes(banned), banned);
});

test("search time: walking distances come from the real table, and the walk stops at the found place", () => {
  const market = { name: "문창시장", ...data.places["문창시장"] }, hospital = { name: "대전성모병원", ...data.places["대전성모병원"] };
  const w = walkBetween(data, data.home, market);
  assert.equal(w.estimated, false);
  assert.equal(w.m, data.routes["문창시장"].m, "table agrees with the route fetched from the same server");
  assert.ok(w.m > distM(data.home, market), "walking is longer than the straight line");
  // 표에 없는 점은 직선 × DETOUR 로 대신하고 그렇다고 알린다
  const off = walkBetween(data, data.home, { lat: 36.3, lng: 127.44 });
  assert.equal(off.estimated, true);
  assert.equal(off.m, Math.round(distM(data.home, { lat: 36.3, lng: 127.44 }) * DETOUR));

  const first = searchWalk(data, [market, hospital], market);
  assert.deepEqual([first.found, first.stops], [true, 1]);
  assert.equal(first.minutes, Math.round(w.m / GUARDIAN_MPS / 60), "no look-around time is added at the place where the elder is found");
  const second = searchWalk(data, [hospital, market], market);
  assert.equal(second.stops, 2);
  assert.equal(second.minutes, Math.round(walkBetween(data, data.home, hospital).m / GUARDIAN_MPS / 60 + LOOK_MIN + walkBetween(data, hospital, market).m / GUARDIAN_MPS / 60));
  const none = searchWalk(data, [hospital], market);
  assert.equal(none.found, false);
  // 가까운 곳부터: 집에서 더 가까운 시장이 먼저
  assert.deepEqual(nearestFirst(data, [hospital, market]).map((p) => p.name), ["문창시장", "대전성모병원"]);
});

test("search time per case is consistent with the ranking results", () => {
  const ss = searchSummary(rows);
  for (const r of rows) {
    assert.equal(r.search_top3.found, r.hit3, r.id);
    assert.equal(r.search_code.found, r.rank !== null, r.id);
    assert.equal(r.search_near.found, r.search_code.found, `${r.id}: same places, different order`);
    if (r.hit3) assert.equal(r.search_top3.stops, r.rank, r.id);
    assert.ok(r.left_ago_min > 0, r.id);
    assert.equal(r.search_top3.estimated + r.search_code.estimated + r.search_near.estimated, 0, `${r.id}: every leg is in the walking table`);
  }
  assert.equal(ss.top3.found_n + ss.top3.miss_n, rows.length);
  assert.equal(ss.list.code_faster.length + ss.list.same.length + ss.list.near_faster.length, ss.list.found_n);
  assert.equal(ss.estimated_pairs, 0);
});

test("made-up time to found: every case has one, labelled as invented, and it fits the case's own timeline", () => {
  const f = foundSummary(rows);
  for (const s of data.scenarios) {
    const r = rows.find((x) => x.id === s.id);
    assert.ok(["보호자", "시민 제보", "경찰"].includes(s.found.by), `${s.id} by`);
    assert.ok(s.found.how.length > 10, `${s.id} how`);
    for (const banned of ["확률", "예측", "AI가 추천"]) assert.ok(!s.found.how.includes(banned), `${s.id} ${banned}`);
    // 찾기 시작하기도 전에 발견될 수는 없다
    assert.ok(s.found.after_min >= r.left_ago_min, `${s.id}: found before the search started`);
    // 보호자가 3곳을 돌아 찾은 사례는, 집에서 걸어가는 시간(계산)보다 빨리 찾을 수 없다
    if (r.hit3 && s.found.by === "보호자") assert.ok(s.found.after_min >= r.left_ago_min + r.search_top3.minutes, `${s.id}: faster than walking there`);
  }
  assert.equal(f.within_60 + f.within_120 + f.over_120, rows.length);
  assert.equal(Object.values(f.by_who).reduce((n, v) => n + v.n, 0), rows.length);
  assert.equal(Object.values(f.by_hit3).reduce((n, v) => n + v.n, 0), rows.length);
  // 화면과 문서는 이 값이 지어낸 것이고 앱의 효과가 아니라고 밝힌다
  const pub = publicJson(data, rows, summarize(rows));
  assert.match(pub.found_time.note, /지어내/);
  assert.match(pub.found_time.caveat, /앱의 효과를 잰 것이 아닙니다/);
  assert.match(renderDoc(data, rows, summarize(rows)), /발견까지 걸린 시간 \(사례에서 정한 값 — 지어낸 것\)/);
  assert.equal(hm(95), "1시간 35분");
  assert.equal(hm(120), "2시간");
  assert.equal(hm(45), "45분");
});
