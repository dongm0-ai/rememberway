// GET /api/config — 브라우저에 줘도 되는 설정만 (AI 상태). 비밀 키는 절대 내보내지 않는다.
import { aiStatus } from "../lib/http.js";

/** Supabase 공개 설정. Vercel 의 Supabase 연동은 NEXT_PUBLIC_ 이름으로 넣으므로 그것도 받는다 (lib/auth.js·lib/kv.js 와 같은 대체) */
export const supabasePublic = (env = process.env) => ({
  url: env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || null,
  anonKey: env.SUPABASE_ANON_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY || null,
});

export default function handler(req, res) {
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  // 지도는 네이버만 (2026-11-02). 네이버 지도 Client ID는 원래 브라우저에 공개되는 값이고, 네이버클라우드 콘솔의 "Web 서비스 URL"로 우리 도메인만 쓰게 묶는다. Secret은 절대 내보내지 않는다.
  // 로그인(Supabase Auth)용: URL과 anon 키는 원래 브라우저에 공개되는 값 (RLS로 막혀 있음). service_role 키는 절대 내보내지 않는다.
  res.end(JSON.stringify({ ai: aiStatus(), map: { provider: "naver", naverClientId: process.env.NAVER_CLIENT_ID || null }, supabase: supabasePublic() }));
}
