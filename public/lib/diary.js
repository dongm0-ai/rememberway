// REMEMBER WAY AI — 일지 축적 → 장소 분류 (코드). 생성형 AI는 분류하지 않는다.
import { DIARY_RULES } from "./schema.js";

const daysAgo = (iso, from = new Date()) => Math.floor((from.getTime() - new Date(iso).getTime()) / 86400000);

/** 프로필 + 일지 → 분류된 장소 목록. 화면 0 요약과 화면 2·3의 memory_places에 쓰인다. */
export function classifyPlaces(profile, diary, now = new Date()) {
  const byName = new Map();
  const touch = (name, evidence) => {
    if (!byName.has(name)) byName.set(name, { name, source: "guardian", evidence, visits_30d: 0, mentions: 0 });
    return byName.get(name);
  };

  for (const p of profile?.places ?? []) {
    const x = touch(p.name, p.evidence);
    x.source = "memory";
    x.first_seen = profile?.created_at;
    if (p.lat && p.lng) { x.lat = p.lat; x.lng = p.lng; }
  }

  const recent14 = {}, prev14 = {};
  for (const e of diary ?? []) {
    if (e.unknown) continue;
    const d = daysAgo(e.date, now);
    if (d > 30 || d < 0) continue;
    for (const name of e.visited ?? []) {
      const x = touch(name, `일지 ${e.date}`);
      x.visits_30d = (x.visits_30d ?? 0) + 1;
      x.first_seen = x.first_seen && x.first_seen < e.date ? x.first_seen : e.date;
      x.last_seen = x.last_seen && x.last_seen > e.date ? x.last_seen : e.date;
      if (d <= 14) recent14[name] = (recent14[name] ?? 0) + 1; else prev14[name] = (prev14[name] ?? 0) + 1;
    }
    for (const np of e.extracted?.new_places ?? []) {
      const x = touch(np.name, np.evidence);
      x.visits_30d = (x.visits_30d ?? 0) + 1;
      x.first_seen = x.first_seen ?? e.date; x.last_seen = e.date;
      if (d <= 14) recent14[np.name] = (recent14[np.name] ?? 0) + 1; else prev14[np.name] = (prev14[np.name] ?? 0) + 1;
    }
    for (const m of e.extracted?.mentions ?? []) {
      const x = touch(m.place, m.evidence);
      x.mentions = (x.mentions ?? 0) + 1;
      if (!x.first_seen) x.first_seen = e.date;
    }
  }

  // 분류 (우선순위: rising > new > frequent > memory > guardian)
  for (const x of byName.values()) {
    const r = recent14[x.name] ?? 0, p = prev14[x.name] ?? 0, v = x.visits_30d ?? 0;
    const isRegistered = (profile?.places ?? []).some((pp) => pp.name === x.name);
    if ((p === 0 && r >= 2) || (p > 0 && r >= p * DIARY_RULES.RISING_RATIO)) x.source = "rising";
    else if (!isRegistered && v > 0 && v <= DIARY_RULES.NEW_MAX) x.source = "new";
    else if (v >= DIARY_RULES.FREQUENT_MIN) x.source = "frequent";
    else if (isRegistered) x.source = "memory";
    else if ((x.mentions ?? 0) > 0 && v === 0) x.source = "memory";
    else x.source = "guardian";
  }
  return [...byName.values()];
}

/** 기록일 수. 7일 미만이면 화면에 "기록이 적어 패턴 신뢰도가 낮습니다" */
export function recordedDays(diary, now = new Date()) {
  return (diary ?? []).filter((e) => !e.unknown && daysAgo(e.date, now) <= 30 && daysAgo(e.date, now) >= 0).length;
}

/** 지난 7일 집계 (호출 ⑥ 입력용 — 숫자는 코드가 센다) */
export function weeklyAggregate(profile, diary, now = new Date()) {
  const week = (diary ?? []).filter((e) => !e.unknown && daysAgo(e.date, now) <= 7 && daysAgo(e.date, now) >= 0);
  const counts = {};
  for (const e of week) for (const n of [...(e.visited ?? []), ...((e.extracted?.new_places ?? []).map((p) => p.name))]) counts[n] = (counts[n] ?? 0) + 1;
  const places = classifyPlaces(profile, diary, now);
  return {
    recorded_days: week.length,
    stayed_home_days: week.filter((e) => e.stayed_home).length,
    visits: Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, n, source: places.find((p) => p.name === name)?.source ?? "guardian" })),
    rising_or_new: places.filter((p) => p.source === "rising" || p.source === "new").map((p) => ({ name: p.name, source: p.source })),
    mentions: week.flatMap((e) => e.extracted?.mentions ?? []).map((m) => ({ place: m.place, kind: m.kind })),
    low_confidence: recordedDays(diary, now) < DIARY_RULES.MIN_DAYS_FOR_PATTERN,
  };
}
