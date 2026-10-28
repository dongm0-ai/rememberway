// REMEMBER WAY AI — 생성형 AI 호출 (서버에서만 실행. 브라우저에 키를 두지 않는다)
// SDK 없이 Node 내장 fetch로 호출한다 (의존성 0). 제공자는 환경변수로 고른다.
//   AI_PROVIDER=gemini (기본) → Gemini API (GEMINI_API_KEY, GEMINI_MODEL)
//   AI_PROVIDER=claude        → Claude Messages API (ANTHROPIC_API_KEY, CLAUDE_MODEL)
// 파일 이름은 처음 결정(Claude) 때 지은 것이라 그대로 둔다. 호출하는 쪽은 askJSON/askText만 쓴다.

export const PROVIDER = (process.env.AI_PROVIDER || (process.env.GEMINI_API_KEY ? "gemini" : "claude")).toLowerCase();
export const MODEL = PROVIDER === "gemini"
  ? (process.env.GEMINI_MODEL || "gemini-3.8-flash")
  : (process.env.CLAUDE_MODEL || "claude-sonnet-4-5");
const TIMEOUT_MS = 15_000; // 15초 안에 응답 없으면 화면은 서식 모드로 전환 (혼잡 시 대체 모델을 한 번 더 시도할 여유. 결정표 2026-10-28)

export function hasKey() {
  return Boolean(PROVIDER === "gemini" ? process.env.GEMINI_API_KEY : process.env.ANTHROPIC_API_KEY);
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
  const text = await askText(system, user, { maxTokens, json: true });
  const m = text.match(/[\[{][\s\S]*[\]}]/);
  if (!m) throw new AIError("NO_JSON", text.slice(0, 200));
  try { return JSON.parse(m[0]); } catch { throw new AIError("BAD_JSON", m[0].slice(0, 200)); }
}

/** 시스템/사용자 프롬프트 → 문장 (호출 ⑥ 주간 요약처럼 JSON이 아닌 경우) */
export async function askText(system, user, { maxTokens = 1500, json = false } = {}) {
  if (isMock()) return mockReply(system, user);
  if (!hasKey()) throw new AIError("NO_KEY");
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return PROVIDER === "gemini"
      ? await callGemini(system, user, maxTokens, json, controller.signal)
      : await callClaude(system, user, maxTokens, controller.signal);
  } catch (e) {
    if (e instanceof AIError) throw e;
    if (e.name === "AbortError") throw new AIError("TIMEOUT");
    throw new AIError("AI_UNAVAILABLE", String(e.message ?? e));
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------- Gemini (generateContent)
let geminiModel = null; // 마지막으로 성공한 모델 (인스턴스 안에서 기억). 환경변수 모델이 막히면 아래 대체 목록 순서로 시도한다.
const FALLBACKS = (process.env.GEMINI_FALLBACKS || "gemini-3.8-flash,gemini-3-flash-preview,gemini-3.5-flash-lite,gemini-3.1-flash-lite").split(",").map((s) => s.trim()).filter(Boolean);
function nextModel(tried) { return [MODEL, ...FALLBACKS].find((m) => !tried.includes(m)) ?? null; }
export function currentModel() { return PROVIDER === "gemini" ? (geminiModel || MODEL) : MODEL; }
let thinkingOff = true; // 생각 단계 끄기(속도 우선). 모델이 이 설정을 거부(400)하면 그 뒤로는 빼고 보낸다.
export function geminiBody(system, user, maxTokens, json, useThinkingOff = thinkingOff) {
  return {
    system_instruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig: { temperature: 0, maxOutputTokens: maxTokens, ...(useThinkingOff ? { thinkingConfig: { thinkingBudget: 0 } } : {}), ...(json ? { responseMimeType: "application/json" } : {}) },
  };
}
async function callGemini(system, user, maxTokens, json, signal, model = geminiModel || MODEL, tried = []) {
  tried = [...tried, model];
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const body = geminiBody(system, user, maxTokens, json);
  // 모델 하나당 최대 ATTEMPT_MS. 혼잡한 모델은 503을 주기까지 10초 넘게 걸리기도 해서, 전체 타임아웃 안에 다음 모델로 넘어가려면 필요하다.
  const ATTEMPT_MS = 6000;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY }, // 키는 URL이 아니라 헤더로
      body: JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(ATTEMPT_MS)]),
    });
  } catch (e) {
    if (signal.aborted) throw e; // 전체 타임아웃 → TIMEOUT
    const alt = nextModel(tried); // 이 모델만 느림 → 다음 모델
    if (alt) return callGemini(system, user, maxTokens, json, signal, alt, tried);
    throw new AIError("AI_UNAVAILABLE", `gemini slow [${tried.join("→")}]`);
  }
  if (!res.ok) {
    const txt = await res.text();
    // 예: "This model models/gemini-2.5-flash is no longer available ... use models/gemini-3.8-flash" → 제안된 모델로 1회 재시도
    if (res.status === 400 && thinkingOff && /invalid argument|thinking/i.test(txt)) { thinkingOff = false; return callGemini(system, user, maxTokens, json, signal, model, tried.slice(0, -1)); }
    // 모델 종료(404)·혼잡(503/429)이면 대체 모델로 넘어간다 (전체 타임아웃 안에서)
    if ([404, 503, 429].includes(res.status)) {
      const suggested = res.status === 404 ? txt.match(/use models\/([\w.-]+)/)?.[1] : null;
      const alt = (suggested && !tried.includes(suggested)) ? suggested : nextModel(tried);
      if (alt) return callGemini(system, user, maxTokens, json, signal, alt, tried);
    }
    throw new AIError("AI_UNAVAILABLE", `gemini ${res.status} [${tried.join("→")}] ${txt.slice(0, 160)}`);
  }
  geminiModel = model; // 성공한 모델을 다음 호출의 1순위로
  const data = await res.json();
  const cand = data.candidates?.[0];
  if (!cand) throw new AIError("AI_UNAVAILABLE", `gemini no candidate: ${JSON.stringify(data.promptFeedback ?? {}).slice(0, 200)}`);
  return (cand.content?.parts ?? []).map((p) => p.text ?? "").join("");
}

// ---------------------------------------------------------------- Claude (Messages API)
async function callClaude(system, user, maxTokens, signal) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, temperature: 0, system, messages: [{ role: "user", content: user }] }),
    signal,
  });
  if (!res.ok) throw new AIError("AI_UNAVAILABLE", `claude ${res.status} ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return (data.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("");
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
