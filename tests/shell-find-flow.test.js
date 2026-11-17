// 앱 셸: 🚨 찾기 흐름 화면(/report /confirm /summary /record)에서는 "올릴까요?"·"어르신 등록" 창을 자동으로 띄우지 않는다 (작은 링크만).
// 가짜 DOM·저장소로 셸을 돌려 본다 (브라우저 없이). 셸 모듈은 상태를 갖고 있어 경우마다 새로 불러온다.
import test from "node:test";
import assert from "node:assert/strict";

class FNode { constructor() { this.parent = null; } }
class FText extends FNode { constructor(t) { super(); this.text = String(t); } get textContent() { return this.text; } }
class FEl extends FNode {
  constructor(tag) { super(); this.tag = tag; this.attrs = {}; this.children = []; this.className = ""; this.listeners = {}; this.style = {}; this.open = false; }
  get id() { return this.attrs.id ?? ""; }
  get classList() {
    const self = this, cl = () => self.className.split(/\s+/).filter(Boolean);
    return { add: (...c) => { self.className = [...new Set([...cl(), ...c])].join(" "); }, remove: (...c) => { self.className = cl().filter((x) => !c.includes(x)).join(" "); }, contains: (c) => cl().includes(c) };
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  addEventListener(t, f) { (this.listeners[t] ??= []).push(f); }
  append(...ns) { for (const n of ns) { const c = typeof n === "string" ? new FText(n) : n; c.parent = this; this.children.push(c); } }
  prepend(...ns) { for (const n of ns.reverse()) { const c = typeof n === "string" ? new FText(n) : n; c.parent = this; this.children.unshift(c); } }
  after(n) { const p = this.parent, i = p.children.indexOf(this); n.parent = p; p.children.splice(i + 1, 0, n); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this); this.parent = null; }
  showModal() { this.open = true; } close() { this.open = false; }
  set textContent(v) { this.children = [new FText(v)]; }
  get textContent() { return this.children.map((c) => c.textContent).join(""); }
  set innerHTML(v) { this.children = []; }
  matches(sel) { return sel.startsWith("#") ? this.id === sel.slice(1) : sel.startsWith(".") ? this.classList.contains(sel.slice(1)) : this.tag === sel; }
  all() { return this.children.flatMap((c) => (c instanceof FEl ? [c, ...c.all()] : [])); }
  querySelector(sel) { return this.all().find((n) => n.matches(sel)) ?? null; }
  querySelectorAll(sel) { return this.all().filter((n) => n.matches(sel)); }
}

function installFakeBrowser(pathname) {
  const store = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; }, clear: () => m.clear() }; };
  const body = new FEl("body"), main = new FEl("main");
  body.append(main);
  const doc = { body, createElement: (t) => new FEl(t), createTextNode: (t) => new FText(t), getElementById: (id) => body.querySelector("#" + id), querySelector: (s) => (s === "main" ? main : body.querySelector(s)), querySelectorAll: (s) => body.querySelectorAll(s), addEventListener() {}, removeEventListener() {} };
  const prev = {};
  const set = (k, v) => { prev[k] = Object.getOwnPropertyDescriptor(globalThis, k); Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true }); };
  set("Node", FNode); set("document", doc); set("localStorage", store()); set("sessionStorage", store());
  set("location", { pathname, search: "", href: "http://localhost" + pathname, reload() {}, assign() {}, replace() {} });
  set("window", globalThis);
  // authFetch(me)가 쓰는 서버 호출: 로그인한 사용자의 어르신은 0명
  set("fetch", async (url, init) => { const ok = String(url) === "/api/loc"; const data = ok ? { ok: true, elders: [] } : { ok: false }; return { ok, status: ok ? 200 : 404, async json() { return data; } }; });
  localStorage.setItem("rw_session", JSON.stringify({ access_token: "a", refresh_token: "r", expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: "u1", email: "a@b.c" } }));
  return { body, main, restore() { for (const [k, d] of Object.entries(prev)) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; } } };
}

const dialogs = (b) => b.querySelectorAll("dialog");
const tick = () => new Promise((r) => setTimeout(r, 30));

let cases = 0;
async function mountOn(pathname) {
  const browser = installFakeBrowser(pathname);
  const family = await import("../public/js/family.js");
  family._setTransport(async (b) => (b?.action === "me" ? { ok: true, elders: [] } : { ok: false, reason: "NETWORK" }));   // 서버는 "어르신 0명"이라고 답한다
  const shell = await import("../public/js/shell.js?case=" + ++cases);
  return { browser, shell, family };
}

for (const path of ["/report", "/confirm", "/summary", "/record", "/report.html"]) {
  test(`${path}: 어르신 0명이어도 창을 띄우지 않고 작은 링크만 둔다 (셸이 바로 끝난다)`, async () => {
    const { browser, shell } = await mountOn(path);
    try {
      const done = await Promise.race([shell.mountShell({ tab: "find" }).then((r) => r), new Promise((r) => setTimeout(() => r("stuck"), 1500))]);
      assert.notEqual(done, "stuck", "셸이 창을 기다리며 멈췄다");
      assert.deepEqual([done.elder, done.offline], [null, false]);
      assert.equal(dialogs(browser.body).length, 0, "창이 떴다");
      const link = browser.body.querySelector("#shell-register-btn");
      assert.ok(link, "어르신 등록하기 링크가 없다");
      assert.equal(link.textContent, "어르신 등록하기");
      assert.equal(link.attrs.type, "button");
    } finally { browser.restore(); }
  });
}

test("처음 화면(/)은 지금처럼 어르신 등록 창이 자동으로 뜬다 (찾기 흐름이 아님)", async () => {
  const { browser, shell } = await mountOn("/");
  try {
    let settled = false;
    shell.mountShell({ tab: "find" }).then(() => { settled = true; });
    await tick();
    assert.equal(settled, false);
    assert.equal(dialogs(browser.body).filter((d) => d.open).length, 1);
    assert.equal(browser.body.querySelector("#shell-register-btn"), null);
  } finally { browser.restore(); }
});

test("찾기 흐름이 아닌 화면(/profile, tab memory)에서도 창이 자동으로 뜬다", async () => {
  const { browser, shell } = await mountOn("/profile");
  try {
    let settled = false;
    shell.mountShell({ tab: "memory" }).then(() => { settled = true; });
    await tick();
    assert.equal(settled, false);
    assert.equal(dialogs(browser.body).filter((d) => d.open).length, 1);
  } finally { browser.restore(); }
});

test("/summary: 이 폰에 옛 등록 정보가 있어도 '올릴까요?' 창을 띄우지 않고, 질문은 다음 번(처음 화면 등)으로 미룬다", async () => {
  const { browser, shell } = await mountOn("/summary");
  try {
    localStorage.setItem("rw_profile", JSON.stringify({ honorific: "어머니", gait: "normal", places: [] }));
    const done = await Promise.race([shell.mountShell({ tab: "find" }), new Promise((r) => setTimeout(() => r("stuck"), 1500))]);
    assert.notEqual(done, "stuck");
    assert.equal(dialogs(browser.body).length, 0);
    assert.equal(localStorage.getItem("rw_import_asked"), null, "물어본 것으로 기록되면 안 된다");
    assert.ok(browser.body.querySelector("#shell-register-btn"));
  } finally { browser.restore(); }
});

test("/record: 링크를 눌렀을 때만 어르신 등록 창이 열린다 (닫을 수 있는 창)", async () => {
  const { browser, shell } = await mountOn("/record");
  try {
    await shell.mountShell({ tab: "find" });
    assert.equal(dialogs(browser.body).length, 0);
    const link = browser.body.querySelector("#shell-register-btn");
    link.onclick();
    await tick();
    const open = dialogs(browser.body).filter((d) => d.open);
    assert.equal(open.length, 1);
    assert.ok(open[0].textContent.includes("어르신 등록") && open[0].textContent.includes("닫기"));
  } finally { browser.restore(); }
});
