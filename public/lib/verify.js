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
    meds: str(r.meds),
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
  check("gait", c.gait); check("meds", c.meds); check("dementia_signs", c.dementia_signs); check("prior_incidents", c.prior_incidents);
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
