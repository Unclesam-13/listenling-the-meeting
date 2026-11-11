// 外观和字幕显示：深色模式、字幕大小、「大字幕」模式（横屏时自动进入）。
// 会议助手、手机查看页面共用；同声传译页面只跟着深色设置。保存在这台设备上。
const KEY = "mc.view.v1";
export const CAP_SCALES = [1, 1.3, 1.65, 2.1, 2.6];
const CAP_NAMES = ["标准", "大", "特大", "超大", "巨大"];

export function loadView() {
  let v = {};
  try { v = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch { /* ignore */ }
  return { theme: ["auto", "dark", "light"].includes(v.theme) ? v.theme : "auto", cap: Number.isInteger(v.cap) ? Math.max(0, Math.min(CAP_SCALES.length - 1, v.cap)) : 1 };
}
export function saveView(v) { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* ignore */ } }

const darkMQ = matchMedia("(prefers-color-scheme: dark)");
export function isDark(v = loadView()) { return v.theme === "dark" || (v.theme === "auto" && darkMQ.matches); }

export function applyView(v = loadView()) {
  const root = document.documentElement;
  if (v.theme === "auto") delete root.dataset.theme; else root.dataset.theme = v.theme;
  root.style.setProperty("--cap-scale", CAP_SCALES[v.cap]);
  // 手机状态栏颜色跟着变
  const dark = isDark(v);
  document.querySelectorAll('meta[name="theme-color"]').forEach(m => m.remove());
  const m = document.createElement("meta");
  m.name = "theme-color";
  m.content = document.body?.classList.contains("stage") ? "#000000" : dark ? "#161614" : "#f6f4ef";
  document.head.appendChild(m);
}
darkMQ.addEventListener?.("change", () => applyView());

export function setTheme(theme) { const v = loadView(); v.theme = theme; saveView(v); applyView(v); }

/**
 * 字幕区的按钮和「大字幕」模式。
 * opts: { getTab: () => 当前标签, onTrans: () => 切换显示翻译, transOn: () => 是否显示翻译, status: () => 大字幕顶部的状态文字 }
 */
export function setupCaptionView(opts) {
  const bar = document.querySelector("#tab-captions .capbar");
  bar.insertAdjacentHTML("beforeend", `
    <span class="capctl">
      <button type="button" class="chip" id="capSmaller" aria-label="字幕变小">A−</button>
      <button type="button" class="chip" id="capBigger" aria-label="字幕变大">A+</button>
      <button type="button" class="chip" id="darkBtn" aria-pressed="false">深色</button>
      <button type="button" class="chip strong" id="stageBtn">大字幕</button>
    </span>`);
  document.body.insertAdjacentHTML("beforeend", `
    <div class="stagebar" id="stageBar" hidden>
      <span class="st" id="stageStatus"></span>
      <button type="button" data-a="smaller" aria-label="字幕变小">A−</button>
      <button type="button" data-a="bigger" aria-label="字幕变大">A+</button>
      <button type="button" data-a="trans" id="stageTrans">译文</button>
      <button type="button" data-a="exit">退出</button>
    </div>`);
  const land = matchMedia("(orientation: landscape) and (max-height: 600px)");
  let manual = false, dismissed = false;
  const size = (d) => {
    const v = loadView();
    v.cap = Math.max(0, Math.min(CAP_SCALES.length - 1, v.cap + d));
    saveView(v); applyView(v); paint();
    toastSize(v.cap);
  };
  const paint = () => {
    const v = loadView();
    const dark = isDark(v);
    const b = document.getElementById("darkBtn");
    b.setAttribute("aria-pressed", dark);
    b.classList.toggle("on", dark);
    document.getElementById("capSmaller").disabled = v.cap === 0;
    document.getElementById("capBigger").disabled = v.cap === CAP_SCALES.length - 1;
    document.getElementById("stageTrans").classList.toggle("on", !!opts.transOn?.());
  };
  const update = () => {
    const on = manual || (land.matches && opts.getTab() === "captions" && !dismissed);
    if (on !== document.body.classList.contains("stage")) {
      document.body.classList.toggle("stage", on);
      document.getElementById("stageBar").hidden = !on;
      applyView();
      if (on) requestAnimationFrame(() => window.scrollTo(0, document.body.scrollHeight));
    }
    if (on) document.getElementById("stageStatus").textContent = opts.status?.() || "";
    paint();
  };
  document.getElementById("capSmaller").onclick = () => size(-1);
  document.getElementById("capBigger").onclick = () => size(1);
  document.getElementById("darkBtn").onclick = () => { setTheme(isDark() ? "light" : "dark"); paint(); };
  document.getElementById("stageBtn").onclick = () => { manual = true; dismissed = false; update(); };
  document.getElementById("stageBar").onclick = (e) => {
    const a = e.target.closest("button")?.dataset.a;
    if (a === "smaller") size(-1);
    else if (a === "bigger") size(1);
    else if (a === "trans") { opts.onTrans?.(); paint(); }
    else if (a === "exit") { manual = false; if (land.matches) dismissed = true; update(); }
  };
  land.addEventListener?.("change", () => { dismissed = false; if (!land.matches) manual = false; update(); });
  addEventListener("keydown", (e) => { if (e.key === "Escape" && document.body.classList.contains("stage")) { manual = false; dismissed = land.matches; update(); } });
  setInterval(() => { if (document.body.classList.contains("stage")) document.getElementById("stageStatus").textContent = opts.status?.() || ""; }, 1000);
  applyView();
  update();
  return { update, paint };
}

let sizeTimer;
function toastSize(i) {
  let el = document.getElementById("sizeTip");
  if (!el) { el = document.createElement("div"); el.id = "sizeTip"; el.className = "sizetip"; document.body.appendChild(el); }
  el.textContent = `字幕：${CAP_NAMES[i]}`;
  el.hidden = false;
  clearTimeout(sizeTimer);
  sizeTimer = setTimeout(() => (el.hidden = true), 900);
}
