// REMEMBER WAY AI — 출력 검증 (코드). 생성형 AI 출력은 여기를 통과하기 전에는 어디에도 쓰이지 않는다.
import { EMPTY_CLUE, FOLLOWUP_PRIORITY } from "./schema.js";

const norm = (s) => String(s).replace(/\s+/g, "").toLowerCase();

/** 환각 대조 규칙: 공백 제거 후 2글자 이상 연속 일치가 원문(또는 등록 정보)에 있으면 통과. 아니면 ⚠ */
export function appearsInSource(value, source) {
  const v = norm(value), s = norm(source);
  if (v.length < 2) return s.includes(v);
  for (let i = 0; i + 2 <= v.length; i++) {
    if (s.includes(v.slice(i, i + 2))) return true;
  }
  return false;
}

/** 스키마 검사: 빠진 키는 EMPTY_CLUE로 채우고, 타입이 어긋나면 null. 실패하면 null 반환 */
/**
 * 약 칸은 "복용 여부"만 남긴다 (CLAUDE.md: 성분명 없이). 프롬프트로 막아도 AI가 약 이름을 적은 사례가 있어(실험 C11, 2026-11-03)
 * AI가 쓴 문장을 그대로 두지 않고 코드가 정해진 표현으로 바꾼다.
 */
export function medsOnly(v) {
  if (!v) return v;
  const t = String(v);
  const not = /(안\s*드시|안\s*먹|복용\s*안|복용하지\s*않|드시지\s*않|없음|없어요|안 함)/.test(t);
  const today = /(오늘|아침|점심|저녁).{0,8}(안\s*드|안\s*먹|거르|빼먹|못\s*드)/.test(t);
  const taking = /(드시|드세|복용|먹|약|mg|밀리|하루|알씩|정씩)/i.test(t);
  if (today) return "복용 중 (오늘 약을 안 드셨을 수 있음)";
  if (not && !taking) return "복용 안 함";
  if (/(복용\s*안|안\s*드세요|약\s*없|드시는\s*약\s*없)/.test(t)) return "복용 안 함";
  if (taking) return "복용 중";
  return "복용 여부 불확실";
}

export function coerceClue(raw) {
  if (!raw || typeof raw !== "object") return null;
  const r = raw;
  const str = (x) => (typeof x === "string" && x.trim() ? x.trim() : null);
  const bool = (x) => (typeof x === "boolean" ? x : null);
  const obj = (x) => (x && typeof x === "object" ? x : {});
  const ls = obj(r.last_seen), cl = obj(r.clothing), it = obj(r.items);
  const places = Array.isArray(r.memory_places) ? r.memory_places : [];
  const clue = {
    ...structuredClone(EMPTY_CLUE),
    honorific: str(r.honorific),
    home_dong: str(r.home_dong),
    last_seen: { time: str(ls.time), place: str(ls.place) },
    today_destination: str(r.today_destination),
    route: str(r.route),
    transport: str(r.transport),
    clothing: { top: str(cl.top), bottom: str(cl.bottom), shoes: str(cl.shoes), hat: str(cl.hat) },
    gait: str(r.gait),
    items: { phone: bool(it.phone), wallet: bool(it.wallet), cane: bool(it.cane) },
    meds: medsOnly(str(r.meds)),
    dementia_signs: str(r.dementia_signs),
    memory_places: places
      .map((p) => obj(p))
      .filter((p) => str(p.name))
      .map((p) => ({
        name: str(p.name),
        source: ["memory", "recent", "guardian"].includes(p.source) ? (p.source === "recent" ? "frequent" : p.source) : "guardian",
        evidence: str(p.evidence) ?? "",
      })),
    prior_incidents: str(r.prior_incidents),
    missing: [],
  };
  clue.missing = computeMissing(clue);
  return clue;
}

/** missing은 AI가 준 값을 믿지 않고 코드가 다시 계산한다 */
export function computeMissing(c) {
  const m = [];
  if (!c.today_destination) m.push("today_destination");
  if (!c.route) m.push("route");
  if (!c.clothing?.top) m.push("clothing.top");
  if (!c.transport) m.push("transport");
  if (!c.meds) m.push("meds");
  if (!c.dementia_signs) m.push("dementia_signs");
  if (c.items?.phone === null || c.items?.phone === undefined) m.push("items.phone");
  if (!c.prior_incidents) m.push("prior_incidents");
  return FOLLOWUP_PRIORITY.filter((k) => m.includes(k));
}

/** 각 값이 원문(+등록 정보)에 있는지 대조해 flags를 채운다 */
export function flagHallucinations(c, utterance, registered) {
  const src = utterance + " " + (registered ?? "");
  const flags = {};
  const check = (key, v) => { if (v && !appearsInSource(v, src)) flags[key] = "unverified"; };
  check("last_seen.time", c.last_seen.time); check("last_seen.place", c.last_seen.place);
  check("today_destination", c.today_destination); check("route", c.route);
  check("clothing.top", c.clothing.top); check("clothing.bottom", c.clothing.bottom);
  check("clothing.shoes", c.clothing.shoes); check("clothing.hat", c.clothing.hat);
  check("gait", c.gait);
  // 약 칸은 코드가 정해진 표현으로 바꿔 두므로 "원문에 약 이야기가 있었는지"로 확인
  if (c.meds && !/(약|복용|mg|밀리|알씩|정씩)/i.test(src)) flags.meds = "unverified";
  check("dementia_signs", c.dementia_signs);
  check("prior_incidents", c.prior_incidents);
  c.memory_places.forEach((p, i) => { if (!appearsInSource(p.name, src)) flags[`memory_places.${i}`] = "unverified"; });
  return { ...c, flags };
}

/** 점 경로로 값 읽기/쓰기 ("clothing.top") */
export function getPath(obj, path) {
  return path.split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), obj);
}
export function setPath(obj, path, value) {
  const keys = path.split("."); let o = obj;
  for (let i = 0; i < keys.length - 1; i++) { if (!o[keys[i]] || typeof o[keys[i]] !== "object") o[keys[i]] = {}; o = o[keys[i]]; }
  o[keys[keys.length - 1]] = value;
  return obj;
}

// ---------------------------------------------------------------- 기억 꺼내기 대화 (api/diary.js mode "memory", 화면 memory.html)
const MEMORY_BANNED = /(위험|예측|확률|실종 가능성|AI가 추천)/;
const PHONE_LIKE = /\d{2,4}[-\s.]?\d{3,4}[-\s.]?\d{4}|\d{3,4}[-\s.]\d{4}/;

/** 값이 원문에 글자 그대로(공백·대소문자 무시) 들어 있는가. appearsInSource(두 글자만 겹쳐도 통과)보다 엄격 — 아니면 화면에 ⚠ */
export function appearsExactly(value, source) {
  const v = norm(value ?? "");
  return v.length > 0 && norm(source ?? "").includes(v);
}

/** 근거 문장: AI가 준 evidence가 원문에 그대로 있을 때만 쓴다. 아니면 코드가 원문에서 이름이 나온 부분을 직접 잘라 쓴다 (AI가 만든 문장은 저장하지 않음) */
function memoryEvidence(name, evidence, answer) {
  const ev = typeof evidence === "string" ? evidence.trim() : "";
  if (ev && appearsExactly(ev, answer)) return PHONE_LIKE.test(ev) ? name : ev.slice(0, 80);
  const clauses = answer.split(/[.!?。\n]+/).map((c) => c.trim()).filter(Boolean);
  const clause = clauses.find((c) => appearsExactly(name, c)) ?? clauses.find((c) => appearsInSource(name, c)) ?? "";
  if (PHONE_LIKE.test(clause)) return name; // 전화번호가 근거 문장에 섞여 있으면 저장하지 않는다 (잘라 쓰기 전의 문장 전체로 검사)
  if (clause.length <= 60) return clause;
  const start = Math.max(0, clause.indexOf(name) - 20); // 말로 입력하면 마침표가 없어 한 문장이 길다 → 이름 둘레만
  return clause.slice(start, start + 60).trim();
}

function memoryFollowup(f, input) {
  if (typeof f !== "string") return null;
  const t = f.trim();
  if (t.length < 3 || t.length > 160 || !/[?？]$/.test(t) || (t.match(/[?？]/g) ?? []).length > 1 || MEMORY_BANNED.test(t)) return null;
  const nums = new Set(input.match(/\d+/g) ?? []); // 질문·답에 없는 숫자(연도·나이 등)를 끼워 넣었으면 버린다
  return (t.match(/\d+/g) ?? []).every((n) => nums.has(n)) ? t : null;
}

/**
 * 호출 ⑧ 검증(코드): AI가 뽑은 장소 중 보호자 답(answer)에 없는 이름·이미 아는 이름·전화번호 꼴·중복은 버리고(최대 5곳),
 * 근거는 원문에서만 가져온다(전화번호꼴이 섞이면 이름으로 대신). 이름이 원문에 글자 그대로는 없으면(appearsExactly 가 false) 화면이 ⚠를 붙인다.
 * followup은 160자 이하의 질문 1개이고 숫자가 question·answer에 있는 것뿐일 때만 남기고, 아니면 null.
 * question(선택): 보호자에게 한 질문. followup 숫자 대조에만 쓴다.
 */
export function verifyMemory(raw, answer, knownPlaces = [], question = "") {
  const r = raw && typeof raw === "object" ? raw : {};
  const src = String(answer ?? "");
  const known = new Set((Array.isArray(knownPlaces) ? knownPlaces : []).map((k) => norm(k)));
  const places = [], seen = new Set();
  for (const p of Array.isArray(r.places) ? r.places : []) {
    if (typeof p?.name !== "string") continue;
    const name = p.name.trim().replace(/\s+/g, " "), key = norm(name);
    if (key.length < 2 || name.length > 30 || PHONE_LIKE.test(name) || !appearsInSource(name, src) || known.has(key) || seen.has(key)) continue;
    seen.add(key);
    places.push({ name, evidence: memoryEvidence(name, p.evidence, src) });
    if (places.length === 5) break;
  }
  return { places, followup: memoryFollowup(r.followup, src + " " + String(question ?? "")) };
}
