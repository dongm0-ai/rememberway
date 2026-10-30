// 되묻기·✎ 수정·서식 답변 입력기: 말로 하거나 글로 쓴다. 선택지 없음 (2026-10-29 지도교사 결정: 고르는 것도 부담).
// 답은 자연어 그대로 저장되고, 소지품(휴대전화·지갑·지팡이)만 "있/없" 말을 코드가 true/false로 바꾼다.
import { el, createSpeech } from "/js/common.js";

const HINTS = {
  honorific: "예) 아버지 / 어머니 / 할머니 (이름은 적지 않아요)",
  home_dong: "예) 대전 중구 석교동 / 부산 해운대구 좌동 (동까지만)",
  today_destination: "예) 시장이요 / 딸네 집 간다고 했어요",
  route: "예) 큰길 따라 걸어서 / 102번 버스 타고 우체국 앞에서 내려요",
  transport: "예) 버스는 혼자 타세요, 교통카드 지갑에 있어요 / 차는 못 타세요",
  "clothing.top": "예) 회색 점퍼 / 베이지 코트에 체크 목도리",
  "clothing.bottom": "예) 검정 바지",
  "clothing.shoes": "예) 흰 운동화",
  "clothing.hat": "예) 안 썼어요 / 검정 벙거지",
  gait: "예) 천천히, 지팡이 짚고 / 다리를 좀 절어요",
  meds: "예) 혈압약 드세요, 오늘 아침 건 드셨어요 / 안 드세요",
  dementia_signs: "예) 요즘 집을 가끔 못 찾아요 / 그런 적 없어요",
  prior_incidents: "예) 작년에 한 번, 시장 근처에서 / 없어요",
  "last_seen.time": "예) 한 시쯤 / 점심 먹고 바로",
  "last_seen.place": "예) 집 / 경로당 앞",
  "items.phone": "예) 두고 가셨어요 / 가지고 가셨어요",
  "items.wallet": "예) 있어요 / 없어요",
  "items.cane": "예) 짚고 가셨어요 / 안 가져가셨어요",
};
const BOOL = new Set(["items.phone", "items.wallet", "items.cane"]);

export function parseBool(text) {
  if (text === true || text === false) return text;
  const t = String(text ?? "").replace(/\s+/g, "");
  if (!t || /모름|몰라|글쎄/.test(t)) return null;
  if (/(없|안가|안갖|안챙|두고|놓고|안들|안짚)/.test(t)) return false;
  if (/(있|가지|갖|챙|들고|짚|소지|가져)/.test(t)) return true;
  return null;
}

/** container 안에 입력기를 그린다. 반환 { value(): string|boolean|null, focus(), stop() } */
export function buildAnswerInput(key, container, initial = null) {
  container.innerHTML = "";
  const input = el("textarea", { placeholder: HINTS[key] ?? "말로 하거나 적어 주세요", rows: "2", style: "flex:1;min-height:56px" });
  if (typeof initial === "string") input.value = initial;
  else if (initial === true) input.value = "있어요"; else if (initial === false) input.value = "없어요";
  const mic = el("button", { type: "button", class: "btn-secondary", style: "flex:0 0 56px;width:56px;height:56px;padding:0;border-radius:50%;font-size:24px;align-self:center", "aria-label": "말로 답하기", title: "말로 답하기" }, "🎙️");
  const hint = el("div", { class: "small muted", style: "min-height:1.2em;margin-top:4px" }, "🎙️를 누르고 말하거나, 적어 주세요");
  const speech = createSpeech({
    onText: (fin, interim) => { input.value = fin; hint.textContent = interim ? "…" + interim : (fin ? "들었어요. 맞으면 [답하기]" : "듣고 있어요…"); },
    onState: (on) => { mic.setAttribute("aria-pressed", String(on)); mic.style.background = on ? "var(--alert)" : ""; mic.style.color = on ? "#fff" : ""; },
  });
  if (!speech) { mic.disabled = true; hint.textContent = "이 브라우저는 음성 입력이 안 돼요. 적어 주세요."; }
  else mic.onclick = () => (speech.listening ? speech.stop() : speech.start(input.value));
  container.append(el("div", { class: "row", style: "align-items:stretch" }, input, mic), hint);
  return {
    value() {
      speech?.stop();
      const v = input.value.trim();
      if (!v) return null;
      return BOOL.has(key) ? parseBool(v) : v;
    },
    focus() { input.focus(); },
    stop() { speech?.stop(); },
  };
}
