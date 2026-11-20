// 원격 부저·위치 단말 등록 (api/loc.js 의 buzz.* · cmd.* · device.report · device.status)
import test from "node:test";
import assert from "node:assert/strict";
import { route, makeHandler, CMD_TTL_MS } from "../api/loc.js";
import { deviceHashOf } from "../lib/family.js";
import { memDb } from "./mem-db.js";

const U1 = { id: "11111111-1111-4111-8111-111111111111", email: "a@b.c" };
const U2 = { id: "22222222-2222-4222-8222-222222222222", email: "d@e.f" };
const E1 = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const E2 = "ffffffff-ffff-4fff-8fff-ffffffffffff";   // 연결 코드가 아직 없는 어르신
const KEY = "ABCDEFGHIJKLMNOP", OTHER_KEY = "QRSTUVWXYZ234567";
const DEV = deviceHashOf(KEY);
const P = { latitude: 37.5, longitude: 127.0, fix_age_ms: 100, gps_time: "2026-11-20T00:00:00Z" };
const throwingFam = new Proxy({}, { get: () => async () => { throw new Error("fam must not be called"); } });

/** 어르신 E1(연결 코드 있음, U1 이 member)·E2(코드 없음) 가 있는 저장소 + 움직일 수 있는 시계 */
function world() {
  const db = memDb({
    elders: [{ id: E1, label: "어머니", device_hash: DEV }, { id: E2, label: "아버지", device_hash: null }],
    elder_members: [{ elder_id: E1, user_id: U1.id, role: "member" }, { elder_id: E2, user_id: U1.id, role: "owner" }],
  });
  let t = Date.parse("2026-11-20T05:00:00.000Z");
  const ctx = { db, fam: throwingFam, now: () => new Date(t) };
  return {
    db,
    tick: (ms) => { t += ms; },
    guardian: (body, user = U1) => route(body, { ...ctx, user }),
    phone: (body) => route(body, ctx),
  };
}

test("buzz.send: login and membership are required; elder without a connection code → 409 NO_DEVICE", async () => {
  const w = world();
  assert.equal((await w.phone({ action: "buzz.send", elderId: E1, command: "BUZZER_FIND" })).status, 401);
  const stranger = await w.guardian({ action: "buzz.send", elderId: E1, command: "BUZZER_FIND" }, U2);
  assert.equal(stranger.status, 404);
  assert.equal(stranger.body.reason, "GONE");
  const noDevice = await w.guardian({ action: "buzz.send", elderId: E2, command: "BUZZER_FIND" });
  assert.equal(noDevice.status, 409);
  assert.equal(noDevice.body.reason, "NO_DEVICE");
  assert.equal((await w.guardian({ action: "buzz.send", elderId: E1, command: "REBOOT" })).status, 400);
  assert.equal((w.db.tables.device_commands ?? []).length, 0, "nothing stored");
});

test("full relay: send → phone fetches (delivered) → phone reports ACK → guardian sees accepted", async () => {
  const w = world();
  const sent = await w.guardian({ action: "buzz.send", elderId: E1, command: "BUZZER_FIND" });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.status, "pending");
  const id = sent.body.id;
  assert.equal(Date.parse(sent.body.expires_at) - Date.parse(sent.body.now), CMD_TTL_MS);
  assert.equal(w.db.tables.device_commands[0].dev, DEV, "stored under the code hash, not the code");
  assert.equal(w.db.tables.device_commands[0].created_by, U1.id);

  const status = (i = id) => w.guardian({ action: "buzz.status", elderId: E1, id: i });
  assert.equal((await status()).body.status, "pending");

  w.tick(4000);
  const got = await w.phone({ action: "cmd.pending", key: KEY });
  assert.equal(got.status, 200);
  assert.deepEqual(got.body.commands, [{ id, command: "BUZZER_FIND", expires_at: sent.body.expires_at }]);
  assert.equal((await status()).body.status, "delivered");
  // 결과가 오기 전에는 다시 물어도 같은 명령을 준다 (응답을 잃어도 명령이 사라지지 않게)
  assert.equal((await w.phone({ action: "cmd.pending", key: KEY })).body.commands.length, 1);

  const done = await w.phone({ action: "cmd.result", key: KEY, id, status: "accepted", response: "ACK_FIND" });
  assert.deepEqual(done.body, { ok: true, status: "accepted" });
  const final = (await status()).body;
  assert.equal(final.status, "accepted");
  assert.equal(final.response, "ACK_FIND");
  assert.deepEqual((await w.phone({ action: "cmd.pending", key: KEY })).body.commands, [], "finished command is not handed out again");
});

test("location push carries waiting commands, so the phone need not ask separately", async () => {
  const w = world();
  const { body: { id } } = await w.guardian({ action: "buzz.send", elderId: E1, command: "BUZZER_ON" });
  const r = await w.phone({ action: "push", key: KEY, p: P });
  assert.equal(r.status, 201);
  assert.equal(r.body.commands?.[0]?.id, id);
  assert.equal(w.db.tables.device_commands[0].status, "delivered");
  // 기다리는 명령이 없으면 commands 칸 자체가 없다 (옛 앱 응답과 같은 모양)
  await w.phone({ action: "cmd.result", key: KEY, id, status: "failed", response: "ble_disconnected" });
  assert.equal("commands" in (await w.phone({ action: "push", key: KEY, p: P })).body, false);
});

test("push still succeeds when the command table is missing (code deployed before the SQL is run)", async () => {
  const inner = memDb();
  const db = async (m, path, ...rest) => {
    if (path.startsWith("device_commands")) throw Object.assign(new Error("no table"), { reason: "NO_TABLE" });
    return inner(m, path, ...rest);
  };
  const r = await route({ action: "push", key: KEY, p: P }, { db, fam: throwingFam });
  assert.equal(r.status, 201);
  assert.equal(inner.tables.loc_events.length, 1);
});

test("a command not delivered in time expires: never handed to the phone late, shown as expired", async () => {
  const w = world();
  const { body: { id } } = await w.guardian({ action: "buzz.send", elderId: E1, command: "BUZZER_FIND" });
  w.tick(CMD_TTL_MS + 1);
  assert.deepEqual((await w.phone({ action: "cmd.pending", key: KEY })).body.commands, []);
  assert.equal("commands" in (await w.phone({ action: "push", key: KEY, p: P })).body, false);
  assert.equal((await w.guardian({ action: "buzz.status", elderId: E1, id })).body.status, "expired");
});

test("ring buttons cannot be hammered, but stop always goes through", async () => {
  const w = world();
  assert.equal((await w.guardian({ action: "buzz.send", elderId: E1, command: "BUZZER_FIND" })).status, 200);
  w.tick(1000);
  const again = await w.guardian({ action: "buzz.send", elderId: E1, command: "BUZZER_ON" });
  assert.equal(again.status, 429);
  assert.equal(again.body.reason, "RATE_LIMIT");
  assert.equal((await w.guardian({ action: "buzz.send", elderId: E1, command: "BUZZER_OFF" })).status, 200);
  w.tick(3000);
  assert.equal((await w.guardian({ action: "buzz.send", elderId: E1, command: "BUZZER_FIND" })).status, 200);
  // 휴대폰은 누른 순서대로 받는다
  assert.deepEqual((await w.phone({ action: "cmd.pending", key: KEY })).body.commands.map((c) => c.command), ["BUZZER_FIND", "BUZZER_OFF", "BUZZER_FIND"]);
});

test("cmd.result: a settled result is not overwritten; another code cannot touch the command", async () => {
  const w = world();
  const { body: { id } } = await w.guardian({ action: "buzz.send", elderId: E1, command: "BUZZER_FIND" });
  const other = await w.phone({ action: "cmd.result", key: OTHER_KEY, id, status: "accepted", response: "ACK_FIND" });
  assert.equal(other.status, 404);
  assert.equal(other.body.reason, "NO_COMMAND");
  assert.equal(w.db.tables.device_commands[0].status, "pending");

  await w.phone({ action: "cmd.result", key: KEY, id, status: "failed", response: "ack_missing" });
  const late = await w.phone({ action: "cmd.result", key: KEY, id, status: "accepted", response: "ACK_FIND" });
  assert.deepEqual(late.body, { ok: true, status: "failed" });
  assert.equal((await w.guardian({ action: "buzz.status", elderId: E1, id })).body.response, "ack_missing");

  for (const bad of [{ id: "nope", status: "accepted" }, { id, status: "completed" }, { id }]) {
    assert.equal((await w.phone({ action: "cmd.result", key: KEY, ...bad })).status, 400, JSON.stringify(bad));
  }
});

test("buzz.status of another elder's command → 404 (the id alone is not enough)", async () => {
  const w = world();
  const { body: { id } } = await w.guardian({ action: "buzz.send", elderId: E1, command: "BUZZER_FIND" });
  w.db.tables.elders.find((e) => e.id === E2).device_hash = deviceHashOf(OTHER_KEY);
  const r = await w.guardian({ action: "buzz.status", elderId: E2, id });
  assert.equal(r.status, 404);
  assert.equal(r.body.reason, "NO_COMMAND");
});

test("revoked connection code → 410 on every phone action, nothing written", async () => {
  const w = world();
  w.db.tables.revoked_devices = [{ device_hash: DEV }];
  for (const body of [
    { action: "cmd.pending", key: KEY },
    { action: "cmd.result", key: KEY, id: E1, status: "accepted" },
    { action: "device.report", key: KEY, tracker: { name: "GPS-TRACKER-001" }, ble: "connected", gps: "valid" },
  ]) {
    const r = await w.phone(body);
    assert.equal(r.status, 410, body.action);
    assert.equal(r.body.reason, "GONE");
  }
  assert.equal((w.db.tables.device_status ?? []).length, 0);
  assert.equal((await w.phone({ action: "cmd.pending", key: "short" })).body.reason, "BAD_KEY");
});

test("device.report registers the linked tracker; guardians read it with device.status", async () => {
  const w = world();
  assert.deepEqual((await w.guardian({ action: "device.status", elderId: E1 })).body.device, null);
  const rep = await w.phone({
    action: "device.report", key: KEY, ble: "connected", gps: "valid", app: "0.3.0",
    tracker: { name: "GPS-TRACKER-001", id: "tracker-001", fw: "1.0.0", address: "30:ED:A0:58:D6:C2" },
  });
  assert.equal(rep.status, 200);
  const d = (await w.guardian({ action: "device.status", elderId: E1 })).body.device;
  assert.equal(d.tracker_name, "GPS-TRACKER-001");
  assert.equal(d.tracker_id, "tracker-001");
  assert.equal(d.ble_state, "connected");
  assert.equal("dev" in d, false, "the code hash is not sent to the browser");
  assert.equal(JSON.stringify(w.db.tables.device_status).includes("30:ED"), false, "Bluetooth address is never stored");

  // 다시 알리면 같은 줄을 고친다 (추적기를 바꿔 연동한 경우 포함). 모르는 상태 값·이상한 글자는 버린다
  await w.phone({ action: "device.report", key: KEY, ble: "hacked", gps: "waiting", tracker: { name: "GPS-TRACKER-002<script>", id: 7 } });
  assert.equal(w.db.tables.device_status.length, 1);
  const d2 = (await w.guardian({ action: "device.status", elderId: E1 })).body.device;
  assert.equal(d2.tracker_name, "GPS-TRACKER-002script");
  assert.equal(d2.tracker_id, null);
  assert.equal(d2.ble_state, null);
  assert.equal(d2.gps_state, "waiting");
  // 코드가 없는 어르신은 단말 없음, member 가 아니면 404
  assert.deepEqual((await w.guardian({ action: "device.status", elderId: E2 })).body.device, null);
  assert.equal((await w.guardian({ action: "device.status", elderId: E1 }, U2)).status, 404);
});

test("old command records are deleted after a day", async () => {
  const w = world();
  await w.guardian({ action: "buzz.send", elderId: E1, command: "BUZZER_FIND" });
  w.tick(24 * 3600 * 1000 + 1000);
  await w.guardian({ action: "buzz.send", elderId: E1, command: "BUZZER_FIND" });
  assert.equal(w.db.tables.device_commands.length, 1);
});

test("handler: phone actions work without Origin; guardian buzz actions need our Origin", async () => {
  const db = memDb();
  const handler = makeHandler({ db, auth: async () => ({ error: "INVALID" }) });
  const call = async (body, headers = {}) => {
    const res = { statusCode: 0, setHeader() {}, end(s) { res.body = JSON.parse(s); } };
    await handler({ method: "POST", body, headers: { "x-forwarded-for": "10.9.9.9", ...headers } }, res);
    return res;
  };
  assert.equal((await call({ action: "cmd.pending", key: KEY })).statusCode, 200);
  assert.equal((await call({ action: "device.report", key: KEY, ble: "connected", gps: "valid" })).statusCode, 200);
  assert.equal((await call({ action: "buzz.send", elderId: E1, command: "BUZZER_FIND" })).statusCode, 403);
  assert.equal((await call({ action: "buzz.send", elderId: E1, command: "BUZZER_FIND" }, { origin: "https://rememberway.vercel.app" })).statusCode, 401);
});
