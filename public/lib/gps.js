// REMEMBER WAY AI — GPS 기록 → 오래 머문 곳 (규칙, 코드). 생성형 AI는 머문 곳을 정하지 않는다.
// 원본 기록(점)은 저장하지 않는다. 계산은 보호자 기기 안에서만 하고, 보호자가 확인한 장소 이름과 날짜만 일지에 남긴다.
// 위치를 예측하지 않는다: "지난 기록에서 몇 번, 얼마나 머물렀는지"를 셀 뿐이다.
import { GPS_RULES } from "./schema.js";

const R = 6371000, rad = (x) => (x * Math.PI) / 180;
export const distM = (a, b) => { const dl = rad(b.lat - a.lat), dg = rad(b.lng - a.lng); const h = Math.sin(dl / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dg / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
const localDate = (t) => new Date(t).toLocaleDateString("sv-SE");
const WD = ["일", "월", "화", "수", "목", "금", "토"];

/** 기록 파일(CSV·GPX·목걸이 로그) → [{t(ms), lat, lng}] 시간순. 못 읽는 줄은 건너뛴다 */
export function parseTrack(text) {
  text = String(text ?? "").replace(/^﻿/, "");
  const pts = [];
  if (/<gpx|<trkpt/i.test(text)) {
    for (const m of text.matchAll(/<trkpt\b([^>]*)>([\s\S]*?)<\/trkpt>/gi)) {
      const lat = Number((m[1].match(/lat="([^"]+)"/) ?? [])[1]), lng = Number((m[1].match(/lon="([^"]+)"/) ?? [])[1]);
      const t = Date.parse((m[2].match(/<time>([^<]+)<\/time>/) ?? [])[1]);
      if (valid(lat, lng, t)) pts.push({ t, lat, lng });
    }
    return pts.sort((a, b) => a.t - b.t);
  }
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^(BEGIN|END|#)/.test(l));
  if (!lines.length) return pts;
  const sep = lines[0].includes(";") && !lines[0].includes(",") ? ";" : lines[0].includes("\t") ? "\t" : ",";
  const head = lines[0].toLowerCase().split(sep).map((s) => s.replace(/"/g, "").trim());
  const hasHead = head.some((h) => /lat|lon|lng|time|date/.test(h));
  const find = (re) => head.findIndex((h) => re.test(h));
  // 헤더가 없으면 목걸이 로그 형식: 시각,위도,경도
  let iT = 0, iLat = 1, iLng = 2, iDate = -1, iAcc = -1;
  if (hasHead) {
    iLat = find(/^lat/); iLng = find(/^(lon|lng)/); iT = find(/time|timestamp|시각|시간/); iDate = find(/^date$|날짜/); iAcc = find(/^acc/);
    if (iT === iDate) iDate = -1;
  }
  for (const line of hasHead ? lines.slice(1) : lines) {
    const c = line.split(sep).map((s) => s.replace(/"/g, "").trim());
    const lat = Number(c[iLat]), lng = Number(c[iLng]);
    let ts = iDate >= 0 && c[iT] && !/\d{4}-\d{2}-\d{2}/.test(c[iT]) ? `${c[iDate]}T${c[iT]}` : c[iT];
    const t = /^\d{10,13}$/.test(ts ?? "") ? Number(ts) * (ts.length === 10 ? 1000 : 1) : Date.parse(String(ts ?? "").replace(" ", "T"));
    if (iAcc >= 0 && Number(c[iAcc]) > GPS_RULES.MAX_ACCURACY_M) continue;
    if (valid(lat, lng, t)) pts.push({ t, lat, lng });
  }
  return pts.sort((a, b) => a.t - b.t);
}
const valid = (lat, lng, t) => Number.isFinite(lat) && Number.isFinite(lng) && Number.isFinite(t) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);

/** 점 → 머묾 [{lat,lng,start,end,minutes}]: 첫 점에서 STAY_RADIUS_M 안에 STAY_MIN분 이상 있으면 한 번 머문 것 */
export function findStays(pts, rules = GPS_RULES) {
  const stays = [];
  let i = 0;
  while (i < pts.length) {
    let j = i + 1;
    while (j < pts.length && distM(pts[i], pts[j]) <= rules.STAY_RADIUS_M) j++;
    const span = (pts[j - 1].t - pts[i].t) / 60000;
    if (span >= rules.STAY_MIN) {
      const g = pts.slice(i, j);
      stays.push({ lat: avg(g, "lat"), lng: avg(g, "lng"), start: pts[i].t, end: pts[j - 1].t, minutes: Math.round(span) });
      i = j;
    } else i++;
  }
  return stays;
}
const avg = (a, k) => a.reduce((s, x) => s + x[k], 0) / a.length;

/** 머묾 → 같은 곳끼리 묶기 → 장소 목록 (머문 날이 많은 순). home: {lat,lng} 이 있으면 그 근처는 집으로 표시 */
export function groupPlaces(stays, home = null, rules = GPS_RULES) {
  const groups = [];
  for (const s of stays) {
    let g = groups.find((x) => distM(x, s) <= rules.CLUSTER_M);
    if (!g) { g = { lat: s.lat, lng: s.lng, stays: [] }; groups.push(g); }
    g.stays.push(s);
    g.lat = avg(g.stays, "lat"); g.lng = avg(g.stays, "lng");
  }
  const places = groups.map((g, k) => {
    const days = [...new Set(g.stays.map((s) => localDate(s.start)))].sort();
    const total = g.stays.reduce((a, s) => a + s.minutes, 0);
    const wd = {}, hr = {};
    for (const s of g.stays) { const d = new Date(s.start); wd[d.getDay()] = (wd[d.getDay()] ?? 0) + 1; const h = d.getHours(); hr[h] = (hr[h] ?? 0) + 1; }
    const night = g.stays.some((s) => s.minutes >= 240 || [0, 1, 2, 3, 4].some((h) => coversHour(s, h)));
    return {
      id: `g${k + 1}`, lat: +g.lat.toFixed(5), lng: +g.lng.toFixed(5), days, visits: g.stays.length, total_min: total, avg_min: Math.round(total / g.stays.length),
      weekdays: Object.entries(wd).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([d]) => WD[d]),
      hour_band: hourBand(Object.entries(hr).sort((a, b) => b[1] - a[1])[0]?.[0]),
      first_date: days[0], last_date: days[days.length - 1], night,
    };
  });
  // 집: 등록한 집 주소 200m 안. 집 주소가 없으면 밤을 보낸(새벽 0~4시가 걸치거나 4시간 이상 머문) 곳 중 가장 오래 머문 곳
  if (home && Number.isFinite(home.lat)) for (const p of places) p.home = distM(p, home) <= rules.HOME_M;
  else { const n = places.filter((p) => p.night).sort((a, b) => b.total_min - a.total_min)[0]; if (n) n.home = true; }
  return places.sort((a, b) => b.days.length - a.days.length || b.total_min - a.total_min);
}
const coversHour = (s, h) => { for (let t = s.start; t <= s.end; t += 30 * 60000) if (new Date(t).getHours() === h) return true; return false; };
function hourBand(h) {
  if (h === undefined) return null; h = Number(h);
  if (h === 12) return "낮 12시쯤";
  const part = h < 6 ? "새벽" : h < 12 ? "오전" : h < 18 ? "오후" : "저녁";
  return `${part} ${((h + 11) % 12) + 1}시쯤`;
}

/** 기록 요약 (기록 날 수, 기간) */
export function trackSummary(pts) {
  if (!pts.length) return { points: 0, days: 0, period_days: 0 };
  const days = new Set(pts.map((p) => localDate(p.t)));
  return { points: pts.length, days: days.size, period_days: Math.round((pts[pts.length - 1].t - pts[0].t) / 86400000) + 1, from: localDate(pts[0].t), to: localDate(pts[pts.length - 1].t) };
}

/** 보호자에게 되물을 기본 질문 (AI를 못 쓸 때도 같은 화면이 되게) */
export function templateQuestion(p, label, period) {
  return `${label} 근처에 ${period}일 중 ${p.days.length}일, 한 번에 평균 ${p.avg_min}분 머무르셨어요${p.weekdays.length ? ` (주로 ${p.weekdays.join("·")}요일${p.hour_band ? ` ${p.hour_band}` : ""})` : ""}. 어르신이 좋아하시는 곳인가요?`;
}

/** 시험용 모의 기록 (가짜 데이터, 화면에 "모의"로 표시). center 주변에 3주치: 경로당(자주), 공원(최근 늘어남), 시장(가끔) */
export function mockTrack(center, now = Date.now()) {
  const c = center && Number.isFinite(center.lat) ? center : { lat: 36.3155, lng: 127.4265 };
  const off = (dx, dy) => ({ lat: c.lat + dy / 111000, lng: c.lng + dx / (111000 * Math.cos(rad(c.lat))) });
  const P = { home: off(0, 0), hall: off(350, 150), park: off(-600, 700), market: off(900, -400) };
  const pts = [], day0 = new Date(now); day0.setHours(0, 0, 0, 0);
  const jitter = () => (Math.random() - 0.5) * 0.0004;
  const stay = (p, t0, min) => { for (let m = 0; m <= min; m += 2) pts.push({ t: t0 + m * 60000, lat: p.lat + jitter() * 0.3, lng: p.lng + jitter() * 0.3 }); };
  const walk = (a, b, t0, min) => { for (let m = 0; m <= min; m += 1) { const f = m / min; pts.push({ t: t0 + m * 60000, lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f }); } };
  for (let d = 21; d >= 1; d--) {
    const base = day0.getTime() - d * 86400000, wd = new Date(base).getDay();
    let t = base + 9 * 3600000; stay(P.home, t, 60); t += 62 * 60000;
    const go = (p, min) => { walk(P.home, p, t, 12); t += 13 * 60000; stay(p, t, min); t += (min + 1) * 60000; walk(p, P.home, t, 12); t += 13 * 60000; stay(P.home, t, 40); t += 41 * 60000; };
    if ([1, 3, 5].includes(wd)) go(P.hall, 80);                 // 월·수·금 경로당
    if (d <= 9 && d % 2 === 0) go(P.park, 45);                   // 최근 열흘 공원이 늘어남
    if (d === 18 || d === 11 || d === 4) go(P.market, 30);       // 가끔 시장
  }
  return pts;
}
export function toCsv(pts) { return "time,lat,lon\n" + pts.map((p) => `${new Date(p.t).toISOString()},${p.lat.toFixed(6)},${p.lng.toFixed(6)}`).join("\n"); }
