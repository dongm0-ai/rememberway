// REMEMBER WAY AI — GPS 기록 → 머문 곳(Stay Point) → 자주 머문 곳 (규칙, 코드). 생성형 AI는 머문 곳을 정하지 않는다.
// 브라우저(/gps)와 서버(api/loc.js action "places")가 같이 쓴다.
//
// 머문 곳 판정: 박진관·오수열(2016) 「통계적 분석방법을 이용한 Stay Point 추출 연구」 스마트미디어저널 5(4).
//   숫자를 미리 정하지 않고, 그 사람의 기록 분포에서 기준을 계산한다.
//   ① 밖에서 머묾: 연속한 두 점의 속력 분포를 가우스 혼합(GMM)으로 나누고, 가장 느린 성분의 평균을 속력 기준으로 한다.
//      속력 기준보다 느린 구간 중, 방향이 제멋대로인 구간(방위각 퍼짐이 큼)을 머문 곳으로 본다. 유의수준 5%(Z=1.96).
//   ② 실내에서 머묾: 건물에 들어가면 GPS가 끊긴다. 끊긴 시간이 유난히 길고(상위 5%), 끊기기 전후 거리는 평범하면(95% 안) 머문 곳.
//   ※ 논문 PDF의 식(1)~(3)이 깨져 있어 다음은 우리 해석이다: GMM 성분 수는 1~3개 중 BIC가 가장 작은 것(1개면 그날 밖 머묾 없음),
//     방위각 퍼짐은 원형 표준편차, 방향 기준은 "평균−1.96×표준편차보다 퍼짐이 작으면(한 방향으로 걸으면) 머묾 아님",
//     실내 기준은 한쪽 5%(Z=1.645). 같은 장소 묶기는 논문에 없어 각 머묾의 점 퍼짐(반지름)이 겹치면 같은 곳으로 본다.
// 기간: 최근 30일 (Bayat 외 2020, JMIR Aging: 노인 GPS 4주 수집). 위치를 예측하지 않는다 — 지난 기록을 세는 것이다.

export const GPS_WINDOW_DAYS = 30;
const R = 6371000, rad = (x) => (x * Math.PI) / 180;
export const distM = (a, b) => { const dl = rad(b.lat - a.lat), dg = rad(b.lng - a.lng); const h = Math.sin(dl / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dg / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
const bearing = (a, b) => { const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat)), x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng)); return Math.atan2(y, x); };
const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
const localDate = (t) => new Date(t).toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" });
const kst = (t) => new Date(new Date(t).toLocaleString("en-US", { timeZone: "Asia/Seoul" }));
const WD = ["일", "월", "화", "수", "목", "금", "토"];

/** 기록 파일(CSV·GPX·목걸이 로그) → [{t(ms), lat, lng}] 시간순 */
export function parseTrack(text) {
  text = String(text ?? "").replace(/^﻿/, "");
  const pts = [];
  if (/<gpx|<trkpt/i.test(text)) {
    for (const m of text.matchAll(/<trkpt\b([^>]*)>([\s\S]*?)<\/trkpt>/gi)) {
      const lat = Number((m[1].match(/lat="([^"]+)"/) ?? [])[1]), lng = Number((m[1].match(/lon="([^"]+)"/) ?? [])[1]);
      const t = Date.parse((m[2].match(/<time>([^<]+)<\/time>/) ?? [])[1]);
      if (ok(lat, lng, t)) pts.push({ t, lat, lng });
    }
    return pts.sort((a, b) => a.t - b.t);
  }
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^(BEGIN|END|#)/.test(l));
  if (!lines.length) return pts;
  const sep = lines[0].includes("\t") ? "\t" : lines[0].includes(";") && !lines[0].includes(",") ? ";" : ",";
  const head = lines[0].toLowerCase().split(sep).map((s) => s.replace(/"/g, "").trim());
  const hasHead = head.some((h) => /lat|lon|lng|time|date/.test(h));
  const find = (re) => head.findIndex((h) => re.test(h));
  let iT = 0, iLat = 1, iLng = 2, iDate = -1;   // 헤더가 없으면 목걸이 로그: 시각,위도,경도
  if (hasHead) { iLat = find(/^lat/); iLng = find(/^(lon|lng)/); iT = find(/time|timestamp|시각|시간/); iDate = find(/^date$|날짜/); if (iT === iDate) iDate = -1; }
  for (const line of hasHead ? lines.slice(1) : lines) {
    const c = line.split(sep).map((s) => s.replace(/"/g, "").trim());
    const lat = Number(c[iLat]), lng = Number(c[iLng]);
    const ts = iDate >= 0 && c[iT] && !/\d{4}-\d{2}-\d{2}/.test(c[iT]) ? `${c[iDate]}T${c[iT]}` : c[iT];
    const t = /^\d{10,13}$/.test(ts ?? "") ? Number(ts) * (ts.length === 10 ? 1000 : 1) : Date.parse(String(ts ?? "").replace(" ", "T"));
    if (ok(lat, lng, t)) pts.push({ t, lat, lng });
  }
  return pts.sort((a, b) => a.t - b.t);
}
const ok = (lat, lng, t) => Number.isFinite(lat) && Number.isFinite(lng) && Number.isFinite(t) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);

/** 1차원 가우스 혼합(EM). k개 성분 → {means, sds, weights, bic} */
function gmm1d(x, k) {
  const n = x.length, s = [...x].sort((a, b) => a - b);
  let mu = Array.from({ length: k }, (_, j) => s[Math.floor(((j + 0.5) / k) * n)]);
  let sg = Array(k).fill(sd(x) || 1e-3), w = Array(k).fill(1 / k), ll = -Infinity;
  const pdf = (v, m, d) => Math.exp(-0.5 * ((v - m) / d) ** 2) / (d * Math.sqrt(2 * Math.PI));
  for (let it = 0; it < 200; it++) {
    const resp = x.map((v) => { const p = mu.map((m, j) => w[j] * pdf(v, m, sg[j]) + 1e-300); const t = p.reduce((a, b) => a + b, 0); return p.map((q) => q / t); });
    for (let j = 0; j < k; j++) {
      const nj = resp.reduce((a, r) => a + r[j], 0) || 1e-9;
      mu[j] = resp.reduce((a, r, i) => a + r[j] * x[i], 0) / nj;
      sg[j] = Math.max(Math.sqrt(resp.reduce((a, r, i) => a + r[j] * (x[i] - mu[j]) ** 2, 0) / nj), 1e-3);
      w[j] = nj / n;
    }
    const nll = x.reduce((a, v) => a + Math.log(mu.reduce((b, m, j) => b + w[j] * pdf(v, m, sg[j]), 0) + 1e-300), 0);
    if (Math.abs(nll - ll) < 1e-6) { ll = nll; break; }
    ll = nll;
  }
  return { means: mu, sds: sg, weights: w, bic: (3 * k - 1) * Math.log(n) - 2 * ll };
}

/** 점 → 머문 곳. 논문처럼 하루치 궤적마다 따로 기준을 계산한다(밤사이 끊김이 기준을 흐리지 않게) */
export function findStays(pts) {
  const byDay = new Map();
  for (const p of pts) { const d = localDate(p.t); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(p); }
  const stays = [], rules = [];
  for (const [day, dp] of byDay) { const r = findStaysDay(dp); stays.push(...r.stays); if (r.rules) rules.push({ day, ...r.rules }); }
  return { stays, rules };
}

/** 같은 곳에 잇달아 머문 조각(밖에서 서성일 때 속력이 잠깐 튀어 끊긴 것)을 한 번으로 합친다: 사이의 점이 모두 두 머묾의 범위 안이면 */
function mergeRuns(stays, pts) {
  const out = [];
  for (const s of stays) {
    const last = out[out.length - 1];
    if (last && distM(last, s) <= last.r + s.r) {
      const between = pts.filter((p) => p.t > last.end && p.t < s.start);
      if (between.every((p) => distM(p, last) <= last.r + s.r)) {
        const w1 = last.minutes + 1, w2 = s.minutes + 1;
        Object.assign(last, { lat: (last.lat * w1 + s.lat * w2) / (w1 + w2), lng: (last.lng * w1 + s.lng * w2) / (w1 + w2), end: s.end, minutes: Math.round((s.end - last.start) / 60000), r: Math.max(last.r, s.r), kind: last.kind === s.kind ? last.kind : "밖·실내" });
        continue;
      }
    }
    out.push({ ...s });
  }
  return out;
}

function findStaysDay(pts) {
  const out = { stays: [], rules: null };
  if (pts.length < 3) return out;
  const seg = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1], dt = (b.t - a.t) / 1000, d = distM(a, b);
    if (dt > 0) seg.push({ i, dt, d, v: d / dt, br: bearing(a, b) });
  }
  if (seg.length < 3) return out;
  // ② 실내(끊김): 시간은 상위 5%, 거리는 95% 안
  const tThr = mean(seg.map((s) => s.dt)) + 1.645 * sd(seg.map((s) => s.dt));
  const dThr = mean(seg.map((s) => s.d)) + 1.645 * sd(seg.map((s) => s.d));
  const gap = new Set();
  for (const s of seg) if (s.dt > tThr && s.d <= dThr) {
    gap.add(s.i);
    const a = pts[s.i], b = pts[s.i + 1];
    out.stays.push({ lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2, start: a.t, end: b.t, minutes: Math.round(s.dt / 60), r: Math.max(s.d / 2, 1), kind: "실내(GPS 끊김)" });
  }
  // ① 밖: 속력 GMM → 가장 느린 성분 평균
  const vs = seg.filter((s) => !gap.has(s.i)).map((s) => s.v);
  let best = null;
  for (let k = 1; k <= Math.min(3, Math.floor(vs.length / 5) || 1); k++) { const g = gmm1d(vs, k); if (!best || g.bic < best.bic) best = g; }
  // 속력 분포가 한 덩어리(k=1)면 "멈춤"과 "이동"을 나눌 수 없으므로 그날은 밖에서 머문 곳을 뽑지 않는다 (우리 해석)
  const vThr = best.means.length > 1 ? Math.min(...best.means) : -Infinity;
  const runs = []; let cur = [];
  for (const s of seg) { if (!gap.has(s.i) && s.v < vThr) cur.push(s); else { if (cur.length >= 2) runs.push(cur); cur = []; } }
  if (cur.length >= 2) runs.push(cur);
  const spread = (run) => { const c = mean(run.map((s) => Math.cos(s.br))), si = mean(run.map((s) => Math.sin(s.br))); const Rl = Math.min(Math.hypot(c, si), 0.999999); return Math.sqrt(-2 * Math.log(Rl)); };
  const sp = runs.map(spread);
  const bThr = runs.length >= 3 ? mean(sp) - 1.96 * sd(sp) : -Infinity;   // 후보가 적으면 표준편차를 못 구해 모두 통과
  runs.forEach((run, j) => {
    if (sp[j] < bThr) return;   // 한 방향으로 계속 감 → 머묾 아님
    const g = pts.slice(run[0].i, run[run.length - 1].i + 2);
    const c = { lat: mean(g.map((p) => p.lat)), lng: mean(g.map((p) => p.lng)) };
    const ds = g.map((p) => distM(c, p)).sort((a, b) => a - b);
    out.stays.push({ ...c, start: g[0].t, end: g[g.length - 1].t, minutes: Math.round((g[g.length - 1].t - g[0].t) / 60000), r: Math.max(ds[Math.floor(ds.length * 0.95)] ?? 1, 1), kind: "밖" });
  });
  out.stays.sort((a, b) => a.start - b.start);
  out.stays = mergeRuns(out.stays, pts);
  out.rules = { speed_mps: Number.isFinite(vThr) ? +vThr.toFixed(3) : null, gmm_k: best.means.length, gap_s: Math.round(tThr), gap_m: Math.round(dThr), bearing_rad: Number.isFinite(bThr) ? +bThr.toFixed(3) : null };
  return out;
}

/** 머묾 → 같은 곳끼리(점 퍼짐이 겹치면) → 장소 목록 (머문 날이 많은 순). home {lat,lng} 근처면 집 표시 */
export function groupPlaces(stays, home = null) {
  const groups = [];
  for (const s of stays) {
    const g = groups.find((x) => distM(x, s) <= x.r + s.r);
    if (!g) { groups.push({ lat: s.lat, lng: s.lng, r: s.r, stays: [s] }); continue; }
    g.stays.push(s); g.lat = mean(g.stays.map((x) => x.lat)); g.lng = mean(g.stays.map((x) => x.lng)); g.r = Math.max(...g.stays.map((x) => x.r));
  }
  return groups.map((g, k) => {
    const days = [...new Set(g.stays.map((s) => localDate(s.start)))].sort();
    const total = g.stays.reduce((a, s) => a + s.minutes, 0), wd = {}, hr = {};
    for (const s of g.stays) { const k = kst(s.start); wd[k.getDay()] = (wd[k.getDay()] ?? 0) + 1; hr[k.getHours()] = (hr[k.getHours()] ?? 0) + 1; }
    return {
      id: `g${k + 1}`, lat: +g.lat.toFixed(5), lng: +g.lng.toFixed(5), radius_m: Math.round(g.r), days, visits: g.stays.length, total_min: total, avg_min: Math.round(total / g.stays.length),
      weekdays: Object.entries(wd).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([d]) => WD[d]),
      hour_band: hourBand(Object.entries(hr).sort((a, b) => b[1] - a[1])[0]?.[0]),
      first_date: days[0], last_date: days[days.length - 1],
      home: !!(home && Number.isFinite(home.lat) && distM(g, home) <= Math.max(g.r, 1) * 2),   // 집 주소가 이 곳의 점 퍼짐 안(지름)이면 집
    };
  }).sort((a, b) => b.days.length - a.days.length || b.total_min - a.total_min);
}
function hourBand(h) {
  if (h === undefined) return null; h = Number(h);
  if (h === 12) return "낮 12시쯤";
  return `${h < 6 ? "새벽" : h < 12 ? "오전" : h < 18 ? "오후" : "저녁"} ${((h + 11) % 12) + 1}시쯤`;
}

export function trackSummary(pts) {
  if (!pts.length) return { points: 0, days: 0, period_days: 0 };
  return { points: pts.length, days: new Set(pts.map((p) => localDate(p.t))).size, period_days: Math.round((pts[pts.length - 1].t - pts[0].t) / 86400000) + 1, from: localDate(pts[0].t), to: localDate(pts[pts.length - 1].t) };
}

/** 보호자에게 되물을 기본 질문 (AI를 못 쓸 때도 같은 화면이 되게) */
export function templateQuestion(p, label, period) {
  return `${label} 근처에 ${period}일 중 ${p.days.length}일, 한 번에 평균 ${p.avg_min}분 머무르셨어요${p.weekdays.length ? ` (주로 ${p.weekdays.join("·")}요일${p.hour_band ? ` ${p.hour_band}` : ""})` : ""}. 어떤 곳인가요? 어르신이 좋아하시는 곳인가요?`;
}

/** 시험용 모의 기록 (가짜 데이터, 화면에 "모의"로 표시). 움직일 때 10초마다, 멈추면 기록 없음(목걸이와 같은 방식) */
export function mockTrack(center, now = Date.now()) {
  const c = center && Number.isFinite(center.lat) ? center : { lat: 36.3155, lng: 127.4265 };
  const off = (dx, dy) => ({ lat: c.lat + dy / 111000, lng: c.lng + dx / (111000 * Math.cos(rad(c.lat))) });
  const P = { home: off(0, 0), hall: off(350, 150), park: off(-600, 700), market: off(900, -400) };
  const pts = [], day0 = new Date(now); day0.setHours(0, 0, 0, 0);
  const j = () => (Math.random() - 0.5) * 0.00008;
  const stay = (p, t0, min) => { for (let s = 0; s <= min * 60; s += 10) pts.push({ t: t0 + s * 1000, lat: p.lat + j(), lng: p.lng + j() }); };   // 밖에서 서성임
  const walk = (a, b, t0, min) => { for (let s = 0; s <= min * 60; s += 10) { const f = s / (min * 60); pts.push({ t: t0 + s * 1000, lat: a.lat + (b.lat - a.lat) * f + j() / 4, lng: a.lng + (b.lng - a.lng) * f + j() / 4 }); } };
  for (let d = 30; d >= 1; d--) {
    const base = day0.getTime() - d * 86400000, wd = new Date(base).getDay();
    let t = base + 9.5 * 3600000;
    const go = (p, min, indoor) => { walk(P.home, p, t, 12); t += 12 * 60000; if (indoor) t += min * 60000; else { stay(p, t, min); t += min * 60000; } walk(p, P.home, t, 12); t += 12 * 60000 + 3600000; };
    if ([1, 3, 5].includes(wd)) go(P.hall, 80, true);           // 월·수·금 경로당 (실내 → GPS 끊김)
    if (d <= 12 && d % 2 === 0) go(P.park, 40, false);          // 최근 공원이 늘어남 (밖)
    if ([25, 16, 6].includes(d)) go(P.market, 30, false);       // 가끔 시장
  }
  return pts;
}
