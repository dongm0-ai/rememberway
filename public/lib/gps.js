// REMEMBER WAY AI — GPS 기록 → 머문 곳(Stay Point) → 자주 머문 곳 (규칙, 코드). 생성형 AI는 머문 곳을 정하지 않는다.
// 브라우저(/gps)와 서버(api/loc.js action "places")가 같이 쓴다.
//
// 머문 곳 판정: 박진관·오수열(2016) 「통계적 분석방법을 이용한 Stay Point 추출 연구」 스마트미디어저널 5(4) — 본문 확인(2026-11-17).
//   유저별·날짜별로 기준을 계산한다 (숫자를 미리 정하지 않음).
//   ① 밖: 속력 분포를 가우스 혼합(GMM)으로 나누고 첫(가장 느린) 가우시안 평균 = ΔSpeed. 한 덩어리(unimodal)면 평균을 임계값으로("평균이나 중앙값을 임계값으로 정해도 무방").
//         ΔSpeed보다 느린 부분 궤적의 방위각 편차 평균이 ΔBearing을 초과하면 머문 곳(SP), 좌표는 그 구간 평균.
//         방위각 = 식(2) acos 식, 방위각 편차 = 식(3) |Bearing(i+1) − Bearing(i)|. ΔBearing = Z-Score 유의수준 5%.
//   ② 실내: GPS 점 사이 시간 Z가 상위 5%(유의수준 5% 구간)이고 거리 Z가 0~95% 구간이면 실내 SP.
//   Z 기준 1.645 = "신뢰구간 0~95%"(한쪽 5%). GMM 성분 수 = BIC 최소(Schwarz 1978; Baudry 외 2010), 1~5개(논문 표 5가 5개).
// 같은 장소 묶기(논문에 없음): DBSCAN(Ester 외 1996), MinPts 4·Eps 94m = Bayat 외 2020(노인 GPS)의 MinPts와 참가자별 Eps(32·59·94·95·97m)의 가운데 값.
//   4번 넘게 머물지 않은 곳은 묶이지 않는다(일지 규칙 "자주 = 30일 4회 이상"과 같은 수).
// 기간: 최근 30일 (Bayat 외 2020, JMIR Aging: 노인 GPS 4주 수집). 위치를 예측하지 않는다 — 지난 기록을 세는 것이다.

export const GPS_WINDOW_DAYS = 30;
const R = 6371000, rad = (x) => (x * Math.PI) / 180;
export const distM = (a, b) => { const dl = rad(b.lat - a.lat), dg = rad(b.lng - a.lng); const h = Math.sin(dl / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dg / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
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

/** 1차원 가우스 혼합(EM). k개 성분 → {means, bic} */
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
  return { means: mu, bic: (3 * k - 1) * Math.log(n) - 2 * ll };
}

const Z95 = 1.645;            // 유의수준 5% (한쪽)
const DBSCAN_MINPTS = 4;      // Ester 외 1996 · Bayat 외 2020
const DBSCAN_EPS_M = 94;      // Bayat 외 2020 참가자별 Eps 32·59·94·95·97m 의 가운데 값

/** 식 (2): Bearing = acos((sin φ(i+1) − sin φ(i)·cos d) / (sin d · cos φ(i))), d = 두 점 사이 각거리 */
function bearingPaper(a, b) {
  const d = distM(a, b) / R;
  if (d === 0) return 0;
  const v = (Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(d)) / (Math.sin(d) * Math.cos(rad(a.lat)));
  return Math.acos(Math.max(-1, Math.min(1, v)));
}

/** 점 → 머문 곳(SP). 날짜별로 따로 기준을 계산한다 */
export function findStays(pts) {
  const byDay = new Map();
  for (const p of pts) { const d = localDate(p.t); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(p); }
  const stays = [], rules = [];
  for (const [day, dp] of byDay) { const r = findStaysDay(dp); stays.push(...r.stays); if (r.rules) rules.push({ day, ...r.rules }); }
  return { stays, rules };
}

function findStaysDay(pts) {
  const out = { stays: [], rules: null };
  const seg = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const dt = (pts[i + 1].t - pts[i].t) / 1000;
    if (dt > 0) { const d = distM(pts[i], pts[i + 1]); seg.push({ i, dt, d, v: d / dt, br: bearingPaper(pts[i], pts[i + 1]) }); }
  }
  if (seg.length < 3) return out;
  // ② 실내 SP: 시간 Z > 1.645 이고 거리 Z < 1.645
  const mt = mean(seg.map((s) => s.dt)), st = sd(seg.map((s) => s.dt)) || 1, md = mean(seg.map((s) => s.d)), sdd = sd(seg.map((s) => s.d)) || 1;
  const gap = new Set();
  for (const s of seg) if ((s.dt - mt) / st > Z95 && (s.d - md) / sdd < Z95) {
    gap.add(s.i);
    const a = pts[s.i], b = pts[s.i + 1];
    out.stays.push({ lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2, start: a.t, end: b.t, minutes: Math.round(s.dt / 60), kind: "실내(GPS 끊김)" });
  }
  // ① 밖 SP: ΔSpeed = GMM 첫 가우시안 평균 (한 덩어리면 평균)
  const vs = seg.filter((s) => !gap.has(s.i)).map((s) => s.v);
  let best = null;
  for (let k = 1; k <= 5 && vs.length >= k * 5; k++) { const g = gmm1d(vs, k); if (!best || g.bic < best.bic) best = g; }
  if (best) {
    const vThr = best.means.length > 1 ? Math.min(...best.means) : mean(vs);
    // ΔBearing: 그날 방위각 편차 |Bearing(i+1) − Bearing(i)| 분포의 평균 + 1.645σ
    const dev = []; for (let j = 0; j < seg.length - 1; j++) dev.push(Math.abs(seg[j + 1].br - seg[j].br));
    const bThr = mean(dev) + Z95 * sd(dev);
    let run = [];
    const close = () => {
      if (run.length >= 2) {
        const ds = []; for (let j = 0; j < run.length - 1; j++) ds.push(Math.abs(run[j + 1].br - run[j].br));
        if (mean(ds) > bThr) {
          const g = pts.slice(run[0].i, run[run.length - 1].i + 2);
          out.stays.push({ lat: mean(g.map((p) => p.lat)), lng: mean(g.map((p) => p.lng)), start: g[0].t, end: g[g.length - 1].t, minutes: Math.round((g[g.length - 1].t - g[0].t) / 60000), kind: "밖" });
        }
      }
      run = [];
    };
    for (const s of seg) { if (!gap.has(s.i) && s.v < vThr) run.push(s); else close(); }
    close();
    out.rules = { speed_mps: +vThr.toFixed(3), gmm_k: best.means.length, bearing_rad: +bThr.toFixed(3) };
  }
  out.rules = { ...(out.rules ?? {}), gap_s: Math.round(mt + Z95 * st), gap_m: Math.round(md + Z95 * sdd) };
  out.stays.sort((a, b) => a.start - b.start);
  return out;
}

/** 머문 곳 → DBSCAN(MinPts 4, Eps 94m)으로 같은 장소 묶기 → 장소 목록 (머문 날이 많은 순). 4번 미만은 빠짐 */
export function groupPlaces(stays, home = null) {
  const n = stays.length, lab = Array(n).fill(-1);
  const near = (i) => { const r = []; for (let j = 0; j < n; j++) if (distM(stays[i], stays[j]) <= DBSCAN_EPS_M) r.push(j); return r; };
  let c = 0;
  for (let i = 0; i < n; i++) {
    if (lab[i] !== -1) continue;
    const nb = near(i);
    if (nb.length < DBSCAN_MINPTS) { lab[i] = -2; continue; }
    lab[i] = c; const q = nb.filter((j) => j !== i);
    while (q.length) {
      const j = q.pop();
      if (lab[j] === -2) lab[j] = c;
      if (lab[j] !== -1) continue;
      lab[j] = c;
      const nb2 = near(j); if (nb2.length >= DBSCAN_MINPTS) q.push(...nb2);
    }
    c++;
  }
  const groups = Array.from({ length: c }, (_, k) => stays.filter((_, i) => lab[i] === k));
  return groups.map((g, k) => {
    const lat = mean(g.map((x) => x.lat)), lng = mean(g.map((x) => x.lng));
    const days = [...new Set(g.map((s) => localDate(s.start)))].sort();
    const total = g.reduce((a, s) => a + s.minutes, 0), wd = {}, hr = {};
    for (const s of g) { const t = kst(s.start); wd[t.getDay()] = (wd[t.getDay()] ?? 0) + 1; hr[t.getHours()] = (hr[t.getHours()] ?? 0) + 1; }
    const pl = { id: `g${k + 1}`, lat: +lat.toFixed(5), lng: +lng.toFixed(5), radius_m: DBSCAN_EPS_M, days, visits: g.length, total_min: total, avg_min: Math.round(total / g.length),
      weekdays: Object.entries(wd).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([d]) => WD[d]),
      hour_band: hourBand(Object.entries(hr).sort((a, b) => b[1] - a[1])[0]?.[0]),
      first_date: days[0], last_date: days[days.length - 1] };
    pl.home = !!(home && Number.isFinite(home.lat) && distM(pl, home) <= DBSCAN_EPS_M);   // 집 주소가 같은 장소 범위(Eps) 안이면 집
    return pl;
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
