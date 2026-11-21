// 꾸민 사례(data/scenarios_dongmyeong.json) 20개를 실제 코드에 넣어 "확인할 곳 3곳"이 어떻게 나오는지 세어 본다.
//   node scripts/run_scenarios.js            → docs/시나리오_동명중_결과.md 와 public/data/scenario_results.json(화면 /scenarios 용)을 다시 쓴다
//   node scripts/run_scenarios.js --json     → 결과를 JSON 으로 출력만 (파일을 쓰지 않음)
//
// 실제 코드 그대로: public/js/candidates.js 의 computeCandidates (화면 📍 예상 후보지 카드와 같은 함수).
// 바꿔 끼운 것 (네트워크가 필요한 부분만):
//   - 장소 이름 → 좌표: 네이버 검색 대신 사례 파일의 places 표 (OpenStreetMap 좌표)
//   - 기본 장소(버스정류장·편의점·공원·경로당): 네이버 검색 대신 사례 파일의 basic_pool (경로당은 자료가 없어 비어 있음)
//   - 생성형 AI: 부르지 않는다 → 순서와 이유는 전부 코드(fallbackOrder·codeReason). AI가 순서를 바꾸는 경우는 여기 없다.
//   - 서버의 "자주 머문 곳"(30일 GPS): 없음. 사례의 등록 장소만 쓴다.
// 목걸이 GPS 동선은 사례 파일의 routes(집 → 목적지 실제 도보 경로, Valhalla 보행자)를 따라 10초마다 한 점씩 만든다.
// 찾는 데 걸리는 시간은 사례 파일의 walk(장소 사이 실제 도보 거리표)로 계산한다 — 실제로 잰 시간이 아니다.
// 발견 장소는 사례를 만든 사람이 정했다. 그러니 여기 숫자는 실제 실종에서의 성능이 아니라 "이 사례들에서 코드가 어떻게 움직였나"이다.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { computeCandidates, pointsToday, buildPlaces, headline } from "../public/js/candidates.js";
import { candidateFeatures, fallbackOrder } from "../public/lib/predict.js";
import { distM } from "../public/lib/gps.js";
import { BASIC_KINDS, WALK_SPEED } from "../public/lib/schema.js";

// 사례의 시각은 한국 시각이다. 다른 시간대의 컴퓨터에서 돌려도 "오늘" 판정과 문서의 HH:MM 이 같게 나오도록 고정한다.
process.env.TZ = "Asia/Seoul";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_PATH = path.join(root, "data", "scenarios_dongmyeong.json");
export const DOC_PATH = path.join(root, "docs", "시나리오_동명중_결과.md");
/** 사이트 화면 /scenarios 가 읽는 결과 (public/ 아래라야 배포된다) */
export const PUBLIC_PATH = path.join(root, "public", "data", "scenario_results.json");

/** 발견 장소에서 이 거리 안의 후보는 "같은 곳"으로 센다 (건물 하나·교차로 하나 크기) */
export const NEAR_M = 150;
/** 사례가 말이 되는지 볼 때 쓰는 가장 빠른 걸음 (schema.js WALK_SPEED.fast) */
const FASTEST_MPS = WALK_SPEED.fast;

const R = 6371000, rad = (x) => (x * Math.PI) / 180, deg = (x) => (x * 180) / Math.PI;
const bearing = (a, b) => { const f1 = rad(a.lat), f2 = rad(b.lat), dl = rad(b.lng - a.lng); return (deg(Math.atan2(Math.sin(dl) * Math.cos(f2), Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl))) + 360) % 360; };
function destination(p, brg, d) {
  const a = d / R, th = rad(brg), f1 = rad(p.lat), l1 = rad(p.lng);
  const f2 = Math.asin(Math.sin(f1) * Math.cos(a) + Math.cos(f1) * Math.sin(a) * Math.cos(th));
  return { lat: deg(f2), lng: deg(l1 + Math.atan2(Math.sin(th) * Math.sin(a) * Math.cos(f1), Math.cos(a) - Math.sin(f1) * Math.sin(f2))) };
}

export function loadData(file = DATA_PATH) { return JSON.parse(fs.readFileSync(file, "utf8")); }

// ---------------------------------------------------------------- 찾는 데 걸리는 시간 (계산)
// 보호자 한 사람이 집에서 출발해 확인할 곳을 차례로 걸어서 돈다고 두고, 발견 장소에 닿을 때까지의 시간을 센다.
// 정한 값 (근거 있는 숫자가 아니라 계산을 위한 가정 — 문서와 화면에 그대로 적는다):
/** 보호자의 걸음: schema.js 의 "빠름"(1.2m/s, 시속 4.3km) */
export const GUARDIAN_MPS = WALK_SPEED.fast;
/** 한 곳에 도착해 둘러보는 시간(분). 발견 장소에서는 세지 않는다 */
export const LOOK_MIN = 2;
/** 도보 거리표에 없는 쌍은 직선거리에 이 값을 곱해 대신한다 (받아 둔 도보 경로 13개의 길이 ÷ 직선거리의 가운데 값) */
export const DETOUR = 1.45;

const walkCache = new WeakMap();
/** 두 점 사이 걷는 거리(m). 사례 파일의 walk(Valhalla 보행자 거리표)에서 찾고, 없으면 직선 × DETOUR. 반환 { m, estimated } */
export function walkBetween(data, a, b) {
  let idx = walkCache.get(data);
  if (!idx) { idx = new Map((data.walk?.points ?? []).map((p, i) => [`${p.lat.toFixed(6)},${p.lng.toFixed(6)}`, i])); walkCache.set(data, idx); }
  const i = idx.get(`${a.lat.toFixed(6)},${a.lng.toFixed(6)}`), j = idx.get(`${b.lat.toFixed(6)},${b.lng.toFixed(6)}`);
  const v = i !== undefined && j !== undefined ? data.walk.m[i][j] : null;
  return v === null || v === undefined ? { m: Math.round(distM(a, b) * DETOUR), estimated: true } : { m: v, estimated: false };
}
/**
 * 집에서 출발해 order 순서로 돈다. 발견 장소에서 NEAR_M 안의 곳에 도착하면 찾은 것.
 * @returns {{found:boolean, minutes:number, stops:number, estimated:number}} minutes = 찾을 때까지(못 찾으면 다 돌 때까지), stops = 들른 곳 수
 */
export function searchWalk(data, order, found) {
  let pos = data.home, min = 0, estimated = 0;
  for (let k = 0; k < order.length; k++) {
    const w = walkBetween(data, pos, order[k]);
    if (w.estimated) estimated++;
    min += w.m / GUARDIAN_MPS / 60;
    if (distM(order[k], found) <= NEAR_M) return { found: true, minutes: Math.round(min), stops: k + 1, estimated };
    min += LOOK_MIN; pos = order[k];
  }
  return { found: false, minutes: Math.round(min), stops: order.length, estimated };
}
/** 같은 곳들을 "지금 있는 곳에서 가장 가까운 곳부터" 도는 순서 (걷는 거리 기준) */
export function nearestFirst(data, places) {
  const left = [...places], out = []; let pos = data.home;
  while (left.length) {
    let best = 0, bd = Infinity;
    left.forEach((p, k) => { const d = walkBetween(data, pos, p).m; if (d < bd) { bd = d; best = k; } });
    pos = left.splice(best, 1)[0]; out.push(pos);
  }
  return out;
}

/** 꺾은선 shape([[lat,lng],...])를 처음부터 d(m)만큼 따라간 점. 끝을 넘으면 { ...끝점, arrived:true } */
export function alongRoute(shape, d) {
  let left = d;
  for (let i = 1; i < shape.length; i++) {
    const a = { lat: shape[i - 1][0], lng: shape[i - 1][1] }, b = { lat: shape[i][0], lng: shape[i][1] };
    const seg = distM(a, b);
    if (left <= seg) return seg > 0 ? destination(a, bearing(a, b), left) : a;
    left -= seg;
  }
  const end = shape[shape.length - 1];
  return { lat: end[0], lng: end[1], arrived: true };
}

/**
 * 사례의 gps.legs → 목걸이가 10초마다 보낸 점. 집에서 목적지까지 **실제 도보 경로**(사례 파일의 routes, Valhalla 보행자 경로)를 따라 걷는다.
 * leg = { toward:"장소 이름", min, kmh } (min 분 동안 걷는다. 그 전에 도착하면 거기서 끝) 또는 { stay_min } (그 자리에 머묾)
 * 걷는 leg 는 집에서 출발하는 첫 leg 하나만 쓴다 (경로를 집 → 목적지로만 받아 두었다).
 * 마지막 점의 시각이 cutMs(목걸이 GPS가 끊긴 때)가 되게 맞춘다. 반환: /api/loc latest 와 같은 모양 [{gps_time, lat, lng, speed_kmh}]
 */
export function buildTrail(home, legs, cutMs, routes) {
  let pos = { lat: home.lat, lng: home.lng }, sec = 0, walked = false;
  const rel = [{ sec: 0, ...pos, speed_kmh: legs[0]?.kmh ?? 0 }];
  for (const leg of legs) {
    if (leg.stay_min) {
      for (let i = 0; i < leg.stay_min * 6; i++) { sec += 10; rel.push({ sec, ...pos, speed_kmh: 0.2 }); }
      continue;
    }
    const shape = routes?.[leg.toward]?.shape;
    if (!shape) throw new Error(`도보 경로 없음: ${leg.toward}`);
    if (walked) throw new Error("걷는 leg 는 집에서 출발하는 하나만 쓸 수 있다");
    walked = true;
    const step = (leg.kmh / 3.6) * 10;
    for (let i = 1; i <= leg.min * 6; i++) {
      const p = alongRoute(shape, step * i);
      pos = { lat: p.lat, lng: p.lng }; sec += 10;
      rel.push({ sec, ...pos, speed_kmh: leg.kmh });
      if (p.arrived) break;
    }
  }
  const t0 = cutMs - sec * 1000;
  return rel.map((p) => ({ gps_time: new Date(t0 + p.sec * 1000).toISOString(), lat: +p.lat.toFixed(6), lng: +p.lng.toFixed(6), speed_kmh: p.speed_kmh }));
}

/** 사례 하나를 실제 코드에 넣는다 */
export async function runScenario(s, data) {
  const { home, places, basic_pool, routes } = data;
  const nowMs = Date.parse(s.now);
  const found = { name: s.found.place, ...places[s.found.place] };
  if (!Number.isFinite(found.lat)) throw new Error(`${s.id}: 발견 장소 없음 ${s.found.place}`);
  const raw = s.gps ? buildTrail(home, s.gps.legs, nowMs - s.gps.since_cut_min * 60000, routes) : [];
  const points = pointsToday(raw, nowMs);

  // 화면이 넘기는 것과 같은 입력
  const profile = { honorific: s.honorific, places: s.registered.map((p) => ({ ...p })) };   // 좌표 없이 이름만 — 좌표는 아래 검색 대역이 채운다
  const clue = { honorific: s.honorific, today_destination: s.clue.today_destination, direction: s.clue.direction, memory_places: [] };
  const elapsedMin = s.gps ? null : s.elapsed_min;
  const mode = { gait: s.gait, elapsedMin, started_at: s.now };
  const findPlaceLoose = async (name) => (places[name] ? { lat: places[name].lat, lng: places[name].lng } : null);
  const findNearby = async (kind, center, radiusM, n) => basic_pool.filter((p) => p.kind === kind)
    .map((p) => ({ found_name: p.name, lat: p.lat, lng: p.lng, d: distM(center, p) })).filter((p) => p.d <= radiusM)
    .sort((a, b) => a.d - b.d).slice(0, n);

  const res = await computeCandidates({ points, clue, mode, home, profile, elderId: null, nowMs, findPlaceLoose, findNearby });
  const top = (res.top ?? []).map((c) => ({ name: c.name, source: c.source, reason: c.reason, to_found_m: Math.round(distM(c, found)) }));

  // 전체 순서(3곳 뒤까지): 같은 입력으로 코드 순서를 다시 만든다 — 발견 장소가 목록의 몇 번째였는지 보려고
  let order = [];
  if (res.motion && res.status === "ok") {
    const end = res.path?.length ? res.path[res.path.length - 1] : res.motion;
    const memory = profile.places.map((p) => ({ ...p, ...(places[p.name] ? { lat: places[p.name].lat, lng: places[p.name].lng } : {}) }));
    const basic = (await Promise.all(BASIC_KINDS.map(async (kind) => (await findNearby(kind, end, 500, 1)).map((x) => ({ ...x, kindOf: kind }))))).flat();
    order = fallbackOrder(candidateFeatures(res.motion, nowMs, buildPlaces({ memory, frequent: [], basic, home })));
  }
  const rankIdx = order.findIndex((c) => distM(c, found) <= NEAR_M);

  // 발견 장소 자체의 숫자 (후보인 것처럼 넣어 같은 계산을 받는다)
  const origin = res.motion ?? { lat: home.lat, lng: home.lng };
  const [ff] = res.motion ? candidateFeatures(res.motion, nowMs, [{ id: "found", name: found.name, source: "guardian", lat: found.lat, lng: found.lng }]) : [];
  const sinceMin = s.gps ? s.gps.since_cut_min : s.elapsed_min;
  const lastToFound = Math.round(distM(origin, found));

  return {
    id: s.id, type: s.type, title: s.title, has_gps: !!s.gps, minutes: sinceMin,
    status: res.status, state: res.motion?.state ?? "none", headline: res.motion ? headline(res.motion, nowMs) : "",
    found: found.name, found_registered: s.registered.some((p) => p.name === found.name),
    // 사례의 끝 — 지어낸 값: 나가신 뒤 몇 분 만에, 누가, 어떻게 찾았나
    found_after_min: s.found.after_min, found_by: s.found.by, found_how: s.found.how,
    top, order_names: order.map((c) => c.name),
    order_points: order.map((c) => ({ name: c.name, lat: c.lat, lng: c.lng })), found_point: { name: found.name, lat: found.lat, lng: found.lng },
    // 찾는 데 걸리는 시간(계산): 화면에 나온 3곳을 그 순서로 / 코드가 본 모든 곳을 코드 순서로 / 같은 곳들을 가까운 곳부터
    search_top3: searchWalk(data, order.slice(0, 3), found),
    search_code: searchWalk(data, order, found),
    search_near: searchWalk(data, nearestFirst(data, order), found),
    // 어르신이 나가신 뒤 보호자가 찾기 시작할 때까지 지난 시간(분)
    left_ago_min: s.gps ? Math.round((nowMs - (points[0]?.t ?? nowMs)) / 60000) : s.elapsed_min,
    hit1: top.length > 0 && top[0].to_found_m <= NEAR_M,
    hit3: top.some((c) => c.to_found_m <= NEAR_M),
    rank: rankIdx < 0 ? null : rankIdx + 1, list_size: order.length,
    nearest_top_m: top.length ? Math.min(...top.map((c) => c.to_found_m)) : null,
    last_to_found_m: lastToFound,
    reach_m: Math.round(res.reach ?? 0), found_in_reach: ff ? ff.reachable : lastToFound <= (res.reach ?? 0),
    found_bearing_diff_deg: ff?.bearing_diff_deg ?? null, found_path_dist_m: ff?.path_dist_m ?? null,
    // 사례가 말이 되는지: 가장 빠른 걸음으로도 그 시간 안에 갈 수 있는 거리인가
    possible: lastToFound <= sinceMin * 60 * FASTEST_MPS,
    points: points.length,
    cut_from_home_m: points.length ? Math.round(distM(home, points[points.length - 1])) : null,
    // GPS가 끊길 때 걷던 길의 방향이, 가던 목적지 방향과 얼마나 달랐나 (길이 굽어 있으면 커진다)
    heading_off_target_deg: s.gps && res.motion?.state === "moving_lost" && places[s.gps.legs[0].toward]
      ? Math.round(Math.abs((((res.motion.bearingDeg - bearing(res.motion, places[s.gps.legs[0].toward])) % 360) + 540) % 360 - 180)) : null,
  };
}

export async function runAll(data = loadData()) {
  const rows = [];
  for (const s of data.scenarios) rows.push(await runScenario(s, data));
  return rows;
}

// ---------------------------------------------------------------- 통계
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };
export function summarize(rows) {
  const part = (list) => ({
    n: list.length,
    hit1: list.filter((r) => r.hit1).length,
    hit3: list.filter((r) => r.hit3).length,
    in_list: list.filter((r) => r.rank !== null).length,
    in_reach: list.filter((r) => r.found_in_reach).length,
    median_nearest_m: median(list.filter((r) => r.nearest_top_m !== null).map((r) => r.nearest_top_m)),
    median_last_to_found_m: median(list.map((r) => r.last_to_found_m)),
  });
  const by = (key) => Object.fromEntries([...new Set(rows.map(key))].sort().map((k) => [k, part(rows.filter((r) => key(r) === k))]));
  return {
    all: part(rows),
    by_type: by((r) => r.type),
    by_gps: by((r) => (r.has_gps ? "목걸이 GPS 있음" : "GPS 없음 (보호자 말만)")),
    by_registered: by((r) => (r.found_registered ? "발견 장소가 등록된 곳" : "발견 장소가 등록 안 된 곳")),
    by_state: by((r) => ({ moving_lost: "움직이다 끊김", stayed: "한곳에 머묾", none: "방향 모름" }[r.state] ?? r.state)),
  };
}

/** 찾는 데 걸리는 시간 묶음 */
export function searchSummary(rows) {
  const hit = rows.filter((r) => r.search_top3.found), miss = rows.filter((r) => !r.search_top3.found);
  const inList = rows.filter((r) => r.search_code.found);
  const mins = (list, key) => list.map((r) => r[key].minutes);
  return {
    top3: {
      found_n: hit.length, median_min: median(mins(hit, "search_top3")), max_min: hit.length ? Math.max(...mins(hit, "search_top3")) : null,
      median_total_min: median(hit.map((r) => r.left_ago_min + r.search_top3.minutes)),
      miss_n: miss.length, median_spent_min: median(mins(miss, "search_top3")),
    },
    list: {
      found_n: inList.length, code_median_min: median(mins(inList, "search_code")), near_median_min: median(mins(inList, "search_near")),
      code_faster: inList.filter((r) => r.search_code.minutes < r.search_near.minutes).map((r) => r.id),
      same: inList.filter((r) => r.search_code.minutes === r.search_near.minutes).map((r) => r.id),
      near_faster: inList.filter((r) => r.search_code.minutes > r.search_near.minutes).map((r) => r.id),
    },
    estimated_pairs: rows.reduce((n, r) => n + r.search_top3.estimated + r.search_code.estimated + r.search_near.estimated, 0),
  };
}
const kmh = (GUARDIAN_MPS * 3.6).toFixed(1);

/** "95분" → "1시간 35분" */
export const hm = (min) => (min === null || min === undefined ? "–" : min < 60 ? `${min}분` : `${Math.floor(min / 60)}시간${min % 60 ? ` ${min % 60}분` : ""}`);
/**
 * 사례에서 정한 발견 시간(지어낸 값)을 센 것. 재거나 계산한 것이 아니라 사례를 만든 사람이 적은 숫자다 —
 * 그러니 이것은 "사례 20개가 어떻게 꾸며져 있나"의 요약이지 실제 실종의 통계가 아니다.
 */
export function foundSummary(rows) {
  const part = (list) => ({ n: list.length, median_min: median(list.map((r) => r.found_after_min)), min_min: list.length ? Math.min(...list.map((r) => r.found_after_min)) : null, max_min: list.length ? Math.max(...list.map((r) => r.found_after_min)) : null });
  const by = (key, order) => Object.fromEntries((order ?? [...new Set(rows.map(key))].sort()).map((k) => [k, part(rows.filter((r) => key(r) === k))]).filter(([, v]) => v.n));
  return {
    all: part(rows),
    within_60: rows.filter((r) => r.found_after_min <= 60).length,
    within_120: rows.filter((r) => r.found_after_min > 60 && r.found_after_min <= 120).length,
    over_120: rows.filter((r) => r.found_after_min > 120).length,
    by_who: by((r) => r.found_by, ["보호자", "시민 제보", "경찰"]),
    by_type: by((r) => r.type),
    by_hit3: by((r) => (r.hit3 ? "확인할 곳 3곳 안에 발견 장소가 있던 사례" : "3곳 안에 없던 사례"), ["확인할 곳 3곳 안에 발견 장소가 있던 사례", "3곳 안에 없던 사례"]),
  };
}

// ---------------------------------------------------------------- 문서
const fmt = (m) => (m === null || m === undefined ? "–" : m >= 1000 ? `${(m / 1000).toFixed(1)}km` : `${m}m`);
const yn = (b) => (b ? "○" : "×");
export function renderDoc(data, rows, sum) {
  const L = [];
  const p = (s = "") => L.push(s);
  p("# 동명중학교를 집으로 둔 꾸민 사례 20개 — 확인할 곳 3곳 결과");
  p();
  p("> 이 문서는 `node scripts/run_scenarios.js` 가 만든다. 손으로 고치지 말고 사례 파일(`data/scenarios_dongmyeong.json`)을 고친 뒤 다시 돌린다.");
  p();
  p("## 먼저 읽을 것");
  p();
  p("- **사람·사건·보호자의 말은 모두 지어낸 것이다.** 실제 인물도, 실제 실종도 아니다. 집을 대전 동명중학교로 둔 것도 가정이다.");
  p(`- **장소만 실제다.** 이름과 좌표는 ${data.source.map}에서 가져왔다 (${data.source.fetched} 조회). 사례에 쓴 곳 ${Object.keys(data.places).length}곳, 기본 장소 풀 ${data.basic_pool.length}곳.`);
  p("- **발견 장소는 사례를 만든 사람이 정했다.** 그래서 아래 숫자는 실제 실종에서 얼마나 잘 찾는지가 아니다. \"이런 상황을 넣으면 코드가 무엇을 내놓는가\"를 보여 줄 뿐이다. 발표에서 성능 수치로 쓰지 않는다.");
  p("- **실제 코드를 그대로 돌렸다.** 화면의 📍 예상 후보지 카드가 쓰는 `computeCandidates` 다. 생성형 AI는 부르지 않아서 순서와 이유는 전부 코드가 정한 것이다. 장소 좌표와 기본 장소는 네이버 검색 대신 지도 자료로 바꿔 끼웠다.");
  p("- **목걸이 GPS 동선은 실제 길을 따라 걷는다.** 집에서 목적지까지의 도보 경로(앱의 도보 길찾기와 같은 Valhalla 보행자 경로)를 받아 그 길 위를 10초마다 한 점씩 찍었다. 그래서 GPS가 끊긴 순간의 방향은 목적지 방향이 아니라 **그때 걷고 있던 길의 방향**이다.");
  p("- GPS가 끊긴 뒤의 \"예상 경로\"는 앱 코드가 마지막 방향으로 곧게 뻗어 계산한다. 이것은 사례가 아니라 코드의 가정이고, 이 문서가 보려는 것 가운데 하나다.");
  p("- 보호자의 말에서 가려던 곳·방향을 뽑는 일(AI 호출 ①)은 여기서 하지 않고, 사람이 적은 단서를 넣었다.");
  p(`- \"맞음\"의 기준: 확인할 곳이 발견 장소에서 **${NEAR_M}m 안**이면 같은 곳으로 센다.`);
  p();
  p("## 전체");
  p();
  const a = sum.all;
  p("| 무엇 | 결과 |");
  p("|---|---|");
  p(`| 사례 수 | ${a.n}개 |`);
  p(`| 확인할 곳 **첫째**가 발견 장소 | ${a.n}개 중 **${a.hit1}개** |`);
  p(`| 확인할 곳 **3곳 안**에 발견 장소 | ${a.n}개 중 **${a.hit3}개** |`);
  p(`| 3곳 뒤까지 본 전체 목록 안에 발견 장소 | ${a.n}개 중 ${a.in_list}개 |`);
  p(`| 발견 장소가 \"걸어서 닿을 수 있는 범위\" 안 | ${a.n}개 중 ${a.in_reach}개 |`);
  p(`| 3곳 중 발견 장소에 가장 가까운 곳까지 거리 (가운데 값) | ${fmt(a.median_nearest_m)} |`);
  p(`| 마지막 위치(GPS가 없으면 집)에서 발견 장소까지 거리 (가운데 값) | ${fmt(a.median_last_to_found_m)} |`);
  p();
  const table = (title, obj, labelOf = (k) => k) => {
    p(`### ${title}`);
    p();
    p("| 묶음 | 사례 | 첫째가 맞음 | 3곳 안 | 전체 목록 안 | 닿을 수 있는 범위 안 | 가장 가까운 확인할 곳 (가운데 값) |");
    p("|---|---|---|---|---|---|---|");
    for (const [k, v] of Object.entries(obj)) p(`| ${labelOf(k)} | ${v.n} | ${v.hit1} | ${v.hit3} | ${v.in_list} | ${v.in_reach} | ${fmt(v.median_nearest_m)} |`);
    p();
  };
  p("## 묶어서 보기");
  p();
  table("상황별", sum.by_type, (k) => `${k}. ${data.types[k]}`);
  table("목걸이 GPS가 있었나", sum.by_gps);
  table("발견 장소가 등록된 곳이었나", sum.by_registered);
  table("코드가 본 마지막 움직임", sum.by_state);
  p("## 숫자가 말해 주는 것");
  p();
  const regd = sum.by_registered["발견 장소가 등록된 곳"], unreg = sum.by_registered["발견 장소가 등록 안 된 곳"];
  if (regd && unreg) p(`- 발견 장소가 **등록된 곳**이면 ${regd.n}개 중 ${regd.hit3}개가 3곳 안에 들었고, **등록 안 된 곳**이면 ${unreg.n}개 중 ${unreg.hit3}개였다. 코드는 등록된 곳과 그 근처의 기본 장소만 후보로 올리므로, 등록해 두지 않은 곳은 가까운 다른 후보로만 짚을 수 있다.`);
  const tC = sum.by_type.C;
  if (tC) p(`- GPS가 끊긴 뒤 **방향을 바꾼** 사례(C)는 ${tC.n}개 중 ${tC.hit3}개가 3곳 안이었다. 코드는 마지막 방향으로 계속 간다고 두고 계산하기 때문이다.`);
  const bent = rows.filter((r) => r.heading_off_target_deg !== null && r.heading_off_target_deg > 30);
  const moving = rows.filter((r) => r.heading_off_target_deg !== null);
  p(`- 길을 따라 걷다 끊긴 사례 ${moving.length}개 중 ${bent.length}개는, 끊긴 순간 걷던 길의 방향이 가던 목적지 방향과 **30° 넘게** 달랐다${bent.length ? ` (${bent.map((r) => `${r.id} ${r.heading_off_target_deg}°`).join(", ")})` : ""}. 길은 곧지 않아서, 마지막 방향으로 곧게 뻗은 예상 경로가 목적지를 비껴갈 수 있다. 이 가운데 3곳 안에 든 것은 ${bent.filter((r) => r.hit3).length}개, 첫째로 나온 것은 ${bent.filter((r) => r.hit1).length}개다.`);
  const out = rows.filter((r) => !r.found_in_reach);
  p(`- 발견 장소가 \"걸어서 닿을 수 있는 범위\" 밖이었던 사례는 ${out.length}개${out.length ? ` (${out.map((r) => r.id).join(", ")})` : ""}다.`);
  p("- 이 숫자들은 사례를 어떻게 꾸미느냐에 따라 달라진다. 등록된 곳에서 발견되는 사례를 늘리면 올라가고, 줄이면 내려간다. 그래서 비율이 아니라 **어떤 상황에서 맞고 어떤 상황에서 틀리는지**를 보는 자료로 쓴다.");
  p();
  const fs_ = foundSummary(rows);
  p("## 발견까지 걸린 시간 (사례에서 정한 값 — 지어낸 것)");
  p();
  p("사례마다 \"나가신 뒤 몇 분 만에, 누가 찾았다\"를 **지어내 적었다.** 재거나 계산한 값이 아니다. 아래 표는 사례 20개가 어떻게 꾸며져 있는지의 요약이고, 실제 실종의 통계가 아니다.");
  p();
  p("| 무엇 | 사례에서 정한 값 |");
  p("|---|---|");
  p(`| 나가신 뒤 발견까지 (가운데 값) | **${hm(fs_.all.median_min)}** (가장 짧은 사례 ${hm(fs_.all.min_min)}, 가장 긴 사례 ${hm(fs_.all.max_min)}) |`);
  p(`| 1시간 안에 발견 | ${rows.length}개 중 ${fs_.within_60}개 |`);
  p(`| 1시간 넘고 2시간 안에 발견 | ${rows.length}개 중 ${fs_.within_120}개 |`);
  p(`| 2시간 넘어 발견 | ${rows.length}개 중 ${fs_.over_120}개 |`);
  p();
  const ftable = (title, obj, labelOf = (k) => k) => {
    p(`### ${title}`);
    p();
    p("| 묶음 | 사례 | 발견까지 (가운데 값) | 가장 짧은 ~ 가장 긴 |");
    p("|---|---|---|---|");
    for (const [k, v] of Object.entries(obj)) p(`| ${labelOf(k)} | ${v.n} | ${hm(v.median_min)} | ${hm(v.min_min)} ~ ${hm(v.max_min)} |`);
    p();
  };
  ftable("누가 찾았나", fs_.by_who);
  ftable("확인할 곳 3곳 안에 발견 장소가 있었나", fs_.by_hit3);
  ftable("상황별", fs_.by_type, (k) => `${k}. ${data.types[k]}`);
  p("- 3곳 안에 발견 장소가 있던 사례는 \"보호자가 그 순서대로 돌아 찾았다\"로, 없던 사례는 \"더 지나 시민 제보나 경찰이 찾았다\"로 꾸몄다. 그래서 두 묶음의 시간 차이는 **사례를 그렇게 썼기 때문**이지 앱의 효과를 잰 것이 아니다.");
  p("- 보호자가 찾은 사례의 시간은 아래 \"계산\"보다 짧지 않게 맞췄다 (집에서 걸어가는 시간보다 빨리 찾을 수는 없으므로).");
  p();
  const ss = searchSummary(rows);
  p("## 찾는 데 걸리는 시간 (계산)");
  p();
  p("실제로 잰 시간이 아니라 **계산한 시간**이다. 이렇게 두었다:");
  p();
  p(`- 보호자 **한 사람**이 찾기 시작한 때 **집에서 출발**해, 확인할 곳을 차례로 **걸어서** 돈다. 걸음은 시속 ${kmh}km (\`schema.js\` 의 \"빠름\").`);
  p(`- 곳마다 **${LOOK_MIN}분** 둘러본다. 발견 장소에서 ${NEAR_M}m 안의 곳에 도착하면 찾은 것으로 센다.`);
  p("- 걷는 거리는 직선이 아니라 **실제 도보 거리**다 (앱의 걷는 거리 계산과 같은 Valhalla 보행자 거리표).");
  p("- 어르신은 발견 장소에 **그대로 계신다**고 둔다. 경찰·가족 여럿이 나눠 찾거나 차를 타는 경우는 넣지 않았다. 실제로는 112 신고가 먼저다.");
  p();
  p("### 화면에 나온 3곳을 그 순서대로 돌았을 때");
  p();
  p("| 무엇 | 결과 |");
  p("|---|---|");
  p(`| 3곳 안에서 찾은 사례 | ${rows.length}개 중 ${ss.top3.found_n}개 |`);
  p(`| 그 사례들에서 찾기 시작한 뒤 발견까지 (가운데 값) | **${ss.top3.median_min}분** (가장 오래 걸린 사례 ${ss.top3.max_min}분) |`);
  p(`| 어르신이 나가신 때부터 발견까지 (가운데 값) | ${ss.top3.median_total_min}분 |`);
  p(`| 3곳을 다 돌고도 못 찾은 사례 | ${ss.top3.miss_n}개 — 3곳을 도는 데 가운데 값 ${ss.top3.median_spent_min}분을 썼다 |`);
  p();
  p("### 코드 순서와 \"가까운 곳부터\"를 견주면");
  p();
  p(`코드가 본 모든 곳(등록한 곳 + 기본 장소) 안에 발견 장소가 있던 ${ss.list.found_n}개 사례에서, 같은 곳들을 **코드 순서**로 돌 때와 **지금 있는 곳에서 가장 가까운 곳부터** 돌 때를 견주었다.`);
  p();
  p("| 도는 순서 | 발견까지 (가운데 값) |");
  p("|---|---|");
  p(`| 코드 순서 | ${ss.list.code_median_min}분 |`);
  p(`| 가까운 곳부터 | ${ss.list.near_median_min}분 |`);
  p();
  p(`- 코드 순서가 더 빨랐던 사례: ${ss.list.code_faster.length}개${ss.list.code_faster.length ? ` (${ss.list.code_faster.join(", ")})` : ""}`);
  p(`- 같았던 사례: ${ss.list.same.length}개${ss.list.same.length ? ` (${ss.list.same.join(", ")})` : ""}`);
  p(`- 가까운 곳부터가 더 빨랐던 사례: ${ss.list.near_faster.length}개${ss.list.near_faster.length ? ` (${ss.list.near_faster.join(", ")})` : ""}`);
  p("- 코드 순서는 \"가던 방향의 예상 경로에 가까운 곳\"을 앞에 둔다. 발견 장소가 그 방향에 있으면 빨라지고, 길이 굽어 방향이 어긋났거나 어르신이 방향을 바꿨으면 먼 곳부터 들르게 되어 느려진다.");
  if (ss.estimated_pairs) p(`- 도보 거리표에 없어 직선거리 × ${DETOUR}로 대신한 구간이 ${ss.estimated_pairs}개 있다.`);
  p();
  p("## 사례별 결과");
  p();
  p("| 사례 | 상황 | 코드가 본 움직임 | 확인할 곳 3곳 (발견 장소까지) | 발견 장소 | 등록 | 첫째 | 3곳 | 목록 순서 | 3곳 순서대로 | 코드 순서 | 가까운 곳부터 |");
  p("|---|---|---|---|---|---|---|---|---|---|---|---|");
  const st = (x) => (x.found ? `${x.minutes}분 (${x.stops}곳째)` : `못 찾음 (${x.minutes}분 씀)`);
  for (const r of rows) {
    const tops = r.top.map((c, i) => `${i + 1}. ${c.name} (${fmt(c.to_found_m)})`).join("<br>") || "–";
    p(`| ${r.id} | ${r.type} | ${r.headline || "–"} | ${tops} | ${r.found} | ${yn(r.found_registered)} | ${yn(r.hit1)} | ${yn(r.hit3)} | ${r.rank === null ? "없음" : `${r.rank}/${r.list_size}`} | ${st(r.search_top3)} | ${st(r.search_code)} | ${st(r.search_near)} |`);
  }
  p();
  p("## 사례 20개 (보호자의 말은 꾸민 것)");
  p();
  for (const s of data.scenarios) {
    const r = rows.find((x) => x.id === s.id);
    p(`### ${s.id}. ${s.title}`);
    p();
    p(`- **상황:** ${s.type}. ${data.types[s.type]} — ${s.design}`);
    p(`- **보호자의 말:** \"${s.utterance}\"`);
    p(`- **등록해 둔 곳:** ${s.registered.map((x) => `${x.name}(${{ memory: "추억의 장소", frequent: "자주 가는 곳", guardian: "보호자가 말한 곳" }[x.source] ?? x.source})`).join(", ")}`);
    p(`- **목걸이 GPS:** ${s.gps ? `${s.gps.legs.map((l) => (l.stay_min ? `${l.stay_min}분 머묾` : `${l.toward} 가는 길(걸어서 ${fmt(data.routes[l.toward].m)})을 따라 시속 ${l.kmh}km로 최대 ${l.min}분`)).join(" → ")} 뒤 끊김 — 집에서 직선 ${fmt(r.cut_from_home_m)} 지점, 그 뒤 ${s.gps.since_cut_min}분 지남` : `없음 (나가신 지 ${s.elapsed_min}분)`}`);
    p(`- **코드가 본 것:** ${r.headline || "–"}`);
    p(`- **확인할 곳 3곳:** ${r.top.map((c, i) => `${i + 1}) ${c.name} — ${c.reason}`).join(" / ") || "없음"}`);
    p(`- **발견 장소:** ${r.found} — 마지막 위치에서 ${fmt(r.last_to_found_m)}, 닿을 수 있는 범위(${fmt(r.reach_m)}) ${r.found_in_reach ? "안" : "밖"}${r.found_bearing_diff_deg !== null ? `, 가던 방향과 ${r.found_bearing_diff_deg}° 차이` : ""}${r.found_path_dist_m !== null ? `, 예상 경로에서 ${fmt(r.found_path_dist_m)}` : ""}`);
    p(`- **결과:** 첫째 ${yn(r.hit1)} · 3곳 안 ${yn(r.hit3)} · 가장 가까운 확인할 곳까지 ${fmt(r.nearest_top_m)}`);
    p(`- **사례의 끝 (지어낸 것):** 나가신 뒤 ${hm(r.found_after_min)} 만에 발견 — ${r.found_by}: ${r.found_how}`);
    p(`- **찾는 데 걸리는 시간(계산):** 나가신 지 ${r.left_ago_min}분 뒤에 찾기 시작 → 3곳을 순서대로 돌면 ${r.search_top3.found ? `${r.search_top3.minutes}분 뒤 ${r.search_top3.stops}곳째에서 발견` : `${r.search_top3.minutes}분을 쓰고도 못 찾음`}`);
    p();
  }
  p("## 사례에 쓴 실제 장소");
  p();
  p("| 장소 | 종류 | 집(동명중학교)에서 직선 | 걸어서 (도보 경로를 받은 곳만) |");
  p("|---|---|---|---|");
  for (const [name, v] of Object.entries(data.places).sort((x, y) => x[1].from_home_m - y[1].from_home_m)) p(`| ${name} | ${v.kind} | ${fmt(v.from_home_m)} | ${data.routes[name] ? fmt(data.routes[name].m) : "–"} |`);
  p();
  p(`지도 자료: ${data.source.map}. ${data.source.routes}. ${data.source.walk}. ${data.source.missing}.`);
  p();
  return L.join("\n");
}

// ---------------------------------------------------------------- 화면(/scenarios)이 읽는 자료
const SOURCE_KO = { memory: "추억의 장소", frequent: "자주 가는 곳", guardian: "보호자가 말한 곳", basic: "기본 장소" };
/** public/data/scenario_results.json 에 쓸 내용. 화면 글이라 존댓말. 기본 장소 풀·도보 경로 좌표 같은 큰 자료는 넣지 않는다 */
export function publicJson(data, rows, sum) {
  const regd = sum.by_registered["발견 장소가 등록된 곳"], unreg = sum.by_registered["발견 장소가 등록 안 된 곳"], tC = sum.by_type.C;
  const noGps = sum.by_gps["GPS 없음 (보호자 말만)"];
  const moving = rows.filter((r) => r.heading_off_target_deg !== null), bent = moving.filter((r) => r.heading_off_target_deg > 30);
  const insights = [];
  if (regd && unreg) insights.push(`발견 장소를 미리 등록해 둔 사례는 ${regd.n}개 중 ${regd.hit3}개가 3곳 안에 들었고, 등록해 두지 않은 사례는 ${unreg.n}개 중 ${unreg.hit3}개였습니다. 코드는 등록된 곳과 그 근처의 기본 장소만 확인할 곳으로 올립니다.`);
  if (noGps) insights.push(`목걸이·휴대폰을 두고 나가셔서 보호자의 말만 있는 사례는 ${noGps.n}개 중 ${noGps.hit3}개가 3곳 안이었습니다.`);
  if (tC) insights.push(`GPS가 끊긴 뒤 방향을 바꾼 사례는 ${tC.n}개 중 ${tC.hit3}개가 3곳 안이었습니다. 코드는 마지막 방향으로 계속 간다고 두고 계산합니다.`);
  insights.push(`길을 따라 걷다 끊긴 사례 ${moving.length}개 중 ${bent.length}개는 끊긴 순간의 길 방향이 가던 목적지 방향과 30° 넘게 달랐습니다. 길은 곧지 않아서, 곧게 뻗은 예상 경로가 목적지를 비껴갈 수 있습니다.`);
  const ss = searchSummary(rows);
  const group = (obj, labelOf = (k) => k) => Object.entries(obj).map(([k, v]) => ({ label: labelOf(k), n: v.n, hit1: v.hit1, hit3: v.hit3 }));
  return {
    title: "동명중학교를 집으로 둔 꾸민 사례 20개",
    made_up: true,
    note: "사람·사건·보호자의 말은 모두 지어낸 것입니다. 장소와 걷는 길만 실제 지도에서 가져왔습니다. 발견 장소와 발견까지 걸린 시간도 사례를 만든 사람이 정했으므로, 이 숫자는 실제 실종에서의 성능이 아닙니다.",
    how: ["화면의 예상 후보지 카드가 쓰는 코드를 그대로 돌렸습니다. 생성형 AI는 부르지 않아 순서와 이유는 모두 코드가 정했습니다.",
      "목걸이 GPS 동선은 집에서 목적지까지의 실제 도보 경로를 따라 10초마다 한 점씩 만들었습니다.",
      `확인할 곳이 발견 장소에서 ${NEAR_M}m 안이면 같은 곳으로 셌습니다.`,
      "보호자의 말에서 단서를 뽑는 일은 하지 않고, 사람이 적은 단서를 넣었습니다."],
    source: `지도 자료: ${data.source.map}, ${data.source.fetched} 조회. 걷는 길: Valhalla 보행자 경로. 경로당은 지도 자료에 없어 기본 장소에서 빠져 있습니다.`,
    near_m: NEAR_M,
    total: { n: sum.all.n, hit1: sum.all.hit1, hit3: sum.all.hit3, in_reach: sum.all.in_reach, median_nearest_m: sum.all.median_nearest_m },
    groups: [
      { title: "상황별", rows: group(sum.by_type, (k) => `${k}. ${data.types[k]}`) },
      { title: "목걸이 GPS가 있었나", rows: group(sum.by_gps) },
      { title: "발견 장소가 등록된 곳이었나", rows: group(sum.by_registered) },
    ],
    insights,
    found_time: (() => {
      const f = foundSummary(rows);
      const rowsOf = (obj, labelOf = (k) => k) => Object.entries(obj).map(([k, v]) => ({ label: labelOf(k), n: v.n, median: hm(v.median_min), range: `${hm(v.min_min)} ~ ${hm(v.max_min)}`, median_min: v.median_min }));
      return {
        note: "사례마다 \"나가신 뒤 몇 분 만에, 누가 찾았다\"를 지어내 적은 값입니다. 재거나 계산한 것이 아니고, 실제 실종의 통계가 아닙니다.",
        median: hm(f.all.median_min), shortest: hm(f.all.min_min), longest: hm(f.all.max_min), max_min: f.all.max_min,
        within_60: f.within_60, within_120: f.within_120, over_120: f.over_120, n: rows.length,
        groups: [
          { title: "누가 찾았나", rows: rowsOf(f.by_who) },
          { title: "확인할 곳 3곳 안에 발견 장소가 있었나", rows: rowsOf(f.by_hit3) },
          { title: "상황별", rows: rowsOf(f.by_type, (k) => `${k}. ${data.types[k]}`) },
        ],
        caveat: "3곳 안에 발견 장소가 있던 사례는 \"보호자가 그 순서대로 돌아 찾았다\"로, 없던 사례는 \"더 지나 시민 제보나 경찰이 찾았다\"로 꾸몄습니다. 두 묶음의 시간 차이는 사례를 그렇게 썼기 때문이고, 앱의 효과를 잰 것이 아닙니다.",
      };
    })(),
    search: {
      assumptions: [
        `보호자 한 분이 찾기 시작한 때 집에서 출발해, 확인할 곳을 차례로 걸어서 돈다고 두었습니다 (시속 ${kmh}km).`,
        `곳마다 ${LOOK_MIN}분 둘러보고, 발견 장소에서 ${NEAR_M}m 안의 곳에 도착하면 찾은 것으로 셌습니다.`,
        "걷는 거리는 직선이 아니라 실제 도보 거리입니다.",
        "어르신은 발견 장소에 그대로 계신다고 두었습니다. 여럿이 나눠 찾거나 차를 타는 경우는 넣지 않았습니다. 실제로는 112 신고가 먼저입니다.",
      ],
      top3: ss.top3,
      list: { found_n: ss.list.found_n, code_median_min: ss.list.code_median_min, near_median_min: ss.list.near_median_min,
        code_faster: ss.list.code_faster.length, same: ss.list.same.length, near_faster: ss.list.near_faster.length },
      note: "코드 순서는 가던 방향의 예상 경로에 가까운 곳을 앞에 둡니다. 발견 장소가 그 방향에 있으면 빨라지고, 길이 굽어 방향이 어긋났거나 어르신이 방향을 바꾸셨으면 먼 곳부터 들르게 되어 느려집니다.",
    },
    types: data.types,
    cases: data.scenarios.map((s) => {
      const r = rows.find((x) => x.id === s.id);
      return {
        id: s.id, type: s.type, title: s.title, design: s.design, utterance: s.utterance,
        registered: s.registered.map((x) => `${x.name} (${SOURCE_KO[x.source] ?? x.source})`),
        gps: s.gps ? `${s.gps.legs.map((l) => (l.stay_min ? `${l.stay_min}분 머묾` : `${l.toward} 가는 길을 따라 시속 ${l.kmh}km로 걸음`)).join(" → ")} → 집에서 직선 ${fmt(r.cut_from_home_m)} 지점에서 끊김, 그 뒤 ${s.gps.since_cut_min}분 지남` : `없음 (나가신 지 ${s.elapsed_min}분)`,
        headline: r.headline,
        top: r.top.map((c) => ({ name: c.name, source: SOURCE_KO[c.source] ?? c.source, reason: c.reason, to_found: fmt(c.to_found_m), near: c.to_found_m <= NEAR_M })),
        found: r.found, found_registered: r.found_registered, hit1: r.hit1, hit3: r.hit3,
        found_detail: `마지막 위치에서 ${fmt(r.last_to_found_m)} · 걸어서 닿을 수 있는 범위(${fmt(r.reach_m)}) ${r.found_in_reach ? "안" : "밖"}`,
        search: `나가신 지 ${r.left_ago_min}분 뒤에 찾기 시작 → 3곳을 순서대로 돌면 ${r.search_top3.found ? `${r.search_top3.minutes}분 뒤 ${r.search_top3.stops}곳째에서 발견` : `${r.search_top3.minutes}분을 쓰고도 찾지 못함`}`,
        search_min: r.search_top3.found ? r.search_top3.minutes : null,
        ending: `나가신 뒤 ${hm(r.found_after_min)} 만에 발견 — ${r.found_by}: ${r.found_how}`,
        found_after: hm(r.found_after_min), found_by: r.found_by,
      };
    }),
  };
}

// ---------------------------------------------------------------- 실행
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const data = loadData();
  const rows = await runAll(data);
  const sum = summarize(rows);
  if (process.argv.includes("--json")) console.log(JSON.stringify({ summary: sum, rows }, null, 1));
  else {
    fs.writeFileSync(DOC_PATH, renderDoc(data, rows, sum));
    fs.mkdirSync(path.dirname(PUBLIC_PATH), { recursive: true });
    fs.writeFileSync(PUBLIC_PATH, JSON.stringify(publicJson(data, rows, sum), null, 1) + "\n");
    const a = sum.all;
    console.log(`사례 ${a.n}개 · 첫째 ${a.hit1} · 3곳 안 ${a.hit3} · 전체 목록 안 ${a.in_list} · 닿을 수 있는 범위 안 ${a.in_reach}`);
    console.log(`문서: ${path.relative(root, DOC_PATH)}`);
    const bad = rows.filter((r) => !r.possible);
    if (bad.length) console.log(`주의: 가장 빠른 걸음으로도 갈 수 없는 거리의 사례 — ${bad.map((r) => r.id).join(", ")}`);
  }
}
