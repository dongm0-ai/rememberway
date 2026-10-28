// REMEMBER WAY AI — Claude API 호출 (서버에서만 실행. 브라우저에 키를 두지 않는다)
// SDK 없이 Node 내장 fetch로 Messages API를 부른다. (의존성 0)
// 모델명은 키를 받은 뒤 호출 ①을 두세 모델로 돌려 보고 정한다. 기획안 5쪽 모델명도 그때 채움.

export const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-5";
const TIMEOUT_MS = 10_000; // 10초 안에 응답 없으면 화면은 서식 모드로 전환
const API_URL = "https://api.anthropic.com/v1/messages";

export function hasKey() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/** MOCK_AI=1 이면 실제 호출 없이 모의 응답. 화면에 "모의 응답(실제 AI 아님)"으로 표시된다. */
export function isMock() {
  return process.env.MOCK_AI === "1";
}

export class AIError extends Error {
  constructor(reason, detail) { super(reason); this.reason = reason; this.detail = detail; }
}

/** 시스템/사용자 프롬프트 → JSON. 응답에 설명이 섞여도 JSON만 꺼낸다. 실패 시 AIError(reason) */
export async function askJSON(system, user, { maxTokens = 1500 } = {}) {
  const text = await askText(system, user, { maxTokens });
  const m = text.match(/[\[{][\s\S]*[\]}]/);
  if (!m) throw new AIError("NO_JSON", text.slice(0, 200));
  try { return JSON.parse(m[0]); } catch { throw new AIError("BAD_JSON", m[0].slice(0, 200)); }
}

/** 시스템/사용자 프롬프트 → 문장 (호출 ⑥ 주간 요약처럼 JSON이 아닌 경우) */
export async function askText(system, user, { maxTokens = 1500 } = {}) {
  if (isMock()) return mockReply(system, user);
  if (!hasKey()) throw new AIError("NO_KEY");
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, temperature: 0, system, messages: [{ role: "user", content: user }] }),
      signal: controller.signal,
    });
    if (!res.ok) throw new AIError("AI_UNAVAILABLE", `${res.status} ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    return (data.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("");
  } catch (e) {
    if (e instanceof AIError) throw e;
    if (e.name === "AbortError") throw new AIError("TIMEOUT");
    throw new AIError("AI_UNAVAILABLE", String(e.message ?? e));
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------- 모의 응답 (MOCK_AI=1). 실제 AI 출력이 아니다. 화면 흐름 점검·시연 대체용.
function mockReply(system, user) {
  const utter = (user.match(/"""([\s\S]*?)"""/) ?? [])[1] ?? "";
  if (system.includes("되물을 질문")) {
    const missing = JSON.parse((user.match(/비어 있는 항목\(우선순위 순\):\n(\[[\s\S]*?\])/) ?? [, "[]"])[1]);
    const q = { today_destination: "오늘 어디 가신다고 하셨나요?", route: "그곳은 평소 어느 길로 가세요?", "clothing.top": "상의는 어떤 옷이었나요?", meds: "드시는 약이 있으세요?", dementia_signs: "요즘 길을 헷갈려 하신 적 있나요?", "items.phone": "휴대전화는 가지고 나가셨나요?", prior_incidents: "전에도 이런 적이 있었나요?" };
    return JSON.stringify(missing.slice(0, 3).map((k) => ({ key: k, question: q[k] })));
  }
  if (system.includes("하루 기록을 정리")) {
    return JSON.stringify({ new_places: utter.includes("약국") ? [{ name: "약국", evidence: "약국" }] : [], mentions: utter.includes("가고 싶") ? [{ place: utter.slice(0, 6), kind: "wish", evidence: utter.slice(0, 10) }] : [], notes: null });
  }
  if (system.includes("지난주 기록을 짧게")) {
    return "지난주에는 기록된 날이 많지 않았습니다. 자주 간 곳과 새로 나온 곳을 계속 적어 두시면 다음 주 요약이 더 정확해집니다. (모의 응답)";
  }
  if (system.includes("찾은 뒤 보호자가 남기는 기록")) {
    return JSON.stringify({ found_place: utter.slice(0, 8) || null, found_place_evidence: utter.slice(0, 12) || null, found_by: utter.includes("경찰") ? "경찰" : utter.includes("시민") || utter.includes("행인") ? "시민" : null, went_toward: null, elapsed_note: null, prevention: [{ action: "다음에는 발견된 곳을 우선 확인 목록에 넣어 두세요", because: "이번에 그곳에서 찾았기 때문입니다" }], add_places: utter ? [{ name: utter.slice(0, 8), evidence: utter.slice(0, 12) }] : [] });
  }
  // 호출 ① 단서 추출: 원문에서 뻔한 것만 아주 단순하게 뽑는다 (실제 AI 품질이 아님)
  const pick = (re) => { const m = utter.match(re); return m ? m[0] : null; };
  return JSON.stringify({
    last_seen: { time: pick(/(아침|점심|저녁|오전|오후)?\s*(한|두|세|네|다섯|여섯|일곱|여덟|아홉|열|열한|열두|\d+)\s*시\s*(반|\d+분)?\s*(쯤|경)?/), place: utter.includes("집") ? "집" : null },
    today_destination: pick(/[가-힣]+(시장|경로당|교회|병원|공원|역|마트)/),
    route: null,
    clothing: { top: pick(/[가-힣]+(색)?\s*(점퍼|코트|셔츠|잠바|조끼|티셔츠)/), bottom: pick(/[가-힣]+\s*바지/), shoes: null, hat: null },
    gait: pick(/(다리를 [가-힣 ]*저|천천히|지팡이)[가-힣 ]*/),
    items: { phone: utter.includes("핸드폰") || utter.includes("휴대폰") || utter.includes("휴대전화") ? !/두고|안 가|없/.test(utter) : null, wallet: null, cane: utter.includes("지팡이") ? true : null },
    meds: utter.includes("약") ? "복용 중" : null,
    dementia_signs: null,
    memory_places: (utter.match(/옛날[^.。]*?([가-힣]+동)/) ? [{ name: utter.match(/옛날[^.。]*?([가-힣]+동)/)[1] + " 옛 동네", source: "memory", evidence: utter.match(/옛날[^.。]*/)[0].slice(0, 30) }] : []),
    prior_incidents: utter.includes("전에도") ? "전에도 있었음" : null,
    missing: [],
  });
}
