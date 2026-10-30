// 일지 알림 구독 관리. 키: rw:vapid (VAPID 키 한 쌍), rw:subs (해시: id → {sub, last, created})
import crypto from "node:crypto";
import { kv } from "./kv.js";
import { generateVapidKeys } from "./webpush.js";

export const todayKST = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
export const subId = (endpoint) => crypto.createHash("sha256").update(String(endpoint)).digest("hex").slice(0, 24);

/** VAPID 키: 환경변수가 있으면 그것, 없으면 저장소에 한 번 만들어 두고 계속 쓴다 (키가 바뀌면 기존 구독이 모두 무효가 되므로) */
export async function getVapid() {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  const saved = await kv("GET", "rw:vapid");
  if (saved) return JSON.parse(saved);
  const fresh = generateVapidKeys();
  const ok = await kv("SET", "rw:vapid", JSON.stringify(fresh), "NX"); // 동시에 두 번 만들어지지 않게
  return ok ? fresh : JSON.parse(await kv("GET", "rw:vapid"));
}

export async function saveSub(sub, last) {
  const id = subId(sub.endpoint);
  const prev = await kv("HGET", "rw:subs", id);
  const rec = { sub: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }, last: last || (prev ? JSON.parse(prev).last : null), created: prev ? JSON.parse(prev).created : todayKST() };
  await kv("HSET", "rw:subs", id, JSON.stringify(rec));
  return id;
}
export async function markDone(endpoint, date) {
  const id = subId(endpoint);
  const prev = await kv("HGET", "rw:subs", id);
  if (!prev) return false;
  const rec = JSON.parse(prev); rec.last = date; await kv("HSET", "rw:subs", id, JSON.stringify(rec));
  return true;
}
export const removeSub = (endpoint) => kv("HDEL", "rw:subs", subId(endpoint));
export async function allSubs() {
  const flat = (await kv("HGETALL", "rw:subs")) || [];
  const out = [];
  for (let i = 0; i < flat.length; i += 2) { try { out.push({ id: flat[i], ...JSON.parse(flat[i + 1]) }); } catch {} }
  return out;
}
