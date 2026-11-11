// 手机查看电脑上的会议（Mac 软件扫码打开）：实时显示回答、字幕和翻译、会议总结；
// 可以提问、开始 / 结束。录音和回答都在电脑上进行，手机不需要填 Key。
import { $, esc, md, loadRich, dur, dateLabel, toast, copy } from "./util.js";
import { answerHTML, bodyHTML, viaLabel, lineHTML, liveHTML } from "./view.js";
import { setupCaptionView } from "./view-mode.js";

const token = new URLSearchParams(location.search).get("t") || "";
let st = null;            // 电脑上的会议状态
let offset = 0;           // 电脑时间 - 手机时间
let tab = "answers";
let capView = null;       // 深色 / 字幕大小 / 大字幕
let es = null, connected = false, pendingRec = false;
let showTrans = true;
try { showTrans = localStorage.getItem("mr.showTrans") !== "0"; } catch { /* ignore */ }

const WHO = {
  name: (sid) => st?.M?.names?.[sid] || (sid === "me" ? "我" : "说话人" + (String(sid).replace(/\D/g, "") || "1")),
  me: (sid) => !!st?.M?.me?.includes(sid),
};

// ---------------- 顶部 ----------------
function renderHead() {
  const M = st?.M;
  $("mTitle").textContent = M?.title || "会议助手";
  const el = $("statusLine");
  if (!connected) { el.textContent = token ? "与电脑的连接断开，正在重连…" : "请在电脑上的会议助手里点「手机」扫码"; el.classList.add("bad"); }
  else { el.textContent = st?.status?.text || "已连接电脑"; el.classList.toggle("bad", !!st?.status?.bad); }
  paintRec();
}

function paintRec() {
  const r = st?.rec || {};
  const b = $("recBtn");
  b.disabled = !connected;
  b.classList.toggle("on", !!r.on);
  b.classList.toggle("busy", !!r.busy || pendingRec);
  $("recLabel").textContent = r.busy || pendingRec ? (r.on ? "结束中" : "连接中") : r.on ? "结束" : "开始";
  $("recTime").textContent = r.on && r.started ? dur((Date.now() + offset - r.started) / 1000) : "";
}
setInterval(paintRec, 1000);

// ---------------- 标签页 ----------------
function showTab(t) {
  tab = t;
  document.querySelectorAll(".tabs button").forEach(b => b.classList.toggle("on", b.dataset.tab === t));
  for (const x of ["answers", "captions", "summary"]) $("tab-" + x).hidden = x !== t;
  $("b-" + t).classList.remove("on");
  if (t === "summary") renderSummary();
  window.scrollTo({ top: t === "captions" ? document.body.scrollHeight : 0 });
  capView?.update();
}
document.querySelectorAll(".tabs button").forEach(b => (b.onclick = () => showTab(b.dataset.tab)));
function badge(t) { if (tab !== t) $("b-" + t).classList.add("on"); }

// ---------------- 回答 ----------------
function renderAnswers(flash = false) {
  const el = $("tab-answers");
  const list = [...(st?.M?.answers || [])].reverse();
  if (!list.length) {
    el.innerHTML = `<div class="empty">${connected ? "已连接电脑。<br>对方提问时，答案会实时出现在这里。<br><span class=\"hint\">也可以在下面直接提问，由电脑查资料回答</span>"
      : token ? "正在连接电脑…<br><span class=\"hint\">手机和电脑需要连同一个 Wi-Fi，电脑上的会议助手要开着</span>" : "这个页面要从电脑上的会议助手打开：<br>点电脑上的「手机」，用手机扫二维码。"}</div>`;
    return;
  }
  el.innerHTML = answerHTML(list[0], true) + (list.length > 1 ? `<div class="older">之前的回答</div>` + list.slice(1).map(a => answerHTML(a, false)).join("") : "");
  if (flash) $("a-" + list[0].id)?.classList.add("flash");
}

function onAnswer(a) {
  const M = st?.M;
  if (!M) return;
  const i = M.answers.findIndex(x => x.id === a.id);
  if (i < 0) {
    M.answers.push(a);
    renderAnswers(true);
    badge("answers");
    if (a.origin !== "manual") navigator.vibrate?.(60);
    if (tab === "answers") window.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }
  M.answers[i] = a;
  const el = $("a-" + a.id);
  if (!el) return renderAnswers();
  el.querySelector(".body").innerHTML = bodyHTML(a);
  el.classList.toggle("streaming", !a.done);
  const v = $("via-" + a.id); if (v) v.textContent = viaLabel(a);
}

// ---------------- 字幕 ----------------
function nearBottom() { return window.innerHeight + window.scrollY >= document.body.scrollHeight - 160; }
function scrollCaptions() { if (tab === "captions") window.scrollTo(0, document.body.scrollHeight); }

function renderCaptions() {
  const lines = st?.M?.lines || [];
  $("lines").innerHTML = lines.length ? lines.map(l => lineHTML(l, WHO)).join("") : `<div class="empty">${st?.rec?.on ? "等待发言…" : "电脑开始录音后，这里会实时显示字幕和翻译"}</div>`;
  renderLive();
  $("tab-captions").classList.toggle("hide-trans", !showTrans);
  $("showTrans").checked = showTrans;
}
function renderLive() { $("live").innerHTML = liveHTML(st?.live, WHO); }

$("showTrans").onchange = (e) => {
  showTrans = e.target.checked;
  try { localStorage.setItem("mr.showTrans", showTrans ? "1" : "0"); } catch { /* ignore */ }
  renderCaptions();
};

// ---------------- 总结 ----------------
function renderSummary() {
  const M = st?.M;
  $("sumTitle").textContent = M?.title || "";
  if (!M) { $("sumMeta").textContent = ""; $("sumBody").innerHTML = ""; return; }
  const live = st.rec?.on && st.rec.started ? (Date.now() + offset - st.rec.started) / 1000 : 0;
  $("sumMeta").textContent = `${dateLabel(M.startedAt)} · ${dur((M.totalSec || 0) + live)} · ${M.lines.length} 句发言 · ${M.answers.length} 个回答`;
  const body = $("sumBody");
  body.classList.toggle("streaming", !!st.summarizing);
  body.innerHTML = M.summary ? md(M.summary) : `<div class="empty">${st.summarizing ? "电脑正在生成会议总结…" : "电脑上点「结束」后，会议总结会自动出现在这里。"}</div>`;
  $("sumCopy").disabled = !M.summary || st.summarizing;
}
$("sumCopy").onclick = async () => { await copy(`${st.M.title}\n\n${st.M.summary}`); toast("已复制会议总结"); };

// ---------------- 接收电脑推送 ----------------
function renderAll() { renderHead(); renderAnswers(); renderCaptions(); renderSummary(); }

const handlers = {
  reset(d) { st = d; if (!st.M) st.M = null; renderAll(); },
  meta(d) {
    if (st.M) {
      const namesChanged = JSON.stringify([st.M.names, st.M.me]) !== JSON.stringify([d.names, d.me]);
      Object.assign(st.M, { title: d.title, names: d.names, me: d.me, totalSec: d.totalSec, endedAt: d.endedAt });
      if (namesChanged) { renderCaptions(); renderAnswers(); }
    }
    if (d.rec?.on !== st.rec?.on || d.rec?.busy !== st.rec?.busy) pendingRec = false;
    st.rec = d.rec; st.status = d.status;
    renderHead();
    if (tab === "summary") renderSummary();
  },
  line(l) {
    if (!st.M) return;
    st.M.lines.push(l);
    const wasBottom = nearBottom();
    $("lines").querySelector(".empty")?.remove();
    $("lines").insertAdjacentHTML("beforeend", lineHTML(l, WHO));
    if (wasBottom) scrollCaptions();
    badge("captions");
  },
  "line-upd"(d) {
    const l = st.M?.lines.find(x => x.id === d.id);
    if (!l) return;
    l.trans = d.trans;
    const el = $(d.id);
    if (el) el.outerHTML = lineHTML(l, WHO);
  },
  live(d) {
    st.live = d || {};
    const wasBottom = nearBottom();
    renderLive();
    if (wasBottom) scrollCaptions();
  },
  answer: onAnswer,
  summary(d) {
    const had = !!st.M?.summary;
    if (st.M) st.M.summary = d.summary;
    st.summarizing = d.summarizing;
    if (tab === "summary") renderSummary();
    else if (d.summary && !d.summarizing && !had) badge("summary");
  },
};

function banner(text) { $("banner").textContent = text || ""; $("banner").hidden = !text; }

function connect() {
  if (!token) { renderAll(); return; }
  es = new EventSource(`events?t=${encodeURIComponent(token)}`);
  es.onopen = () => { connected = true; banner(""); renderHead(); };
  for (const [type, fn] of Object.entries(handlers)) {
    es.addEventListener(type, (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.now) offset = msg.now - Date.now();
      if (type !== "reset" && !st) return;
      if (type === "reset" && !connected) { connected = true; banner(""); }
      fn(msg.data);
    });
  }
  es.onerror = () => {
    connected = false;
    renderHead();
    if (es.readyState === EventSource.CLOSED) {
      // 服务端拒绝（令牌失效）或电脑上的软件关了：过几秒再试
      banner("连不上电脑：请确认电脑上的会议助手开着、手机和电脑连同一个 Wi-Fi。如果电脑上的软件重新打开过，请重新扫码。");
      setTimeout(() => { try { es.close(); } catch { /* ignore */ } connect(); }, 5000);
    } else {
      banner("与电脑的连接断开，正在重连…");
    }
  };
}

// ---------------- 发给电脑 ----------------
async function post(cmd) {
  try {
    const r = await fetch(`cmd?t=${encodeURIComponent(token)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cmd) });
    if (r.status === 403) throw new Error("链接已失效，请在电脑上重新扫码");
    if (!r.ok) throw new Error(`电脑没有响应（${r.status}）`);
    return true;
  } catch (e) {
    toast(e.message && /失效|响应/.test(e.message) ? e.message : "发送失败：请确认手机和电脑连同一个 Wi-Fi", 5000);
    return false;
  }
}

function chooseContinue() {
  return new Promise((resolve) => {
    const sh = $("continueSheet");
    sh.hidden = false;
    sh.onclick = (e) => {
      const c = e.target.closest("[data-choice]")?.dataset.choice || (e.target === sh || e.target.closest("[data-close]") ? "cancel" : null);
      if (!c) return;
      sh.hidden = true;
      resolve(c);
    };
  });
}

$("recBtn").onclick = async () => {
  if (!connected || !st || st.rec?.busy || pendingRec) return;
  if (st.rec?.on) {
    pendingRec = true; paintRec();
    if (!(await post({ type: "stop" }))) pendingRec = false;
  } else {
    let choice;
    if (st.M?.endedAt && (st.M.lines.length || st.M.answers.length)) {
      choice = await chooseContinue();
      if (choice === "cancel") return;
    }
    pendingRec = true; paintRec();
    if (!(await post({ type: "start", choice }))) pendingRec = false;
  }
  setTimeout(() => { if (pendingRec) { pendingRec = false; paintRec(); toast("电脑没有响应：请看一下电脑上的提示（比如还没填 Soniox Key）", 6000); } }, 15000);
  paintRec();
};

$("askForm").onsubmit = async (e) => {
  e.preventDefault();
  const v = $("askText").value.trim();
  if (!v || !connected) return;
  if (await post({ type: "ask", text: v })) {
    $("askText").value = "";
    showTab("answers");
    toast("已发送，电脑正在查资料回答");
  }
};

// 深色 / 字幕大小 / 大字幕（横屏时自动）
capView = setupCaptionView({
  getTab: () => tab,
  transOn: () => showTrans,
  onTrans: () => { showTrans = !showTrans; try { localStorage.setItem("mr.showTrans", showTrans ? "1" : "0"); } catch { /* ignore */ } renderCaptions(); },
  status: () => {
    if (!connected) return "与电脑的连接断开，正在重连…";
    const r = st?.rec;
    return r?.on ? `● 录音中 ${dur((Date.now() + offset - r.started) / 1000)} · ${st.M?.title || ""}` : `${st?.M?.title || "会议助手"} · 电脑未在录音`;
  },
});
loadRich(() => { renderAnswers(); renderSummary(); });
renderAll();
connect();
window.__mr = { get st() { return st; }, get connected() { return connected; } };
