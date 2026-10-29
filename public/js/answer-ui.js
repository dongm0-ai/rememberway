// 되묻기·서식 답변 입력기: 글자를 치지 않고 눌러서 답할 수 있게 (어르신·급한 보호자용).
// 항목(key)마다 칩 + 짧은 보충 칸. 결과는 보호자 말과 같은 자연어 한 줄로 합친다 (AI·요약문이 그대로 쓸 수 있게).
import { el, $$ } from "/js/common.js";

const COLORS = ["검정", "흰색", "회색", "남색", "파랑", "빨강", "베이지", "갈색", "초록", "노랑", "보라", "분홍"];
const TOPS = ["점퍼", "코트", "패딩", "조끼", "셔츠", "티셔츠", "니트", "한복", "등산복"];
const BOTTOMS = ["긴바지", "반바지", "치마", "운동복 바지", "한복 바지"];
const SHOES = ["운동화", "구두", "슬리퍼", "장화", "맨발"];
const HATS = ["모자 안 씀", "야구모자", "벙거지", "털모자", "밀짚모자"];

export const SPECS = {
  today_destination: { chips: ["시장", "병원", "약국", "경로당", "교회·절", "은행·우체국", "마트", "자식 집", "옛 동네", "모름"], extra: "장소 이름 (예: 중앙시장)" },
  route: {
    groups: [
      { label: "어떻게 가세요?", chips: ["걸어서 큰길로", "걸어서 골목길로", "버스 타고", "지하철 타고", "택시 타고", "모름"] },
    ],
    extra: "버스 번호나 지나는 곳 (예: 102번, 우체국 앞 사거리)",
  },
  "clothing.top": { groups: [{ label: "색", chips: COLORS }, { label: "종류", chips: TOPS }], extra: "그 밖에 (예: 체크무늬)", join: " " },
  "clothing.bottom": { groups: [{ label: "색", chips: COLORS }, { label: "종류", chips: BOTTOMS }], join: " " },
  "clothing.shoes": { groups: [{ label: "색", chips: COLORS }, { label: "종류", chips: SHOES }], join: " " },
  "clothing.hat": { groups: [{ label: "모자", chips: HATS }, { label: "색", chips: COLORS }], join: " " },
  gait: { chips: ["천천히 걸음", "보통", "빠름", "지팡이 짚음", "한쪽 다리 절음", "보행기 사용"], multi: true, extra: "" },
  meds: { chips: ["약 드심 (오늘 드심)", "약 드심 (오늘 안 드심)", "약 드심 (모름)", "약 안 드심", "모름"] },
  dementia_signs: { chips: ["요즘 길 자주 헷갈림", "가끔 헷갈림", "집 못 찾은 적 있음", "사람 못 알아본 적 있음", "그런 적 없음", "모름"], multi: true },
  prior_incidents: { chips: ["없음", "한 번 있음", "여러 번 있음", "모름"], extra: "언제·어디서 (예: 작년 가을, 시장 근처)" },
  "last_seen.time": { chips: ["방금", "30분 전", "1시간 전", "2시간 전", "3시간 전", "아침", "점심 무렵", "저녁"], extra: "정확한 시각 (예: 1시쯤)" },
  "last_seen.place": { chips: ["집", "집 앞", "병원", "경로당", "시장", "버스 정류장"], extra: "다른 곳" },
};
const BOOL = { "items.phone": "휴대전화", "items.wallet": "지갑", "items.cane": "지팡이" };

/** container 안에 입력기를 그린다. 반환 { value(): string|boolean|null, focus() } */
export function buildAnswerInput(key, container, initial = null) {
  container.innerHTML = "";
  if (BOOL[key]) {
    const row = el("div", { class: "chips" }, ...[["true", "있음"], ["false", "없음"], ["", "모름"]].map(([v, t]) => el("button", { class: "chip", type: "button", "data-v": v, "aria-pressed": String(initial === (v === "" ? null : v === "true")), onclick: (e) => pick(row, e.currentTarget) }, t)));
    container.append(row);
    return { value: () => { const c = $$(".chip[aria-pressed=true]", row)[0]; return !c || c.dataset.v === "" ? null : c.dataset.v === "true"; }, focus() {} };
  }
  const spec = SPECS[key] ?? { extra: "답을 적어 주세요" };
  const groups = spec.groups ?? (spec.chips ? [{ label: null, chips: spec.chips }] : []);
  const rows = groups.map((g) => {
    const row = el("div", { class: "chips", style: "margin-bottom:8px" }, ...g.chips.map((t) => el("button", { class: "chip", type: "button", onclick: (e) => (spec.multi ? toggle(e.currentTarget) : pick(row, e.currentTarget)) }, t)));
    if (g.label) container.append(el("div", { class: "small muted", style: "margin:6px 0 4px" }, g.label));
    container.append(row);
    return row;
  });
  let extra = null;
  if (spec.extra !== "" && (spec.extra || !groups.length)) {
    extra = el("input", { type: "text", placeholder: spec.extra || "답을 적어 주세요", style: "margin-top:4px" });
    container.append(extra);
  }
  if (typeof initial === "string" && initial) {
    // 기존 값이 칩과 맞으면 눌러 두고, 아니면 보충 칸에
    const matched = rows.flatMap((row) => $$(".chip", row)).filter((c) => initial.includes(c.textContent));
    matched.forEach((c) => c.setAttribute("aria-pressed", "true"));
    if (!matched.length && extra) extra.value = initial;
  }
  return {
    value() {
      const picked = rows.map((row) => $$(".chip[aria-pressed=true]", row).map((c) => c.textContent)).flat();
      const parts = [...picked, ...(extra && extra.value.trim() ? [extra.value.trim()] : [])];
      if (!parts.length) return null;
      if (parts.length === 1 && parts[0] === "모름") return "모름";
      return parts.filter((p) => p !== "모름").join(spec.join ?? ", ");
    },
    focus() { extra?.focus(); },
  };
}
function pick(row, btn) { $$(".chip", row).forEach((c) => c.setAttribute("aria-pressed", String(c === btn && c.getAttribute("aria-pressed") !== "true"))); }
function toggle(btn) { btn.setAttribute("aria-pressed", String(btn.getAttribute("aria-pressed") !== "true")); }
