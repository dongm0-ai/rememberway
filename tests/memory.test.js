// Task 9 — 기억 꺼내기 대화: 주제·질문 템플릿, 검증(verifyMemory), 프롬프트 규칙, 모의 응답, /api/diary mode "memory"
import test from "node:test";
import assert from "node:assert/strict";
import { MEMORY_TOPICS, memoryQuestion } from "../public/lib/schema.js";
import { verifyMemory, appearsExactly } from "../public/lib/verify.js";
import { SYSTEM_MEMORY, userMemory } from "../lib/prompts.js";
import { askJSON } from "../lib/claude.js";
import handler from "../api/diary.js";

// ---------------------------------------------------------------- 검증 (브리프의 4개)
test("drops place not in answer", () => assert.equal(verifyMemory({ places: [{ name: "부산역" }] }, "청주 육거리시장에 다니셨어요", []).places.length, 0));
test("keeps place in answer", () => assert.equal(verifyMemory({ places: [{ name: "육거리시장", evidence: "다니셨어요" }] }, "청주 육거리시장에 다니셨어요", []).places[0].name, "육거리시장"));
test("skips known place", () => assert.equal(verifyMemory({ places: [{ name: "육거리시장" }] }, "육거리시장", ["육거리시장"]).places.length, 0));
test("followup must be a question ≤160", () => assert.equal(verifyMemory({ places: [], followup: "x".repeat(200) + "?" }, "", []).followup, null));

// ---------------------------------------------------------------- 검증 (추가)
test("known place matches ignoring spaces", () => assert.equal(verifyMemory({ places: [{ name: "육거리 시장" }] }, "육거리시장에 다니셨어요", ["육거리시장"]).places.length, 0));
test("same place twice in AI output is kept once", () => {
  const r = verifyMemory({ places: [{ name: "육거리시장", evidence: "육거리시장" }, { name: "육거리 시장", evidence: "육거리시장" }] }, "육거리시장에 다니셨어요", []);
  assert.equal(r.places.length, 1);
});
test("evidence copied from the answer is kept as is", () => {
  const r = verifyMemory({ places: [{ name: "육거리시장", evidence: "육거리시장에서 장사하셨어요" }] }, "젊을 때 청주 육거리시장에서 장사하셨어요", []);
  assert.equal(r.places[0].evidence, "육거리시장에서 장사하셨어요");
});
test("evidence not in the answer is replaced by the answer fragment holding the name (never AI-invented)", () => {
  const r = verifyMemory({ places: [{ name: "육거리시장", evidence: "부산에서 오래 사셨다" }] }, "아버지는 젊을 때 청주 육거리시장에서 장사하셨어요. 주말엔 쉬셨고요.", []);
  assert.equal(r.places[0].evidence, "아버지는 젊을 때 청주 육거리시장에서 장사하셨어요");
});
test("missing evidence is filled from the answer too", () => {
  const r = verifyMemory({ places: [{ name: "육거리시장" }] }, "육거리시장에 다니셨어요", []);
  assert.equal(r.places[0].evidence, "육거리시장에 다니셨어요");
});
test("exact flag: name written in the answer is exact, partial overlap is not", () => {
  const r = verifyMemory({ places: [{ name: "육거리시장" }, { name: "육거리 재래시장" }] }, "청주 육거리시장에 다니셨어요", []);
  assert.deepEqual(r.places.map((p) => p.exact), [true, false]);
  assert.equal(appearsExactly("육거리 시장", "청주 육거리시장에"), true);
  assert.equal(appearsExactly("부산역", "청주 육거리시장에"), false);
});
test("at most 5 places, name ≤ 30 chars, phone-like names dropped", () => {
  const names = ["가시장", "나시장", "다시장", "라시장", "마시장", "바시장", "사시장"];
  const r = verifyMemory({ places: names.map((name) => ({ name })) }, names.join(" "), []);
  assert.equal(r.places.length, 5);
  assert.equal(verifyMemory({ places: [{ name: "시장" + "가".repeat(40) }] }, "시장" + "가".repeat(40), []).places.length, 0);
  assert.equal(verifyMemory({ places: [{ name: "친구 집 010-1234-5678" }] }, "친구 집 010-1234-5678", []).places.length, 0);
});
test("garbage AI output gives empty result", () => {
  for (const raw of [null, undefined, "text", 5, [], {}, { places: "x" }, { places: [null, 3, {}, { name: 7 }, { name: "  " }] }])
    assert.deepEqual(verifyMemory(raw, "육거리시장", []), { places: [], followup: null });
});
test("followup kept when it is one question ≤160", () => {
  assert.equal(verifyMemory({ places: [], followup: "  그 시장은 어느 동네에 있었나요?  " }, "시장", []).followup, "그 시장은 어느 동네에 있었나요?");
  assert.equal(verifyMemory({ places: [], followup: "x".repeat(159) + "?" }, "", []).followup, "x".repeat(159) + "?");
});
test("followup dropped when not a question, more than one question, banned word, or not a string", () => {
  for (const followup of ["어느 동네였어요.", "어느 동네였나요? 언제부터 다니셨나요?", "위험한 곳은 아니었나요?", "실종 가능성이 있는 곳인가요?", null, 7, {}, "?"])
    assert.equal(verifyMemory({ places: [], followup }, "", []).followup, null, String(followup));
});

// ---------------------------------------------------------------- 주제·질문
test("MEMORY_TOPICS fixed order and labels", () => {
  assert.deepEqual(MEMORY_TOPICS.map((t) => t.key), ["old_home", "hometown", "old_work", "market", "bath", "religion", "hospital", "people"]);
  assert.deepEqual(MEMORY_TOPICS.map((t) => t.label), ["예전에 사시던 집·동네", "고향", "예전 직장·일하시던 곳", "자주 가시던 시장·가게", "목욕탕·이발소·미용실", "교회·성당·절", "다니시던 병원·복지관·경로당", "자주 찾아가시던 친구·친척 집"]);
});
test("memoryQuestion keeps the template shape and fixes the 은/는 particle", () => {
  const q = (key) => memoryQuestion("아버지", MEMORY_TOPICS.find((t) => t.key === key));
  assert.equal(q("hometown"), "아버지께서 고향은 어디셨나요?");
  assert.equal(q("old_home"), "아버지께서 예전에 사시던 집·동네는 어디셨나요?");
  assert.equal(q("market"), "아버지께서 자주 가시던 시장·가게는 어디셨나요?");
  assert.equal(q("old_work"), "아버지께서 예전 직장·일하시던 곳은 어디셨나요?");
  assert.equal(memoryQuestion("", MEMORY_TOPICS[1]), "어르신께서 고향은 어디셨나요?");
});

// ---------------------------------------------------------------- 프롬프트 규칙 (고치면 안 되는 문구)
test("SYSTEM_MEMORY keeps the required rules", () => {
  for (const s of ["원문에 없는", "빈 배열", "null", "JSON", "이미 알려진", "evidence", "질문 1개"]) assert.ok(SYSTEM_MEMORY.includes(s), s);
  for (const phrase of ["되물을 질문", "하루 기록을 정리", "자주 머문 곳", "지난주 기록을 짧게", "찾은 뒤 보호자가 남기는 기록"]) assert.ok(!SYSTEM_MEMORY.includes(phrase), `mock routing collision: ${phrase}`);
});
test("userMemory puts the answer in the first triple-quote block", () => {
  const u = userMemory("아버지", "고향", "아버지께서 고향은 어디셨나요?", "충북 괴산이요", ["경로당"]);
  assert.equal((u.match(/"""([\s\S]*?)"""/) ?? [])[1], "충북 괴산이요");
  assert.ok(u.includes("고향") && u.includes("경로당"));
});

// ---------------------------------------------------------------- 모의 응답 (MOCK_AI=1) + /api/diary mode "memory"
async function withMock(fn) {
  const prev = process.env.MOCK_AI; process.env.MOCK_AI = "1";
  try { return await fn(); } finally { if (prev === undefined) delete process.env.MOCK_AI; else process.env.MOCK_AI = prev; }
}
let n = 0;
function post(body) {
  return new Promise((resolve) => {
    const res = { setHeader() {}, end(s) { resolve(JSON.parse(s)); } };
    handler({ method: "POST", headers: { origin: "http://localhost:3000", "x-forwarded-for": `memory-test-${++n}` }, body }, res);
  });
}

test("mock reply for the memory prompt is a JSON object that survives verifyMemory", () => withMock(async () => {
  const answer = "아버지는 젊을 때 청주 육거리시장에서 장사하셨어요";
  const raw = await askJSON(SYSTEM_MEMORY, userMemory("아버지", "자주 가시던 시장·가게", "q", answer, []));
  const v = verifyMemory(raw, answer, []);
  assert.equal(v.places[0].name, "육거리시장");
}));

test("/api/diary mode memory: place card + followup, mock flagged", () => withMock(async () => {
  const out = await post({ mode: "memory", honorific: "아버지", topic: "market", question: "아버지께서 자주 가시던 시장·가게는 어디셨나요?", answer: "아버지는 젊을 때 청주 육거리시장에서 장사하셨어요", knownPlaces: ["경로당"] });
  assert.equal(out.ok, true);
  assert.equal(out.mock, true);
  assert.equal(out.places[0].name, "육거리시장");
  assert.ok(out.places[0].evidence.includes("육거리시장"));
  assert.ok(out.followup === null || out.followup.endsWith("?"));
}));
test("/api/diary mode memory: known place not returned again", () => withMock(async () => {
  const out = await post({ mode: "memory", honorific: "아버지", topic: "market", question: "q", answer: "육거리시장에 다니셨어요", knownPlaces: ["육거리시장"] });
  assert.equal(out.ok, true);
  assert.equal(out.places.length, 0);
}));
test("/api/diary mode memory: bad input", () => withMock(async () => {
  for (const body of [{ mode: "memory", topic: "market", answer: "" }, { mode: "memory", topic: "nope", answer: "시장" }, { mode: "memory", topic: "market", answer: "가".repeat(1001) }, { mode: "memory", topic: "market", answer: 5 }]) {
    const out = await post(body);
    assert.deepEqual([out.ok, out.reason], [false, "BAD_INPUT"]);
  }
}));
test("/api/diary mode memory: AI failure becomes ok:false (screen switches to typing the name)", async () => {
  const keys = ["MOCK_AI", "UPSTAGE_API_KEY", "GEMINI_API_KEY", "ANTHROPIC_API_KEY"], prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  delete process.env.MOCK_AI; for (const k of keys.slice(1)) delete process.env[k];
  try {
    const out = await post({ mode: "memory", honorific: "아버지", topic: "market", question: "q", answer: "육거리시장" });
    assert.equal(out.ok, false);
  } finally { for (const k of keys) if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
});
test("other modes still work (diary default path unchanged)", () => withMock(async () => {
  const out = await post({ spoken: "오늘은 약국에 다녀오셨어요", knownPlaces: [], date: "2026-11-17" });
  assert.equal(out.ok, true);
  assert.equal(out.extracted.new_places[0].name, "약국");
}));
