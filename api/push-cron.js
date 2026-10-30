// /api/push-cron — Vercel Cron이 매일 18시(1회차)·21시(2회차, 한국 시간)에 부른다 (vercel.json "crons").
// 오늘 일지를 아직 안 쓴 구독에만 알림. "쓸 때까지 반복": 18시에 안 썼으면 21시에 한 번 더.
import { send } from "../lib/http.js";
import { kvReady } from "../lib/kv.js";
import { getVapid, allSubs, removeSub, todayKST } from "../lib/push-store.js";
import { sendPush } from "../lib/webpush.js";

export default async function handler(req, res) {
  // Vercel은 CRON_SECRET 환경변수가 있으면 Authorization: Bearer <CRON_SECRET> 을 붙여 부른다. 없으면 Vercel Cron 요청만 허용.
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.authorization || "";
  const fromCron = /vercel-cron/i.test(req.headers["user-agent"] || "");
  if (secret ? auth !== `Bearer ${secret}` : !fromCron) return send(res, 401, { ok: false, reason: "UNAUTHORIZED" });
  if (!kvReady()) return send(res, 200, { ok: false, reason: "NO_STORE" });
  const round = new URL(req.url, "http://x").searchParams.get("round") === "2" ? 2 : 1;
  const today = todayKST();
  const vapid = await getVapid();
  const msg = round === 1
    ? { title: "오늘 일지를 아직 안 쓰셨어요", body: "어르신이 오늘 어디 다녀오셨는지 10초만 남겨 주세요. 다음 실종 때 큰 도움이 됩니다.", url: "/diary" }
    : { title: "잊지 마세요 — 오늘 일지", body: "아직 오늘 기록이 없어요. 다녀온 곳을 눌러 저장만 하면 끝나요.", url: "/diary" };
  let sent = 0, skipped = 0, removed = 0, failed = 0;
  for (const s of await allSubs()) {
    if (s.last === today) { skipped++; continue; }
    try { const r = await sendPush(s.sub, msg, vapid); if (r.gone) { await removeSub(s.sub.endpoint); removed++; } else if (r.status < 300) sent++; else failed++; }
    catch { failed++; }
  }
  return send(res, 200, { ok: true, round, today, sent, skipped, removed, failed });
}
