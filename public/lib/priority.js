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
  // 점수 높은 순, 동점이면 추억 장소 먼저(컨셉), 그다음 가까운 순 (거리 모름은 뒤로)
  const d = (c) => (typeof c.distance_m === "number" ? c.distance_m : 1e12);
  return out.sort((a, b) => b.score - a.score || isMemory(b) - isMemory(a) || d(a) - d(b));
}

/** 추억 장소면 1 — 동점 정렬과 동선 묶음에서 추억 장소를 앞에 두는 데 쓴다 */
export function isMemory(c) {
  return c.source === "memory" ? 1 : 0;
}

/** 화면 3 "지금 할 일 3가지" — 규칙 기반 체크리스트 (AI 아님) */
export function actionSteps(hasPhone, ranked) {
  // 급한 보호자가 읽도록 한 줄씩 짧게 (2026-11-02)
  const steps = ["112에 신고하고 아래 어르신 정보를 읽어 주세요"];
  if (ranked[0]) steps.push(`${ranked[0].name.split(":").pop().trim()}부터 가 보세요. 가는 길도 살펴보세요`);
  steps.push(hasPhone === false ? "가족 한 명은 집에 남아 기다리세요" : "어르신 휴대전화로 계속 전화해 보세요");
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
/**
 * 경찰에 전달할 요약 — 묶음별 [라벨, 값] (화면용). 값이 null이면 "모름".
 * 2026-11-02: 한 덩어리 글은 읽기 어렵다는 의견 → 번호 붙은 묶음 6개 + 왼쪽 라벨로 나눔. 복사·공유 글도 같은 순서.
 */
export function summaryGroups(clue, profile, elapsedMin) {
  // "모름"·"알 수 없음" 같은 값은 쓸모없는 정보라 빈 값으로 본다 (2026-11-03, 지도교사: 모르는 항목은 화면·복사 글 모두에서 빼기)
  const UNKNOWN = /^\s*(모름|몰라요?|모르겠(어요|음|다)?|모르겠습니다|알\s*수\s*없(음|어요|다)?|불명|미상|확인\s*안\s*됨|없음\s*\?|-|\?)\s*$/;
  const v = (x) => (x === null || x === undefined || x === "" || UNKNOWN.test(String(x)) ? null : String(x));
  const b = (x) => (x === true ? "있음" : x === false ? "없음" : v(x)); // 소지품: 예/아니오 또는 보호자 말 그대로
  const c = clue.clothing ?? {}, it = clue.items ?? {};
  return [
    { title: "누구", rows: [["대상", `${clue.honorific || profile?.honorific || "어르신"} (치매)`], ["사는 곳", v(clue.home_dong || profile?.home_dong)]] },
    { title: "마지막으로 본 때", rows: [["시각", v(clue.last_seen?.time)], ["장소", v(clue.last_seen?.place)], ["지난 시간", elapsedMin ? `약 ${elapsedMin}분` : null]] },
    { title: "가려던 곳·이동", rows: [["오늘 가려던 곳", v(clue.today_destination)], ["평소 가는 길", v(clue.route)], ["버스·택시", v(clue.transport)], ["보호자가 말한 곳", clue.memory_places?.length ? clue.memory_places.map((p) => p.name).join(", ") : null]] },
    { title: "옷차림", rows: [["상의", v(c.top)], ["하의", v(c.bottom)], ["신발", v(c.shoes)], ["모자", v(c.hat)]] },
    { title: "몸·소지품", rows: [["걸음걸이", v(clue.gait || profile?.gait_note)], ["휴대전화", b(it.phone)], ["지갑", b(it.wallet)], ["지팡이", b(it.cane)]] },
    { title: "건강·이력", rows: [["약 복용", v(clue.meds)], ["요즘 기억·길 헷갈림", v(clue.dementia_signs)], ["이전에 길 잃은 적", v(clue.prior_incidents)]] },
  ];
}
export const SUMMARY_NOTE = "이 내용은 보호자가 말한 것을 정리한 것입니다. 이름·주소 상세는 보호자가 직접 전달합니다.";

/** 복사·공유용 글 (문자·메신저에 붙여 넣어도 읽히게 번호와 줄바꿈). 아는 항목만 */
export function buildSummary(clue, profile, elapsedMin) {
  const lines = ["[치매 어르신 실종 — 보호자 정리 내용]"];
  let n = 0;
  for (const g of summaryGroups(clue, profile, elapsedMin)) {
    const rows = g.rows.filter(([, val]) => val);
    if (!rows.length) continue;
    lines.push("", `${++n}. ${g.title}`);
    for (const [k, val] of rows) lines.push(`- ${k}: ${val}`);
  }
  lines.push("", `* ${SUMMARY_NOTE}`);
  return lines.join("\n");
}
