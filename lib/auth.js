// 보호자 계정 — 서버에서 로그인 토큰(Supabase Auth JWT)을 확인한다. 의존성 0, fetch만 사용.
// 비밀번호·이메일 저장은 Supabase Auth가 맡고, 우리 서버는 토큰이 누구 것인지만 물어본다.
// env 는 호출할 때 읽는다 (테스트·Vercel 환경변수 변경 모두 안전).
const BASE = () => (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const ANON = () => process.env.SUPABASE_ANON_KEY || "";

/** 요청 헤더 "Authorization: Bearer <토큰>" 에서 토큰만 꺼낸다. 없으면 null */
export function bearer(req) {
  const h = req?.headers?.authorization;
  if (typeof h !== "string") return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(h);
  return m ? m[1] : null;
}

/** 토큰 확인. { user:{id,email} } | { error:"INVALID" } (토큰 없음·무효 → 다시 로그인) | { error:"UNAVAILABLE" } (Auth 장애·시간 초과 → 로그인 화면으로 보내지 않음)
 *  INVALID = Auth 가 4xx(429 제외)로 거절. 그 밖의 실패(네트워크·5xx·429·이상한 응답)는 모두 UNAVAILABLE */
export async function checkToken(token, fetchFn = fetch) {
  if (typeof token !== "string" || !token) return { error: "INVALID" };
  let r;
  try {
    r = await fetchFn(`${BASE()}/auth/v1/user`, {
      headers: { apikey: ANON(), Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(6000),
    });
  } catch {
    return { error: "UNAVAILABLE" };
  }
  if (!r) return { error: "UNAVAILABLE" };
  if (!r.ok) return { error: r.status >= 400 && r.status < 500 && r.status !== 429 ? "INVALID" : "UNAVAILABLE" };
  try {
    const u = await r.json();
    if (!u || typeof u.id !== "string" || !u.id) return { error: "UNAVAILABLE" };
    return { user: { id: u.id, email: typeof u.email === "string" ? u.email : "" } };
  } catch {
    return { error: "UNAVAILABLE" };
  }
}

/** 토큰 → { id, email } (Supabase Auth GET /auth/v1/user). 잘못된 토큰·장애·시간 초과는 모두 null */
export async function userFromToken(token, fetchFn = fetch) {
  return (await checkToken(token, fetchFn)).user ?? null;
}
