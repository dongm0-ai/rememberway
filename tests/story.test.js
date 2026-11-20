// 오늘 GPS 기록 → 보호자가 고쳐 쓸 문장 (public/lib/story.js). 코드 규칙만, AI 없음.
import test from "node:test";
import assert from "node:assert/strict";
import { lastTrip, storyPoints, storyText, shortPlace, koTime } from "../public/lib/story.js";

const HOME = { lat: 36.30846, lng: 127.43884 };
const T0 = new Date(2026, 10, 22, 15, 4, 0).getTime();
// 집에서 북동쪽으로 10초마다 약 9m씩 걷다가 끊김
const walk = (t0, n, from = HOME, dLat = 0.00007, dLng = 0.00004) => Array.from({ length: n }, (_, i) => ({ t: t0 + i * 10000, lat: from.lat + dLat * i, lng: from.lng + dLng * i }));

test("lastTrip: 5분 넘게 비면 마지막 나들이만", () => {
  const morning = walk(T0 - 3 * 3600000, 10);
  const now = walk(T0, 20);
  assert.equal(lastTrip([...morning, ...now]).length, 20);
  assert.equal(lastTrip([]).length, 0);
});

test("storyPoints: 집 근처 출발, 움직이다 끊김, 가던 방향의 등록 장소", () => {
  const pts = walk(T0, 50);
  const end = pts[pts.length - 1];
  const sp = storyPoints(pts, { home: HOME, places: [{ name: "믿음건강원", lat: end.lat + 0.0014, lng: end.lng + 0.0008 }, { name: "반대쪽 절", lat: HOME.lat - 0.003, lng: HOME.lng }] });
  assert.equal(sp.startNearHome, true);
  assert.equal(sp.motion.state, "moving_lost");
  assert.equal(sp.toward, "믿음건강원");
});

test("storyText: 시각·방향·끊긴 곳, 집 주소는 쓰지 않음", () => {
  const pts = walk(T0, 50);
  const sp = storyPoints(pts, { home: HOME, places: [] });
  const s = storyText(sp, { start: "석교동 사득로54번길", mid: "부사동 보문로", end: "부사동 보문로47번길" });
  assert.match(s, /^GPS 기록으로는 오늘 오후 3시 4분쯤 집 근처에서 걷기 시작해 부사동 보문로 쪽을 지나 북동쪽으로 가고 계셨어요\./);
  assert.match(s, /오후 3시 12분 부사동 보문로47번길 근처에서 시속 약 \d+km로 걷던 중 목걸이 GPS가 끊겼어요\./);
  assert.doesNotMatch(s, /사득로54번길/);   // 집 근처 출발이면 출발지 주소 이름을 쓰지 않는다
});

test("storyText: 멈춘 뒤 끊김", () => {
  const pts = Array.from({ length: 30 }, (_, i) => ({ t: T0 + i * 10000, lat: 36.3125, lng: 127.4425 }));
  pts.unshift({ t: T0 - 60000, lat: 36.312, lng: 127.442 });
  const s = storyText(storyPoints(pts, { home: HOME }), { end: "부사동 보문로" });
  assert.match(s, /부사동 보문로 근처에 머무신 뒤/);
});

test("storyPoints: 점이 2개보다 적으면 null, storyText(null) 은 빈 문자열", () => {
  assert.equal(storyPoints([{ t: T0, lat: 1, lng: 1 }]), null);
  assert.equal(storyText(null), "");
});

test("shortPlace: 시·구·번지는 빼고 동·길까지", () => {
  assert.equal(shortPlace({ label: "대전광역시 중구 부사동", road: "대전광역시 중구 보문로47번길 47" }), "부사동 보문로47번길");
  assert.equal(shortPlace({ label: "대전광역시 중구 석교동", road: null }), "석교동");
  assert.equal(shortPlace(null), null);
});

test("koTime", () => {
  assert.equal(koTime(new Date(2026, 0, 1, 15, 4).getTime()), "오후 3시 4분");
  assert.equal(koTime(new Date(2026, 0, 1, 0, 0).getTime()), "오전 12시");
});

test("집에서 가까운 지나간 곳·끊긴 곳은 도로명을 쓰지 않는다 (집 도로명이 AI로 가지 않게)", () => {
  const near = walk(T0, 20, HOME, 0.00001, 0.00001);   // 집 앞 20m 안에서만 움직임
  const sp = storyPoints(near, { home: HOME });
  assert.equal(sp.mid, null);
  assert.equal(sp.endNearHome, true);
  const s = storyText(sp, { end: "석교동 사득로54번길" });
  assert.doesNotMatch(s, /사득로54번길/);
  assert.match(s, /집 근처/);
  const far = storyPoints(walk(T0, 80), { home: HOME });   // 약 700m 걸음 → 가운데 점은 집에서 300m 넘음
  assert.ok(far.mid);
});
