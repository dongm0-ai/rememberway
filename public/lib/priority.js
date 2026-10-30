// REMEMBER WAY AI — 우선 확인 순서 (규칙 기반, 코드). 생성형 AI는 관여하지 않는다.
// 화면 3에 WEIGHTS 숫자를 그대로 보여 주고 "임의 설정, 실험으로 조정"이라고 적는다. "확률", "예측"이라는 말은 쓰지 않는다.
import { WEIGHTS, WALK_SPEED, SOURCE_LABELS } from "./schema.js";

/** 이동 가능 최대 반경(m) = 경과시간(초) × 보행속도(m/s) */
export function maxRadiusM(elapsedMin, speed) {
  return Math.round(elapsedMin * 60 * (WALK_SPEED[speed] ?? WALK_SPEED.normal));
}

/**
 * places: Place[] (distance_m 있는 것만 점수 계산, 없으면 "거리 모름"으로 뒤에 붙임)
 * intersections: {name, lat, lng, distance_m}[] (길찾기 API 미연동이면 빈 배열)
 * alreadyChecked: 보호자가 "이미 가 봤다"고 한 곳
 */
export function rankCandidates(places, intersections, rMax, alreadyChecked = []) {
  const out = [];
  for (const p of places) {
    if (alreadyChecked.includes(p.name)) continue;
    let score = WEIGHTS[p.source] ?? WEIGHTS.guardian;
    const known = typeof p.distance_m === "number";
    if (known && p.distance_m > rMax) score += WEIGHTS.outOfRadius;
    out.push({
      kind: "place", name: p.name, source: p.source, distance_m: known ? p.distance_m : null, score,
      lat: p.lat, lng: p.lng,
      reason: `${SOURCE_LABELS[p.source] ?? "보호자가 말한 곳"}${p.evidence ? ` · "${p.evidence}"` : ""}` + (known && p.distance_m > rMax ? " · 반경 밖" : "") + (known ? "" : " · 거리 모름"),
    });
  }
  for (const x of intersections) {
    let score = WEIGHTS.intersection;
    if (x.distance_m > rMax) score += WEIGHTS.outOfRadius;
    out.push({ kind: "intersection", name: x.name, distance_m: x.distance_m, score, lat: x.lat, lng: x.lng, reason: "경로 위 교차로 (배회 시작 지점 후보)" });
  }
  // 점수 높은 순, 동점이면 가까운 순 (거리 모름은 뒤로)
  const d = (c) => (typeof c.distance_m === "number" ? c.distance_m : 1e12);
  return out.sort((a, b) => b.score - a.score || d(a) - d(b));
}

/** 화면 3 "지금 할 일 3가지" — 규칙 기반 체크리스트 (AI 아님) */
export function actionSteps(hasPhone, ranked) {
  const steps = ["112에 신고하고 이 요약을 보여 주세요 (치매 어르신은 즉시 신고 대상)"];
  if (ranked[0]) steps.push(`${ranked[0].name}부터 확인하세요. 가는 길에서 발견되는 경우가 많으니 길 위도 살펴보세요`);
  steps.push(hasPhone === false ? "가족 한 명은 집에 남아 어르신이 돌아올 때를 대비하세요" : "어르신 휴대전화로 계속 전화해 보세요");
  return steps.slice(0, 3);
}

/** 두 좌표 사이 직선거리(m) */
export function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371000, toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

/** 경찰 전달용 요약문 — 코드가 조립 (AI 아님). 값이 없으면 "모름"으로 적어 누락을 드러낸다. */
export function buildSummary(clue, profile, elapsedMin) {
  const v = (x) => (x === null || x === undefined || x === "" ? "모름" : x);
  const b = (x) => (x === true ? "있음" : x === false ? "없음" : "모름");
  const h = clue.honorific || profile?.honorific || "어르신"; // 이번에 말한 호칭 > 평소 등록
  const lines = [
    `[치매 어르신 실종 — 보호자 정리 내용]`,
    `대상: ${h}${clue.home_dong || profile?.home_dong ? ` (거주: ${clue.home_dong || profile.home_dong})` : ""}`,
    `마지막 본 시각: ${v(clue.last_seen?.time)} / 장소: ${v(clue.last_seen?.place)}` + (elapsedMin ? ` (약 ${elapsedMin}분 경과)` : ""),
    `오늘 가려던 곳: ${v(clue.today_destination)} / 평소 가는 길: ${v(clue.route)}`,
    `버스·지하철·택시: ${v(clue.transport)}`,
    `옷차림: 상의 ${v(clue.clothing?.top)}, 하의 ${v(clue.clothing?.bottom)}, 신발 ${v(clue.clothing?.shoes)}, 모자 ${v(clue.clothing?.hat)}`,
    `걸음걸이: ${v(clue.gait || profile?.gait_note)}`,
    `소지품: 휴대전화 ${b(clue.items?.phone)}, 지갑 ${b(clue.items?.wallet)}, 지팡이 ${b(clue.items?.cane)}`,
    `약 복용: ${v(clue.meds)} / 요즘 기억·길 헷갈림: ${v(clue.dementia_signs)}`,
    `이전에 길 잃은 적: ${v(clue.prior_incidents)}`,
  ];
  if (clue.memory_places?.length) lines.push(`갈 가능성이 있다고 보호자가 말한 곳: ${clue.memory_places.map((p) => p.name).join(", ")}`);
  lines.push(`* 이 내용은 보호자가 말한 것을 정리한 것입니다. 이름·주소 상세는 보호자가 직접 전달합니다.`);
  return lines.join("\n");
}
