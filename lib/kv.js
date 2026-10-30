// 알림 구독 저장소 — Upstash Redis REST (fetch만, 의존성 0). Vercel Marketplace에서 Upstash를 연결하면 환경변수가 자동으로 생긴다.
// 저장하는 것: 푸시 구독 주소(endpoint·keys)와 "마지막으로 일지 쓴 날짜"뿐. 이름·주소·일지 내용은 저장하지 않는다 (일지는 보호자 기기에만).
const URL_ = () => process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = () => process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
export const kvReady = () => Boolean(URL_() && TOKEN());

export async function kv(...cmd) {
  if (!kvReady()) throw Object.assign(new Error("KV not configured"), { reason: "NO_STORE" });
  const r = await fetch(URL_(), { method: "POST", headers: { Authorization: `Bearer ${TOKEN()}`, "Content-Type": "application/json" }, body: JSON.stringify(cmd), signal: AbortSignal.timeout(6000) });
  const d = await r.json();
  if (d.error) throw Object.assign(new Error(d.error), { reason: "STORE_ERROR" });
  return d.result;
}
