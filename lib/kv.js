// 서버 저장소 — Supabase (PostgREST REST API를 fetch로 직접, 의존성 0). 서버 함수에서만 쓴다. (알림 구독 저장소로 시작해 지금은 위치 기록·보호자 계정 데이터도 여기로 읽고 쓴다)
// Vercel Marketplace에서 Supabase를 연결하면 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 가 자동으로 생긴다.
// 테이블은 docs/supabase.sql 을 Supabase SQL Editor에서 한 번 실행해 만든다 (RLS 켜짐, 정책 없음 → 브라우저 키로는 못 읽음).
// 저장하는 것: ① 푸시 구독 주소(endpoint·keys)와 "마지막으로 일지 쓴 날짜" ② 위치 기록 loc_events(연결 코드 해시·좌표·시각, 30일 뒤 자동 삭제)
//   ③ 보호자 계정 데이터: 어르신 호칭, 가족 구성(누가 어느 어르신의 owner·member인지), 가족이 저장한 프로필·일지·찾은 뒤 기록, 초대 토큰의 해시.
// 서버에 남는 사람 정보는 로그인 이메일(Supabase Auth)뿐이다. 이름·전화번호·집 주소·집 좌표·보호자가 말한 원문 전체는 저장하지 않는다 (앱 쪽 public/js/family.js 가 올리기 전에 뺀다).
const BASE = () => (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
const KEY = () => process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
export const kvReady = () => Boolean(BASE() && KEY());

/** db("GET", "push_subs?select=*") 처럼 부른다. 반환: JSON(없으면 null) */
export async function db(method, path, body, prefer) {
  if (!kvReady()) throw Object.assign(new Error("Supabase not configured"), { reason: "NO_STORE" });
  const headers = { apikey: KEY(), Authorization: `Bearer ${KEY()}`, "Content-Type": "application/json" };
  if (prefer) headers.Prefer = prefer;
  const r = await fetch(`${BASE()}/rest/v1/${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(6000) });
  const text = await r.text();
  if (!r.ok) throw Object.assign(new Error(text.slice(0, 160)), { reason: r.status === 404 ? "NO_TABLE" : "STORE_ERROR" });
  return text ? JSON.parse(text) : null;
}
