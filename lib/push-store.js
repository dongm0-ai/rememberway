// 일지 알림 구독 관리 (Supabase 테이블: push_subs, app_kv — docs/supabase.sql)
import crypto from "node:crypto";
import { db } from "./kv.js";
import { generateVapidKeys } from "./webpush.js";

export const todayKST = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
export const subId = (endpoint) => crypto.createHash("sha256").update(String(endpoint)).digest("hex").slice(0, 24);

/** VAPID 키: 환경변수가 있으면 그것, 없으면 app_kv 에 한 번 만들어 두고 계속 쓴다 (키가 바뀌면 기존 구독이 모두 무효가 되므로) */
export async function getVapid() {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  const read = async () => (await db("GET", "app_kv?key=eq.vapid&select=value"))?.[0]?.value;
  const saved = await read();
  if (saved) return JSON.parse(saved);
  await db("POST", "app_kv", { key: "vapid", value: JSON.stringify(generateVapidKeys()) }, "resolution=ignore-duplicates,return=minimal");
  return JSON.parse(await read()); // 동시에 만들어졌어도 먼저 저장된 하나를 쓴다
}

export async function saveSub(sub, last) {
  const id = subId(sub.endpoint);
  const prev = (await db("GET", `push_subs?id=eq.${id}&select=last`))?.[0];
  await db("POST", "push_subs", { id, endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth, last: last || prev?.last || null }, "resolution=merge-duplicates,return=minimal");
  return id;
}
export async function markDone(endpoint, date) {
  const rows = await db("PATCH", `push_subs?id=eq.${subId(endpoint)}`, { last: date }, "return=representation");
  return Boolean(rows?.length);
}
export const removeSub = (endpoint) => db("DELETE", `push_subs?id=eq.${subId(endpoint)}`, null, "return=minimal");
export async function allSubs() {
  const rows = (await db("GET", "push_subs?select=id,endpoint,p256dh,auth,last")) || [];
  return rows.map((r) => ({ id: r.id, last: r.last, sub: { endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } } }));
}
