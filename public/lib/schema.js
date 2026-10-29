// REMEMBER WAY AI — 단서 스키마·가중치·임계값 (확정본 2026-10-25, starter의 schema.ts를 JS로 옮김)
// 여기 숫자를 바꾸면 docs/REMEMBER_WAY_AI_구현전_결정표.md 도 같이 바꾼다.
// 브라우저와 서버(api/)가 같이 쓴다. 타입 설명은 주석으로 남긴다.

/*
PlaceSource: "memory" 추억 장소 | "frequent" 자주 가는 곳 | "rising" 최근 자주 가기 시작한 곳 | "new" 새로운 곳 | "guardian" 기타 보호자 입력
Place: { name, source, evidence, visits_30d?, first_seen?, last_seen?, mentions?, lat?, lng?, distance_m?, score? }
Profile: { honorific, home_dong, gait: "slow"|"normal"|"fast"|null, gait_note, habits[], places: Place[], created_at }
DiaryEntry: { date, visited[], stayed_home?, unknown?, spoken?, extracted?: { new_places[], mentions[], notes } }
ClueJSON: 아래 EMPTY_CLUE 모양
*/

export const EMPTY_CLUE = Object.freeze({
  honorific: null, // 보호자가 쓴 호칭(아버지·어머니…). 있으면 평소 등록 정보보다 우선. 이름 금지
  home_dong: null, // 보호자가 말한 어르신 집 동네(시 구 동). 있으면 평소 등록 정보보다 우선
  last_seen: { time: null, place: null },
  today_destination: null,
  route: null,
  clothing: { top: null, bottom: null, shoes: null, hat: null },
  gait: null,
  items: { phone: null, wallet: null, cane: null },
  meds: null,
  dementia_signs: null,
  memory_places: [],
  prior_incidents: null,
  missing: [],
});

/** 되묻기 우선순위 (규칙 1). AI는 이 순서를 바꾸지 않는다. */
export const FOLLOWUP_PRIORITY = [
  "today_destination",
  "route",
  "clothing.top",
  "meds",
  "dementia_signs",
  "items.phone",
  "prior_incidents",
];

/** 화면에 보일 항목 이름 */
export const FIELD_LABELS = {
  honorific: "호칭 (아버지·어머니…)",
  home_dong: "집 동네 (시 구 동)",
  "last_seen.time": "마지막으로 본 시각",
  "last_seen.place": "마지막으로 본 곳",
  today_destination: "오늘 가려던 곳",
  route: "평소 가는 길",
  "clothing.top": "상의",
  "clothing.bottom": "하의",
  "clothing.shoes": "신발",
  "clothing.hat": "모자",
  gait: "걸음걸이",
  "items.phone": "휴대전화",
  "items.wallet": "지갑",
  "items.cane": "지팡이",
  meds: "약 복용",
  dementia_signs: "요즘 기억·길 헷갈림",
  prior_incidents: "이전에 길 잃은 적",
};

/** 서식 모드(AI 장애 시)에서 되묻기 대신 쓰는 고정 질문 */
export const FORM_QUESTIONS = {
  today_destination: "오늘 어디 가신다고 하셨나요?",
  route: "그곳은 평소 어느 길로 가세요?",
  "clothing.top": "상의는 무슨 색, 어떤 옷이었나요?",
  meds: "드시는 약이 있으세요? (복용 여부만)",
  dementia_signs: "요즘 길을 헷갈려 하신 적 있나요?",
  "items.phone": "휴대전화를 가지고 나가셨나요?",
  prior_incidents: "전에도 길을 잃으신 적이 있나요?",
};

/** 일지 → 분류 임계값 (임의 설정, 실험으로 조정. 화면에 공개) */
export const DIARY_RULES = {
  FREQUENT_MIN: 4,
  RISING_RATIO: 2,
  NEW_MAX: 2,
  MIN_DAYS_FOR_PATTERN: 7,
};

/** 우선 확인 순서 가중치 (화면 3에 숫자 공개. "임의 설정, 실험으로 조정") */
export const WEIGHTS = {
  memory: 3,
  rising: 3,
  frequent: 2,
  new: 2,
  guardian: 1,
  intersection: 2,
  outOfRadius: -2,
};

export const SOURCE_LABELS = {
  memory: "추억 장소",
  rising: "최근 자주 가기 시작한 곳",
  frequent: "자주 가는 곳",
  new: "새로운 곳",
  guardian: "보호자가 말한 곳",
};

/** 보행 속도 구간값 (m/s) */
export const WALK_SPEED = { slow: 0.5, normal: 0.8, fast: 1.2 };
