// 앱 셸 — 모든 화면 공통: 로그인 확인, 어르신 고르기(위), 설정 ⚙(오른쪽 위), 고정 탭 3개(아래), 동기화 알림.
// 쓰는 법 (페이지 맨 앞): const { elder, offline } = await mountShell({ tab: "live" | "find" | "memory" | "settings" });
//   - 로그인 안 됨 → requireLogin() (로그인 화면으로 이동, 이 Promise 는 끝나지 않는다)
//   - 로그인 정보는 있는데 서버가 안 됨 → 오프라인: 이 폰의 마지막 사본(현재 어르신)으로 계속. elder 가 null 일 수 있다
//   - 어르신 0명 → 이 폰의 기존 등록 정보 올리기 질문 → 그래도 없으면 "어르신 등록"(호칭) 화면
//   - 현재 어르신을 고른 뒤 pull() — 이 폰 사본이 있으면 WAIT_MS 까지만 기다리고 사본으로 먼저 그린다(서버 장애 때 찾기 흐름이 막히지 않게)
// - 다른 가족이 먼저 고쳤으면(conflict) 안내 후 1.5초 뒤 새로고침 (화면이 들고 있는 옛 배열로 덮어쓰지 않게).
//   단 찾기 흐름이거나 화면에 적던 글이 있으면 자동으로 새로고침하지 않고 [새로고침] 버튼이 달린 안내만 (적던 글을 잃지 않게)
// - 다른 탭(창)에서 어르신을 바꾸거나 다른 계정으로 로그인하면(storage 이벤트, family.js 의 "elder-changed") 같은 방법으로 새로고침
// - 어르신에 더 이상 접근할 수 없으면(gone) 안내 후 처음 화면으로
// - 처음 화면(/)과 🚨 찾기 흐름 화면(/report /confirm /summary /record)에서는 "이 폰의 등록 정보를 올릴까요?"·"어르신 등록" 창을 자동으로 띄우지 않는다
//   (창이 🚨 카드·112·신고·찾기를 가로막으면 안 됨). 어르신이 한 분도 없으면 작은 버튼 "어르신 등록하기"(이 폰에 옛 정보가 있으면 "이 폰 정보 올리기")만 두고,
//   눌렀을 때만 창을 연다. 📍·📝·설정은 지금처럼 자동. 올리기 질문 창에도 112 버튼이 있다.
import { el, $, icon } from "./common.js";
import { session, storedSession, requireLogin, signOut, reasonText, authFetch } from "./auth.js";
import { installSync, checkAccount, listElders, createElder, importLocalData, setCurrentElder, currentElder, pull, flush, onSync, CONFLICT_TEXT, pinElder, pinnedElder, scopeSession, takeBackupNotice } from "./family.js";

export const TABS = [
  { id: "live", href: "/track", icon: "pin", label: "실시간 위치" },
  { id: "find", href: "/report", icon: "siren", label: "실종자 찾기" },
  { id: "memory", href: "/profile", icon: "notebook", label: "추억의 장소" },
];
export const GONE_TEXT = "이 어르신 정보에 더 이상 접근할 수 없어요";
const HOME_GONE_TEXT = "집 주소도 이 폰에서 지웠어요";
const OFFLINE_TEXT = "오프라인 — 이 폰의 마지막 사본";
const PENDING_TEXT = "아직 서버에 못 올린 변경이 있어요. 연결되면 다시 올려요.";
const LABEL_CHIPS = ["아버지", "어머니", "할아버지", "할머니", "어르신"];
const LABEL_MAX = 20;
const FIND_FLOW = /^\/((report|confirm|summary|record|index)(\.html)?\/?)?$/;   // "/" (처음 화면, 🚨 카드)도 같은 취급
const inFindFlow = (tab) => tab === "find" && typeof location !== "undefined" && FIND_FLOW.test(location.pathname);
const SKIP_KEY = "rw_reg_skip";   // sessionStorage: 이번 방문에서는 "어르신 등록"을 건너뜀 (찾기 흐름·112 를 막지 않게). 고르기 창의 [+ 새 어르신 등록]으로 언제든
const skipped = () => { try { return sessionStorage.getItem(SKIP_KEY) === "1"; } catch { return false; } };
const setSkipped = () => { try { sessionStorage.setItem(SKIP_KEY, "1"); } catch {} };
const WAIT_MS = 8000;      // 이 폰 사본이 있을 때 서버를 기다리는 최대 시간
const TOTAL_MS = 7000;     // 화면이 셸을 기다리는 최대 시간 (로그인 갱신·목록·불러오기를 모두 합쳐서). 넘으면 이 폰의 사본으로 먼저 그리고 동기화는 뒤에서 계속
const SLOW = Symbol("slow");
const RELOAD_MS = 1500;

const ERR = {
  NETWORK: "인터넷 연결을 확인해 주세요.", TIMEOUT: "서버 응답이 늦어요. 잠시 뒤에 다시 해 주세요.",
  NOT_OWNER: "처음 등록한 가족(관리자)만 할 수 있어요.", GONE: GONE_TEXT, NOT_MEMBER: GONE_TEXT,
  BAD_INPUT: "입력한 내용을 다시 확인해 주세요.", NO_SUCH_MEMBER: "이미 빠진 가족이에요.",
  RATE_LIMIT: "요청이 너무 많았어요. 잠시 뒤에 다시 해 주세요.",
  AUTH_UNAVAILABLE: "로그인 서버에 문제가 있어요. 잠시 뒤에 다시 해 주세요.",
  NO_STORE: "서버 저장소가 아직 연결되지 않았어요 (관리자 설정 필요).", STORE_ERROR: "서버에 문제가 있어요. 잠시 뒤에 다시 해 주세요.",
  ACCOUNT_CHANGED: "다른 계정으로 로그인돼서 멈췄어요. 화면을 새로고침해 주세요.",
};
/** 서버 reason → 화면 문구 (설정·초대 화면도 같이 쓴다) */
const ELDER_CHANGED_TEXT = "다른 창에서 어르신을 바꿨어요. 이 화면의 변경은 저장하지 않았어요.";
const ACCOUNT_CHANGED_TEXT = "다른 창에서 다른 계정으로 로그인했어요.";
const BACKUP_TEXT = "이 폰에 있던 옛 정보는 따로 보관했어요 (설정에서 볼 수 있어요). 되살리지 않아도 돼요.";
export const errText = (reason) => ERR[reason] ?? (/^HTTP_5\d\d$/.test(String(reason)) ? ERR.STORE_ERROR : reasonText(reason));

// ---------------------------------------------------------------- 작은 UI 도우미
let toastBox = null, toastTimer = null;
/** 아래 탭 위에 잠깐 뜨는 한 줄 안내. action = {label, onClick} 이면 버튼을 단다 */
export function toast(text, ms = 4000, action = null) {
  if (!toastBox) { toastBox = el("div", { class: "toast hidden", role: "status", "aria-live": "polite" }); document.body.append(toastBox); }
  toastBox.textContent = text;
  if (action) toastBox.append(" ", el("button", { type: "button", class: "btn-secondary toast-act", style: "min-height:48px;margin-left:8px", onclick: action.onClick }, action.label));
  toastBox.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastBox.classList.add("hidden"), ms);
}

/** 확인 창 (큰 글씨·큰 버튼). → Promise<boolean>. 바깥 누르기·뒤로 가기(Esc)는 "아니요" */
export function confirmDialog(text, { ok = "네", cancel = "아니요", danger = false, detail = "", cancellable = true, top = null } = {}) {
  return new Promise((resolve) => {
    const dlg = el("dialog", { class: "shell-dialog", "aria-labelledby": "cd-title" });
    const done = (v) => { dlg.close(); dlg.remove(); resolve(v); };
    dlg.append(
      top ? top() : "",
      el("p", { id: "cd-title", class: "q", style: "margin-top:0" }, text),
      detail ? el("p", { class: "muted", style: "margin:0 0 6px" }, detail) : "",
      el("div", { class: "stack", style: "margin-top:14px" },
        el("button", { class: danger ? "btn-danger" : "btn-primary", onclick: () => done(true) }, ok),
        el("button", { class: "btn-secondary", onclick: () => done(false) }, cancel)));
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); if (cancellable) done(false); });
    document.body.append(dlg); dlg.showModal();
  });
}

const callBox = () => el("div", { class: "alert", style: "margin-bottom:14px" }, "치매 어르신은 즉시 신고 대상입니다.", el("br"), "먼저 112에 전화하세요.",
  el("a", { class: "btn btn-danger btn-xl call112", href: "tel:112" }, icon("phone"), " 112 전화하기"));

/** "어르신 등록" (호칭만). required 면 닫을 수 없다(어르신이 한 분도 없을 때). → Promise<{id,label,role}|null> */
export function registerElder({ required = false } = {}) {
  return new Promise((resolve) => {
    const dlg = el("dialog", { class: "shell-dialog shell-reg", "aria-labelledby": "reg-title" });
    const input = el("input", { type: "text", id: "reg-label", maxlength: String(LABEL_MAX * 2), placeholder: "예) 아버지", autocomplete: "off", autofocus: "" });   // 첫 포커스가 112 버튼에 가지 않게
    const chips = LABEL_CHIPS.map((t) => el("button", { type: "button", class: "chip", "aria-pressed": "false", onclick: () => { input.value = t; sync(); } }, t));
    const sync = () => chips.forEach((c) => c.setAttribute("aria-pressed", String(c.textContent === input.value.trim())));
    input.addEventListener("input", sync);
    const msg = el("p", { class: "msg-err", role: "alert" });
    const go = el("button", { class: "btn-primary btn-xl", type: "submit" }, "등록하기");
    const skip = el("button", { type: "button", class: "btn-secondary", onclick: () => { setSkipped(); dlg.close(); dlg.remove(); resolve(null); } }, "지금은 건너뛰기");
    const findNow = el("a", { class: "btn btn-secondary", href: "/report", onclick: (ev) => {
      setSkipped();
      if (location.pathname === "/report") { ev.preventDefault(); dlg.close(); dlg.remove(); resolve(null); }   // 이미 찾기 화면이면 창만 닫는다
    } }, "등록 없이 지금 찾기");
    const form = el("form", { novalidate: "" },
      el("label", { for: "reg-label" }, `어르신을 부르는 호칭 (${LABEL_MAX}자까지)`),
      el("div", { class: "chips", style: "margin:6px 0 10px" }, chips), input, msg,
      el("div", { class: "stack", style: "margin-top:12px" }, go, required ? [skip, findNow] : []));
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const label = input.value.trim();
      if (!label) { msg.textContent = "호칭을 고르거나 적어 주세요."; return input.focus(); }
      if ([...label].length > LABEL_MAX) { msg.textContent = `${LABEL_MAX}자까지 적을 수 있어요.`; return input.focus(); }
      go.disabled = true; go.textContent = "등록하는 중…"; msg.textContent = "";
      const r = await createElder(label).catch(() => ({ ok: false, reason: "NETWORK" }));
      go.disabled = false; go.textContent = "등록하기";
      if (!r.ok) { msg.textContent = errText(r.reason); return; }   // [지금은 건너뛰기]·[등록 없이 지금 찾기]는 처음부터 보인다
      dlg.close(); dlg.remove();
      resolve({ id: r.elder.id, label: r.elder.label ?? label, role: r.elder.role ?? "owner" });
    });
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); if (!required) { dlg.close(); dlg.remove(); resolve(null); } });
    dlg.append(
      required ? callBox() : "",
      el("h2", { id: "reg-title", style: "margin-top:0" }, "어르신 등록"),
      el("p", { class: "muted", style: "margin:0 0 4px" }, "이름은 받지 않아요. 가족끼리 부르는 호칭만 정해 주세요."),
      form,
      required
        ? el("div", { class: "small muted", style: "margin-top:14px" },
            el("p", {}, "가족에게 초대를 받으셨으면 받은 링크(QR)를 열어 주세요. 등록하지 않아도 바로 함께 볼 수 있어요."),
            el("button", { type: "button", class: "btn-ghost", onclick: async () => { await signOut().catch(() => {}); location.replace("/login"); } }, "다른 계정으로 로그인"))
        : el("button", { type: "button", class: "btn-ghost", style: "margin-top:8px", onclick: () => { dlg.close(); dlg.remove(); resolve(null); } }, "닫기"));
    document.body.append(dlg); dlg.showModal();
  });
}

const askImport = (text) => confirmDialog(text, {
  ok: "네, 올릴게요", cancel: "아니요", top: callBox,   // 이 창이 떠 있어도 112 는 바로 누를 수 있게
  detail: "올리면 등록·일지·기록을 가족과 함께 볼 수 있어요. 집 주소는 이 폰에만 남아요. [아니요]를 고르면 이 폰에 따로 보관해요.",
  cancellable: false,
});

/** "이 폰의 등록 정보를 새 어르신으로 올릴까요?" (사용자마다 한 번). 올렸으면 elders 를 채우고 true */
async function offerImport(userId) {
  try {
    const r = await importLocalData({ elders, userId, ask: askImport });
    resetBudget();
    if (r?.ok) { elders = [{ id: r.elder.id, label: r.elder.label ?? "", role: r.elder.role ?? "owner" }]; if (r.message) toast(r.message, 8000); return true; }
    if (r && r.ok === false) toast(`이 폰의 등록 정보를 올리지 못했어요. ${errText(r.reason)}`, 6000);
  } catch {}
  return false;
}

/** 이 폰에 올릴 수 있는 옛 등록 정보가 있고 이 사용자에게 아직 묻지 않았는가 (family.js importLocalData 와 같은 조건) */
function hasImportable(userId) {
  try { return localStorage.getItem("rw_profile") !== null && JSON.parse(localStorage.getItem("rw_import_asked") || "null") !== userId; } catch { return false; }
}

/** 처음 화면·🚨 찾기 흐름 화면용: 어르신이 한 분도 없을 때 창 대신 두는 작은 버튼 (🚨·112·찾기는 그대로 쓸 수 있다). 눌렀을 때만 (올리기 질문 →) 등록 창을 연다 */
function showRegisterLink(userId) {
  if (document.getElementById("shell-register")) return;
  const btn = el("button", { type: "button", class: "btn-ghost", style: "min-height:48px", id: "shell-register-btn" }, hasImportable(userId) ? "이 폰 정보 올리기" : "어르신 등록하기");
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      if (await offerImport(userId)) { setTimeout(() => location.reload(), RELOAD_MS); return; }   // 올린 어르신이 현재 어르신 (안내 글을 읽을 시간 뒤 새로고침)
      const e = await registerElder();   // 닫을 수 있는 창
      if (!e) return;
      elders = [e]; setCurrentElder(e); location.reload();
    } finally { btn.disabled = false; }
  };
  const box = el("div", { id: "shell-register", class: "shell-banner small muted" }, "등록한 어르신이 없어도 찾기는 계속할 수 있어요. ", btn);
  const bar = $(".shellbar"); bar ? bar.after(box) : document.querySelector("main")?.prepend(box);
}

// ---------------------------------------------------------------- 셸 상태
let elders = [];
let mounted = false, mounting = null, reloading = false;
const quiet = new Set();
/** 설정 화면이 직접 빠지기·지우기를 했을 때: 그 어르신의 gone 안내·이동을 셸이 따로 하지 않게 */
export function expectGone(elderId) { if (elderId) quiet.add(elderId); }
/** 마지막으로 받은 내 어르신 목록 */
export const shellElders = () => elders.slice();

const within = (p, ms, fallback) => { let t; return Promise.race([p, new Promise((r) => { t = setTimeout(() => r(fallback), ms); })]).finally(() => clearTimeout(t)); };
const roleText = (r) => (r === "owner" ? "관리자" : "가족");

function setBanner(id, text) {
  let b = document.getElementById(id);
  if (!text) { b?.remove(); return; }
  if (!b) { b = el("div", { id, class: "callout shell-banner", role: "status" }); const bar = $(".shellbar"); bar ? bar.after(b) : document.querySelector("main")?.prepend(b); }
  b.textContent = text;
}

function renderTabs(tab) {
  document.body.classList.add("has-tabs");
  if ($(".tabbar")) return;
  const nav = el("nav", { class: "tabbar", "aria-label": "주요 화면" },
    el("div", { class: "inner" }, TABS.map((t) => el("a", { href: t.href, class: `tab-${t.id}`, "aria-current": t.id === tab ? "page" : null },
      el("span", { class: "ic", "aria-hidden": "true" }, icon(t.icon)), el("span", { class: "lb" }, t.label)))));
  document.body.append(nav);
}

function renderBar(tab) {
  let bar = $(".shellbar");
  if (!bar) {
    bar = el("div", { class: "shellbar" });
    const main = document.querySelector("main") ?? document.body;
    main.prepend(bar);
  }
  bar.innerHTML = "";
  const cur = currentElder();
  const pick = el("button", { class: "elder-pick", type: "button", "aria-haspopup": "dialog", onclick: openSwitcher },
    el("span", { class: "muted" }, "어르신:"), " ", el("b", {}, cur ? cur.label || "어르신" : "고르기"), el("span", { "aria-hidden": "true" }, " ▾"));
  // 처음 화면(/) — 아래 탭 3개는 /track·/report·/profile 로 가서, 이 버튼이 없으면 처음 화면으로 돌아갈 길이 없다
  const atHome = /^\/(index(\.html)?)?$/.test(location.pathname);
  const home = el("a", { class: "home", href: "/", "aria-label": "처음 화면", title: "처음 화면", "aria-current": atHome ? "page" : null }, icon("home"));
  const gear = el("a", { class: "gear", href: "/settings", "aria-label": "설정", "aria-current": tab === "settings" ? "page" : null }, icon("settings"));
  bar.append(home, pick, gear);
}

function openSwitcher() {
  const cur = currentElder();
  const dlg = el("dialog", { class: "shell-dialog", "aria-labelledby": "sw-title" });
  const close = () => { dlg.close(); dlg.remove(); };
  const list = elders.length ? elders : cur ? [cur] : [];
  dlg.append(
    el("h2", { id: "sw-title", style: "margin-top:0" }, "어르신 고르기"),
    el("div", { class: "stack" },
      list.map((e) => el("button", { class: e.id === cur?.id ? "btn-primary elder-opt" : "btn-secondary elder-opt", "aria-current": e.id === cur?.id ? "true" : null,
        onclick: async () => {
          if (e.id === cur?.id) return close();
          close(); toast("어르신을 바꾸는 중…");
          await within(flush().catch(() => {}), WAIT_MS, null);   // 지금 어르신의 못 올린 변경부터
          setCurrentElder(e);
          location.reload();
        } }, el("span", {}, e.label || "어르신"), el("small", {}, e.id === cur?.id ? `지금 보는 중 · ${roleText(e.role)}` : roleText(e.role)))),
      el("button", { class: "btn-secondary", onclick: async () => {
        close();
        const e = await registerElder();
        if (!e) return;
        elders = [...elders.filter((x) => x.id !== e.id), e];
        await within(flush().catch(() => {}), WAIT_MS, null);
        setCurrentElder(e);
        location.reload();
      } }, "+ 새 어르신 등록"),
      el("button", { class: "btn-ghost", onclick: close }, "닫기")));
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); close(); });
  document.body.append(dlg); dlg.showModal();
}

/** 화면에 보호자가 적던 글이 있는가 (자동 새로고침으로 잃으면 안 됨) */
const SKIP_INPUT = new Set(["checkbox", "radio", "hidden", "file", "button", "submit", "reset", "range", "color"]);
export function hasTypedInput() {
  const fields = [...document.querySelectorAll("textarea"), ...document.querySelectorAll("input")];
  return fields.some((f) => !SKIP_INPUT.has(String(f.type ?? f.getAttribute?.("type") ?? "").toLowerCase()) && String(f.value ?? "").trim() !== "");
}
/** 새로고침이 필요할 때: 찾기 흐름이거나 적던 글이 있으면 [새로고침] 버튼만, 아니면 안내 뒤 자동으로 */
function reloadSoon(text) {
  if (reloading) return;
  if (inFindFlow(currentTab) || hasTypedInput()) { toast(text, 60000, { label: "새로고침", onClick: () => location.reload() }); return; }
  toast(text);
  if (mounted) { reloading = true; setTimeout(() => location.reload(), RELOAD_MS); }
}

function onSyncEvent(e) {
  if (e.type === "conflict") reloadSoon(CONFLICT_TEXT);
  else if (e.type === "elder-changed") reloadSoon(ELDER_CHANGED_TEXT);
  else if (e.type === "gone") {
    elders = elders.filter((x) => x.id !== e.elderId);
    if (quiet.has(e.elderId)) return;
    toast(e.homeRemoved ? `${GONE_TEXT}. ${HOME_GONE_TEXT}.` : GONE_TEXT, 6000);
    if (!mounted) return;   // 시작하는 중이면 아래에서 다른 어르신을 고른다
    renderBar(currentTab);
    if (e.wasCurrent && !reloading) { reloading = true; setTimeout(() => location.assign("/"), RELOAD_MS); }
  } else if (e.type === "offline") setBanner("shell-pending", PENDING_TEXT);
  else if (e.type === "saved") setBanner("shell-pending", "");
  else if (e.type === "error") toast("이 변경은 서버가 받지 않았어요. 이 폰에는 남아 있어요.", 6000);
}

/** 테스트용: 동기화 소식을 이 셸에 바로 넣기 */
export const _onSyncEventForTest = (e) => onSyncEvent(e);

let currentTab = null;
/** 셸 붙이기. → Promise<{ elder: {id,label,role}|null, offline: boolean }> (한 화면에서 여러 번 불러도 한 번만 돈다) */
export function mountShell({ tab } = {}) {
  if (!mounting) mounting = start(tab);
  return mounting;
}

// 서버를 기다리는 시간 예산. 보호자가 창(올리기 질문·어르신 등록)에 답하는 시간은 세지 않는다 — 답한 뒤 다시 채운다
let deadline = 0;
const resetBudget = () => { deadline = Date.now() + TOTAL_MS; };
const left = () => Math.max(0, deadline - Date.now());
const budget = (p, fallback) => within(p, Math.min(left(), WAIT_MS), fallback);

/** 다른 탭(창)에서 어르신을 바꾸거나 다른 계정으로 로그인했을 때 (같은 탭의 쓰기는 storage 이벤트가 오지 않는다) */
export function onStorage(ev) {
  if (ev.key === "rw_elder") {
    let id = null; try { id = JSON.parse(ev.newValue || "null")?.id ?? null; } catch {}
    const mine = pinnedElder();
    if (mine !== undefined && id !== mine) reloadSoon("다른 창에서 어르신을 바꿨어요.");
  } else if (ev.key === "rw_owner_user" && ev.oldValue !== ev.newValue) reloadSoon(ACCOUNT_CHANGED_TEXT);
}

async function start(tab) {
  resetBudget();
  currentTab = tab ?? null;
  pinElder(currentElder()?.id ?? null);   // 이 탭이 지금 보는 어르신 (다른 탭에서 바꾸면 이 탭의 쓰기를 막는다)
  scopeSession(currentElder()?.id);       // 다른 어르신의 찾기 단서(sessionStorage)는 지운다 — 화면이 단서를 읽기 전에 (동기)
  try { globalThis.addEventListener?.("storage", onStorage); } catch {}
  renderTabs(tab);
  renderBar(tab);
  onSync(onSyncEvent);
  installSync();

  const s = await budget(session().catch(() => null), SLOW);   // 갱신이 늦으면(로그인 서버 멈춤) 기다리지 않는다 — 갱신은 뒤에서 계속
  if (!s || s === SLOW) {
    const st = storedSession();
    if (!st) { requireLogin(); return new Promise(() => {}); }   // 로그인 화면으로 가는 중
    // 로그인 정보는 있는데 갱신을 못 함(또는 늦음) = 서버·네트워크 문제 → 이 폰의 마지막 사본으로
    checkAccount(st.user?.id);
    elders = (await budget(listElders().catch(() => null), null)) ?? lastElders();
    return finishOffline(tab);
  }

  checkAccount(s.user.id);
  const known = await knownElders(tab);   // {list, ok}: ok = 서버가 지금 답한 목록 (실패·시간 초과면 이 폰의 마지막 목록)
  elders = known.list;
  if (!known.ok) return finishOffline(tab);   // 서버 장애: 올리기·등록을 묻지 않고 이 폰의 사본으로

  const deferred = inFindFlow(tab);   // 🚨 찾기 흐름 화면: 창 대신 작은 링크
  if (!elders.length && !deferred) await offerImport(s.user.id);   // 서버가 "정말 0명"이라고 답했을 때만

  let res = "offline";
  for (let i = 0; i < 5; i++) {
    if (!elders.length) {
      const e = deferred || skipped() ? null : await registerElder({ required: true });
      resetBudget();
      if (!e) { setCurrentElder(null); res = "skipped"; if (deferred) showRegisterLink(s.user.id); break; }   // 건너뜀 — 고른 어르신 없이 계속 (elder: null)
      elders = [e];
    }
    const cur = currentElder();
    const chosen = elders.find((x) => x.id === cur?.id) ?? elders[0];
    setCurrentElder(chosen);
    renderBar(tab);
    res = await budget(pull().catch(() => "offline"), "offline");   // 늦으면 이 폰 사본으로 먼저 (pull 은 뒤에서 계속)
    if (res === "gone") { elders = elders.filter((x) => x.id !== chosen.id); continue; }
    break;
  }
  renderBar(tab);
  if (res === "offline") setBanner("shell-offline", OFFLINE_TEXT);
  showBackupNotice();
  mounted = true;
  return { elder: currentElder(), offline: res === "offline" };
}

/** 어르신을 처음 고르면서 이 폰의 옛 정보를 rw_backup_* 으로 옮겼으면 한 번 알린다 (초대 수락·첫 로그인 등) */
function showBackupNotice() { if (takeBackupNotice()) setBanner("shell-backup", BACKUP_TEXT); }

/** 내 어르신 목록. 서버가 지금 답했으면 ok:true. 목록이 비었으면 서버에 한 번 더 물어 "정말 0명"인지 확인한다
 *  (listElders 는 실패하면 이 폰의 마지막 목록을 돌려줘서, 빈 배열만으로는 "0명"과 "서버 장애"를 구분할 수 없다). 모두 남은 시간 예산(TOTAL_MS)까지만 기다린다 */
async function knownElders(tab) {
  const lp = listElders().catch(() => null);
  const l = await budget(lp, null);
  if (l === null) {   // 늦음 — 이 폰의 사본으로 먼저. 늦게 온 목록은 고르기 창에 반영
    lp.then((x) => { if (x?.length) { elders = x; renderBar(tab); } });
    const cur = currentElder(), last = lastElders();
    return { list: cur ? [cur, ...last.filter((x) => x.id !== cur.id)] : last, ok: false };
  }
  if (l.length) return { list: l, ok: true };   // 서버 목록이든 이 폰의 마지막 목록이든, 고를 어르신은 있다 (서버 장애면 pull 이 offline 으로 알려 준다)
  const me = await budget(authFetch({ action: "me" }).catch(() => null), null);
  if (!me?.ok || !Array.isArray(me.elders)) return { list: [], ok: false };
  if (!me.elders.length) return { list: [], ok: true };
  // 그 사이 생겼다 (다른 기기에서 등록·초대 수락) — 목록을 다시 받아 사본까지 맞춘다
  const again = await budget(listElders().catch(() => null), null);
  return again?.length ? { list: again, ok: true } : { list: [], ok: false };
}

/** 이 폰에 마지막으로 받은 내 어르신 목록 (family.js 가 rw_elders 에 둔다) */
function lastElders() {
  try { const l = JSON.parse(localStorage.getItem("rw_elders") || "[]"); return Array.isArray(l) ? l.filter((x) => x && typeof x.id === "string" && x.id) : []; } catch { return []; }
}

/** 서버에 닿지 않을 때: 이 폰의 현재 어르신(없으면 마지막 목록의 첫 어르신)으로 계속. 서버를 더 기다리지 않는다 */
function finishOffline(tab) {
  if (!currentElder() && elders.length) setCurrentElder(elders[0]);
  renderBar(tab);
  setBanner("shell-offline", OFFLINE_TEXT);
  showBackupNotice();
  mounted = true;
  return { elder: currentElder(), offline: true };
}
