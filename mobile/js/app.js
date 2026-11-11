// 会议助手 手机版：录音 -> 识别 + 翻译 -> 判断提问 -> 根据资料回答；结束后生成会议总结
import { $, esc, md, loadRich, uid, hhmm, dur, dateLabel, toast, colorOf, download, shareOrCopy, copy, netError } from "./util.js";
import * as store from "./store.js";
import { Mic } from "./audio.js";
import { SonioxClient } from "./soniox.js";
import { Router } from "./llm.js";
import { Intent } from "./intent.js";
import { KnowledgeBase } from "./kb.js";
import { retrieve, answer as genAnswer, summarize, transcriptText, useFull, answerLang, isChinese, NOT_FOUND, ANSWER_SYSTEM, CUSTOM_MAX } from "./brain.js";
// 选了"自定义"且写了内容才用自定义要求，否则用内置要求
const customPrompt = () => (S.answerStyle === "custom" && S.customPrompt.trim() ? S.customPrompt : "");
import { Indexer } from "./indexer.js";
import { LANGS, langZh, validLang } from "./langs.js";
import { answerHTML, bodyHTML, viaLabel, lineHTML as lineView, liveHTML } from "./view.js";

// ---------------- 状态 ----------------
let S = store.loadSettings();
let router = new Router(S);
// 整理资料、会议总结可以单独选模型（空 = 和回答问题的相同）；选中的模型出错或没填 Key 时同样自动换用其他模型
const routerFor = (p) => (p && p !== S.answerProvider ? new Router({ ...S, answerProvider: p }) : router);
let intent = new Intent(S, router);
const kb = new KnowledgeBase();
// 资料预处理：在后台让 AI 整理资料，开会时先查整理好的索引
const indexer = new Indexer(kb, () => routerFor(S.indexProvider), () => S, () => {
  if (!$("settingsSheet").hidden) renderDocs();
  setStatus();
});
let M = newMeeting();          // 当前会议
let tab = "answers";
const rec = { on: false, busy: false, mic: null, sx: null, chans: [], started: 0, lastActivity: 0, wake: null, hiddenAt: 0, asr: "" };
const pending = {};            // sid -> { text, timer }：同一个人连续说的话合并成一"轮"再判断
let lastQ = ["", 0];
let live = {};                 // 每一路录音正在说的话：{ main|me: { text, trans, sid } }
const DESKTOP = window.mcDesktop || null; // 在 Mac 软件里打开时由外壳提供

// Mac 软件：把会议实时同步给扫码的手机（由外壳里的局域网服务转发）
function sync(type, data) {
  if (!DESKTOP?.sync) return;
  try { DESKTOP.sync(type, JSON.parse(JSON.stringify(data ?? null))); } catch (e) { console.warn("sync", e); }
}
function recState() { return { on: rec.on, busy: rec.busy, started: rec.started }; }
function statusState() { const el = $("statusLine"); return { text: el.textContent, bad: el.classList.contains("bad") }; }
function syncAll() { if (DESKTOP?.sync) sync("reset", { M, rec: recState(), status: statusState(), live, summarizing }); }
function syncMeta() {
  if (DESKTOP?.sync) sync("meta", { title: M.title, names: M.names, me: M.me, totalSec: M.totalSec, endedAt: M.endedAt, rec: recState(), status: statusState() });
}
let summarizing = false;

function newMeeting() {
  const now = Date.now();
  return { id: uid(), title: `会议 ${dateLabel(now)}`, startedAt: now, endedAt: null, lines: [], answers: [], summary: "", summaryAt: 0, names: {}, me: [], totalSec: 0 };
}

// ---------------- 保存 ----------------
let saveTimer;
function save(now = false) {
  clearTimeout(saveTimer);
  const go = async () => {
    if (!M.lines.length && !M.answers.length && !M.summary) return;
    try { await store.put("meetings", JSON.parse(JSON.stringify(M))); localStorage.setItem("mc.current", M.id); } catch (e) { console.warn("save", e); }
  };
  if (now) return go();
  saveTimer = setTimeout(go, 1200);
}

// ---------------- 说话人 ----------------
// ch === "me"：Mac 软件里单独录的"我的麦克风"，整路都是我
function sidOf(spk, ch) { return ch === "me" ? "me" : `spk${spk || 1}`; }
function nameOf(sid) {
  if (!M.names[sid]) M.names[sid] = sid === "me" ? "我" : "说话人" + (String(sid).replace(/\D/g, "") || "1");
  return M.names[sid];
}
const isMe = (sid) => M.me.includes(sid);
const WHO = { name: (sid) => nameOf(sid), me: (sid) => isMe(sid) };
const lineHTML = (l) => lineView(l, WHO);
function context() { return M.lines.slice(-12).map(l => `${nameOf(l.sid)}: ${l.text}`); }

// ---------------- 顶部状态 ----------------
function setStatus() {
  const el = $("statusLine");
  let text, bad = false;
  if (rec.on) text = rec.asr || "识别中";
  else if (!S.sonioxKey || !router.ready) { text = "请先在设置里填写 API Key"; bad = true; }
  else {
    const docs = !kb.docs.length ? "资料库为空" : indexer.busy ? `资料 ${kb.docs.length} 份（AI 整理中）` : `资料 ${kb.docs.length} 份`;
    text = `${M.endedAt ? "已结束" : "未开始"} · ${docs} · ${router.label()}`;
  }
  if (intent.jevError) { text += ` · Jev 出错`; bad = true; }
  el.textContent = text;
  el.classList.toggle("bad", bad || /失败|中断|无效|出错/.test(text));
  $("mTitle").textContent = M.title;
  syncMeta();
}

function paintRec() {
  const b = $("recBtn");
  b.classList.toggle("on", rec.on);
  b.classList.toggle("busy", rec.busy);
  $("recLabel").textContent = rec.busy ? (rec.on ? "结束中" : "连接中") : rec.on ? "结束" : "开始";
  $("recTime").textContent = rec.on ? dur((Date.now() - rec.started) / 1000) : "";
  const k = `${rec.on}${rec.busy}`;
  if (k !== paintRec.k) { paintRec.k = k; syncMeta(); }
}
setInterval(paintRec, 1000);

// ---------------- 标签页 ----------------
function showTab(t) {
  tab = t;
  document.querySelectorAll(".tabs button").forEach(b => b.classList.toggle("on", b.dataset.tab === t));
  for (const x of ["answers", "captions", "summary"]) $("tab-" + x).hidden = x !== t;
  $("b-" + t).classList.remove("on");
  if (t === "captions") scrollCaptions(true);
  if (t === "summary") renderSummary();
  window.scrollTo({ top: t === "captions" ? document.body.scrollHeight : 0 });
}
document.querySelectorAll(".tabs button").forEach(b => (b.onclick = () => showTab(b.dataset.tab)));
function badge(t) { if (tab !== t) $("b-" + t).classList.add("on"); }

// ---------------- 回答 ----------------
function renderAnswers(flash = false) {
  const el = $("tab-answers");
  const list = [...M.answers].reverse();
  if (!list.length) {
    const needKeys = !S.sonioxKey || !router.ready;
    el.innerHTML = `<div class="empty">${needKeys
      ? `第一次使用，请先在<b>设置</b>里填写 Soniox 和至少一个大模型的 API Key，并添加你的资料。<br><button class="btn primary" id="goSettings">去设置</button>`
      : `点右上角<b>「开始」</b>开始录音。<br>对方提问时，答案会自动出现在这里。<br><span class="hint">也可以在下面直接向资料库提问</span>`}</div>`;
    $("goSettings")?.addEventListener("click", () => openSettings());
    return;
  }
  el.innerHTML = answerHTML(list[0], true) + (list.length > 1 ? `<div class="older">之前的回答</div>` + list.slice(1).map(a => answerHTML(a, false)).join("") : "");
  if (flash) $("a-" + list[0].id)?.classList.add("flash");
}

function updateAnswer(a) {
  sync("answer", a);
  const el = $("a-" + a.id);
  if (!el) return renderAnswers();
  el.querySelector(".body").innerHTML = bodyHTML(a);
  el.classList.toggle("streaming", !a.done);
  const v = $("via-" + a.id); if (v) v.textContent = viaLabel(a);
}

async function ask(question, asker, origin) {
  const a = { id: uid(), question, asker, origin, text: "", ts: Date.now(), done: false, sources: [] };
  M.answers.push(a);
  sync("answer", a);
  renderAnswers(true);
  badge("answers");
  if (tab === "answers") window.scrollTo({ top: 0, behavior: "smooth" });
  if (origin !== "manual") navigator.vibrate?.(60);
  try {
    const t0 = performance.now();
    const r = await retrieve(router, kb, question, indexer);
    a.via = r.via;
    a.findMs = Math.round(performance.now() - t0);
    // 索引里有现成的问答：马上显示（语言和要求的回答语言一致时）
    const L = answerLang(S.answerLang, question, S.otherLang);
    if (r.instant && (L === "both" || isChinese(r.instant.a) === (L === "zh"))) a.pre = r.instant;
    updateAnswer(a);
    a.sources = r.full ? kb.docs.map(d => d.name) : [...new Set((r.hits || []).map(h => h.source))];
    let n = 0;
    for await (const t of genAnswer(router, kb, question, context(), r, S.answerLang, customPrompt(), S.otherLang)) {
      a.text += t;
      if (++n % 2 === 0) updateAnswer(a);
    }
    // 索引里的片段答不出来：再到原文里找一遍
    if (r.via === "index" && NOT_FOUND.test(a.text)) {
      const r2 = await retrieve(router, kb, question, indexer, { skipIndex: true });
      a.via = r2.via; a.text = ""; a.pre = null;
      updateAnswer(a);
      for await (const t of genAnswer(router, kb, question, context(), r2, S.answerLang, customPrompt(), S.otherLang)) {
        a.text += t;
        if (++n % 2 === 0) updateAnswer(a);
      }
    }
  } catch (e) {
    a.text += `\n\n（出错：${netError(e, "回答")}）`;
  }
  a.done = true;
  updateAnswer(a);
  save();
}

// ---------------- 字幕 ----------------
function nearBottom() { return window.innerHeight + window.scrollY >= document.body.scrollHeight - 160; }
function scrollCaptions(force) { if (tab === "captions" && (force || nearBottom())) window.scrollTo(0, document.body.scrollHeight); }

function renderCaptions() {
  $("lines").innerHTML = M.lines.length ? M.lines.map(lineHTML).join("")
    : `<div class="empty">${rec.on ? "等待发言…" : "点「开始」后，这里会实时显示字幕和翻译"}</div>`;
  renderLive();
  $("tab-captions").classList.toggle("hide-trans", !S.showTranslation);
  $("showTrans").checked = S.showTranslation;
}

function renderLive() {
  $("live").innerHTML = liveHTML(live, WHO);
  sync("live", live);
}

$("showTrans").onchange = (e) => { S.showTranslation = e.target.checked; store.saveSettings(S); renderCaptions(); };

$("lines").addEventListener("click", (e) => {
  const b = e.target.closest(".who");
  if (b) openSpeaker(b.dataset.sid);
});

// ---------------- 识别回调 ----------------
function onLine(l, ch) {
  const sid = sidOf(l.spk, ch);
  nameOf(sid);
  const line = { id: l.id, sid, text: l.text, trans: l.trans, ts: Date.now() };
  M.lines.push(line);
  sync("line", line);
  rec.lastActivity = Date.now();
  const wasBottom = nearBottom();
  const empty = $("lines").querySelector(".empty");
  if (empty) $("lines").innerHTML = "";
  $("lines").insertAdjacentHTML("beforeend", lineHTML(line));
  if (wasBottom) scrollCaptions(true);
  badge("captions");
  save();
  // 判断是不是在提问：同一个人说的话合并，停顿一会儿再判断
  if (S.answerOthersOnly && isMe(sid)) return;
  const p = pending[sid] || (pending[sid] = { text: "" });
  p.text = (p.text + " " + l.text).trim();
  clearTimeout(p.timer);
  p.timer = setTimeout(() => settle(sid), S.settleMs || 1200);
}

function onLateTranslation(id, trans) {
  const l = M.lines.find(x => x.id === id);
  if (!l) return;
  l.trans = trans;
  sync("line-upd", { id, trans });
  const el = $(id);
  if (el) el.outerHTML = lineHTML(l);
  save();
}

function onPartial(p, ch = "main") {
  const sid = p.text ? sidOf(p.spk, ch) : null;
  live[ch] = { text: p.text, trans: p.trans, sid };
  if (p.text) {
    rec.lastActivity = Date.now();
    // 对方还在说：推迟判断
    const pp = pending[sid];
    if (pp) { clearTimeout(pp.timer); pp.timer = setTimeout(() => settle(sid), S.settleMs || 1200); }
  }
  const wasBottom = nearBottom();
  renderLive();
  if (wasBottom) scrollCaptions(true);
}

async function settle(sid) {
  const p = pending[sid];
  delete pending[sid];
  if (!p?.text) return;
  const res = await intent.detect(context(), nameOf(sid), p.text);
  setStatus();
  if (!res) return;
  if (res.question === lastQ[0] && Date.now() - lastQ[1] < 30000) return;
  lastQ = [res.question, Date.now()];
  ask(res.question, nameOf(sid), "auto");
}

// ---------------- 开始 / 结束 ----------------
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

async function startRec(choice) {
  if (rec.on || rec.busy) return;
  if (!S.sonioxKey) return openSettings("开始录音前，请先填写 Soniox API Key（用于语音识别和翻译）。");
  // iOS 要求在点击时同步创建音频环境，所以先建好再做其他事
  const AC = window.AudioContext || window.webkitAudioContext;
  let ctx = null;
  try { ctx = new AC(); } catch { /* 在 Mic 里再试 */ }
  if (M.endedAt && (M.lines.length || M.answers.length)) {
    const c = choice || await chooseContinue();
    if (c === "cancel") { ctx?.close(); return; }
    if (c === "new") { await save(true); M = newMeeting(); live = {}; renderAll(); }
  }
  rec.busy = true; paintRec();
  // 手机：一个麦克风录全场，由 Soniox 区分说话人。
  // Mac 软件里选了会议软件的声音（BlackHole）：两路分别识别，麦克风那一路全部算"我"，不会触发自动回答。
  const dual = !!(DESKTOP && S.sysDevice);
  const plan = dual
    ? [{ ch: "me", device: S.micDevice, raw: false, diarize: false }, { ch: "main", device: S.sysDevice, raw: true, diarize: true }]
    : [{ ch: "main", device: DESKTOP ? S.micDevice : "", raw: false, diarize: true }];
  const chans = [];
  const meter = (lv) => $("recBtn").style.setProperty("--lv", Math.min(1, lv * 3).toFixed(2));
  const fail = (msg) => { for (const c of chans) { c.mic.stop(); c.sx.abort(); } rec.busy = false; paintRec(); ctx?.close(); toast(msg, 6000); };
  for (const [i, pl] of plan.entries()) {
    const sx = new SonioxClient({
      key: S.sonioxKey, translate: S.translate, other: S.otherLang, diarize: pl.diarize, ref: `meeting-copilot-${DESKTOP ? "mac" : "mobile"}-${pl.ch}`,
      terms: S.terms.split(/[,，、\n]/).map(x => x.trim()).filter(Boolean), context: S.contextText,
      onLine: (l) => onLine(l, pl.ch), onPartial: (p) => onPartial(p, pl.ch), onLateTranslation,
      onStatus: (t) => { rec.asr = dual && t !== "识别中" ? `${pl.ch === "me" ? "我的麦克风" : "会议声音"}：${t}` : t; setStatus(); },
      onError: (msg) => { toast(msg, 6000); rec.asr = msg; setStatus(); if (/Key 无效/.test(msg)) stopRec(); },
    });
    const mic = new Mic((pcm) => sx.send(pcm), pl.ch === "main" ? meter : null);
    chans.push({ ch: pl.ch, mic, sx });
    try {
      await mic.start(i === 0 ? ctx : null, pl.device, pl.raw);
    } catch (e) {
      const denied = e.name === "NotAllowedError" || e.name === "SecurityError";
      const gone = e.name === "OverconstrainedError" || e.name === "NotFoundError";
      const what = pl.ch === "main" && dual ? "会议软件的声音（BlackHole）" : "麦克风";
      return fail(denied ? (DESKTOP ? "没有麦克风权限：请到「系统设置 → 隐私与安全性 → 麦克风」里打开「会议助手」，然后重新打开软件" : "没有麦克风权限：请在浏览器设置里允许这个网页使用麦克风")
        : gone ? `找不到${what}设备：请在设置里重新选择` : `无法启动${what}：${e.message}`);
    }
  }
  try {
    await Promise.all(chans.map(c => c.sx.connect()));
  } catch (e) {
    return fail(e.message || "无法连接识别服务");
  }
  if (dual) { if (!M.me.includes("me")) M.me.push("me"); nameOf("me"); }
  const { mic, sx } = chans.find(c => c.ch === "main");
  Object.assign(rec, { on: true, busy: false, mic, sx, chans, started: Date.now(), lastActivity: Date.now(), asr: "识别中", translate: S.translate });
  M.endedAt = null;
  keepAwake();
  paintRec(); setStatus(); renderCaptions();
  if (!M.lines.length) toast(dual ? "已开始：同时录你的麦克风（我）和会议软件的声音（对方）" : DESKTOP ? "已开始" : "已开始。请保持屏幕亮着、不要切到其他 App");
}

async function stopRec(reason) {
  if (!rec.on || rec.busy) return;
  rec.busy = true; paintRec();
  for (const c of rec.chans) c.mic.stop();
  await Promise.all(rec.chans.map(c => c.sx.finish()));
  M.totalSec += (Date.now() - rec.started) / 1000;
  M.endedAt = Date.now();
  Object.assign(rec, { on: false, busy: false, mic: null, sx: null, chans: [], asr: "" });
  live = {};
  releaseAwake();
  paintRec(); renderLive(); setStatus();
  await save(true);
  if (reason) toast(reason, 6000);
  if (M.lines.length >= 3 && router.ready) {
    badge("summary");
    if (!reason) toast("已结束，不再计费。正在生成会议总结…");
    generateSummary();
  } else if (!reason) {
    toast("已结束，不再计费");
  }
}

$("recBtn").onclick = () => (rec.on ? stopRec() : startRec());

// 忘了点结束：连续 N 分钟没人说话自动结束
setInterval(() => {
  const min = Number(S.autoStopMin) || 0;
  if (rec.on && !rec.busy && min > 0 && Date.now() - rec.lastActivity > min * 60000) {
    stopRec(`连续 ${min} 分钟没有人说话，已自动结束，避免浪费识别时长`);
  }
}, 15000);

// 屏幕常亮
async function keepAwake() {
  try { rec.wake = await navigator.wakeLock?.request("screen"); } catch { /* 不支持就算了 */ }
}
function releaseAwake() { try { rec.wake?.release(); } catch { /* ignore */ } rec.wake = null; }

document.addEventListener("visibilitychange", async () => {
  if (!rec.on) return;
  if (document.hidden) { rec.hiddenAt = Date.now(); return; }
  for (const c of rec.chans) { await c.mic.resume(); c.sx.ensure(); }
  keepAwake();
  if (!DESKTOP && rec.hiddenAt && Date.now() - rec.hiddenAt > 3000) {
    showBanner("刚才切到了后台或锁屏，这段时间的声音可能没有录到。开会时请保持这个页面在前台、屏幕亮着。");
  }
  if (rec.chans.some(c => !c.mic.alive)) {
    showBanner("麦克风被系统停止了，请点「结束」后重新「开始」。");
  }
});

function showBanner(text) {
  const b = $("banner");
  b.textContent = text;
  b.hidden = false;
  clearTimeout(showBanner.t);
  showBanner.t = setTimeout(() => (b.hidden = true), 10000);
}

// ---------------- 手动提问 ----------------
$("askForm").onsubmit = (e) => {
  e.preventDefault();
  const v = $("askText").value.trim();
  if (!v) return;
  $("askText").value = "";
  $("askText").blur();
  showTab("answers");
  ask(v, "手动提问", "manual");
};

// ---------------- 总结 ----------------
function renderSummary() {
  $("titleInput").value = M.title;
  const n = M.lines.length;
  $("sumMeta").textContent = `${dateLabel(M.startedAt)} · ${dur(M.totalSec + (rec.on ? (Date.now() - rec.started) / 1000 : 0))} · ${n} 句发言 · ${M.answers.length} 个回答`;
  const body = $("sumBody");
  body.innerHTML = M.summary ? md(M.summary) : "";
  body.classList.toggle("streaming", summarizing);
  $("sumGen").textContent = summarizing ? "生成中…" : M.summary ? "重新生成" : "生成总结";
  $("sumGen").disabled = summarizing;
  for (const id of ["sumCopy", "sumShare"]) $(id).disabled = !M.summary || summarizing;
  sync("summary", { summary: M.summary, summarizing });
  if (!M.summary && !summarizing) {
    body.innerHTML = `<div class="empty">${n < 3 ? "会议内容还太少。点「开始」录音，结束后会自动生成总结。" : "点「生成总结」整理会议摘要、决定、待办和问题。"}</div>`;
  }
}

async function generateSummary() {
  if (summarizing) return;
  if (!router.ready) return openSettings("生成总结需要至少一个大模型的 API Key。");
  if (M.lines.length < 1) return toast("还没有会议内容");
  summarizing = true;
  const old = M.summary;
  M.summary = "";
  renderSummary();
  try {
    let n = 0;
    for await (const x of summarize(routerFor(S.summaryProvider), M, S.summaryLang, S.otherLang)) {
      if (x.progress) { $("sumBody").innerHTML = `<div class="empty">${esc(x.progress)}</div>`; continue; }
      M.summary += x.text;
      if (++n % 3 === 0) { if (tab === "summary") $("sumBody").innerHTML = md(M.summary); sync("summary", { summary: M.summary, summarizing }); }
    }
    M.summaryAt = Date.now();
  } catch (e) {
    M.summary = old;
    toast(netError(e, "生成总结"), 6000);
  }
  summarizing = false;
  renderSummary();
  badge("summary");
  save(true);
}

$("sumGen").onclick = generateSummary;
$("sumCopy").onclick = async () => { await copy(M.summary); toast("已复制会议总结"); };
$("sumShare").onclick = async () => {
  const r = await shareOrCopy(M.title, `${M.title}\n\n${M.summary}`);
  if (r === "copied") toast("已复制，可以粘贴到微信、邮件等");
};
$("exportAll").onclick = () => {
  const qa = M.answers.map(a => `### ${a.question}\n${a.origin === "manual" ? "（手动提问）" : `（${a.asker} 提问）`}\n\n${a.text}`).join("\n\n");
  const text = `# ${M.title}\n\n${dateLabel(M.startedAt)} · 时长 ${dur(M.totalSec)}\n\n` +
    (M.summary ? `${M.summary}\n\n` : "") +
    (qa ? `## 问答记录\n\n${qa}\n\n` : "") +
    `## 会议全文\n\n${transcriptText(M, true)}\n`;
  download(`${M.title.replace(/[\\/:*?"<>|]/g, "-")}.md`, text);
};
$("titleInput").onchange = (e) => { M.title = e.target.value.trim() || M.title; setStatus(); save(); };

// ---------------- 说话人 ----------------
let editingSid = null;
function openSpeaker(sid) {
  editingSid = sid;
  const f = $("speakerForm");
  f.name.value = nameOf(sid);
  f.me.checked = isMe(sid);
  $("speakerSheet").hidden = false;
}
$("speakerForm").onsubmit = (e) => {
  e.preventDefault();
  const f = e.target;
  M.names[editingSid] = f.name.value.trim().slice(0, 20) || nameOf(editingSid);
  M.me = M.me.filter(x => x !== editingSid);
  if (f.me.checked) M.me.push(editingSid);
  $("speakerSheet").hidden = true;
  renderCaptions(); renderAnswers(); save(); syncMeta();
};

// ---------------- 设置 ----------------
const KEY_FIELDS = ["sonioxKey", "claudeKey", "openaiKey", "deepseekKey", "jevKey"];
function openSettings(msg) {
  const f = $("settingsForm");
  for (const el of f.elements) {
    if (!el.name || !(el.name in S)) continue;
    if (el.type === "checkbox") el.checked = !!S[el.name];
    else if (KEY_FIELDS.includes(el.name)) { el.value = ""; el.placeholder = S[el.name] ? "已设置（留空保持不变）" : el.dataset.ph || el.placeholder; }
    else el.value = S[el.name] ?? "";
  }
  $("setupMsg").hidden = !msg;
  $("setupMsg").textContent = msg || "";
  $("jevBox").hidden = f.intentProvider.value !== "jev";
  paintStyle();
  if (!validLang(f.otherLang.value)) f.otherLang.value = "en";
  paintLangs(f.otherLang.value);
  $("jevRemain").textContent = intent.jevRemaining ? `剩余 ${Number(intent.jevRemaining).toLocaleString()} tokens` : "";
  renderDocs();
  if (DESKTOP) fillDevices();
  $("settingsSheet").hidden = false;
}

// Mac 软件：列出录音设备。先放一个"当前选择"占位，避免列表还没出来时保存把选择清掉
async function fillDevices() {
  const sels = [["micDevice", "系统默认麦克风"], ["sysDevice", "不录（只用一个麦克风，线下会议）"]];
  const put = (list, initial) => {
    for (const [name, first] of sels) {
      const el = $("settingsForm")[name], cur = initial ? S[name] || "" : el.value;
      const opts = [{ id: "", label: first }, ...list];
      if (cur && !opts.some(o => o.id === cur)) opts.push({ id: cur, label: list.length ? "之前选的设备（现在没有连接）" : "已选的设备" });
      el.innerHTML = opts.map(o => `<option value="${esc(o.id)}">${esc(o.label)}</option>`).join("");
      el.value = cur;
    }
  };
  put([], true);
  let list = [];
  try { list = await Mic.devices(); } catch { /* ignore */ }
  put(list);
  const bh = list.find(d => /blackhole/i.test(d.label));
  $("bhHint").hidden = !!bh;
  if (bh && !S.sysDevice && !$("settingsForm").sysDevice.dataset.touched) {
    $("settingsForm").sysDevice.value = bh.id; // 装了 BlackHole 就默认选上
  }
}
for (const el of $("settingsForm").elements) if (KEY_FIELDS.includes(el.name)) el.dataset.ph = el.placeholder;
// 手机发来的操作（提问、开始 / 结束）
DESKTOP?.onRemote?.((cmd) => {
  if (!cmd) return;
  if (cmd.type === "ask" && String(cmd.text || "").trim()) ask(String(cmd.text).trim().slice(0, 500), "手机提问", "manual");
  else if (cmd.type === "start" && !rec.on) startRec(cmd.choice === "continue" ? "continue" : cmd.choice === "new" ? "new" : undefined);
  else if (cmd.type === "stop" && rec.on) stopRec();
  else if (cmd.type === "hello") syncAll();
});
DESKTOP?.onRemoteClients?.((n) => {
  $("phoneBtn").classList.toggle("linked", n > 0);
  $("phoneBtnLabel").textContent = n > 0 ? `手机 ${n}` : "手机";
  if (!$("phoneSheet").hidden) $("phoneCount").textContent = n > 0 ? `已连接 ${n} 部手机` : "还没有手机连接";
  if (n > (onRemoteClientsN || 0)) toast("手机已连接");
  onRemoteClientsN = n;
});
let onRemoteClientsN = 0;

// 电脑上显示二维码，手机扫码查看
async function openPhone() {
  $("phoneSheet").hidden = false;
  $("qrBox").innerHTML = `<div class="empty">正在准备…</div>`;
  let info;
  try { info = await DESKTOP.remote(); } catch (e) { info = { error: e.message }; }
  if (!info?.url) {
    $("qrBox").innerHTML = `<div class="empty">${esc(info?.error || "没有找到可用的网络。请确认电脑连上了 Wi-Fi")}</div>`;
    $("phoneUrl").textContent = "";
    return;
  }
  $("phoneUrl").textContent = info.url;
  $("phoneOther").textContent = (info.urls || []).length > 1 ? `扫不开时可以试：${info.urls.slice(1).join("  ")}` : "";
  $("phoneCount").textContent = info.clients > 0 ? `已连接 ${info.clients} 部手机` : "还没有手机连接";
  try {
    if (!window.qrcode) await new Promise((ok, bad) => { const sc = document.createElement("script"); sc.src = "vendor/qrcode.js"; sc.onload = ok; sc.onerror = bad; document.head.appendChild(sc); });
    const qr = window.qrcode(0, "M");
    qr.addData(info.url);
    qr.make();
    $("qrBox").innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
  } catch {
    $("qrBox").innerHTML = `<div class="empty">二维码没有生成，请在手机浏览器里输入下面的地址</div>`;
  }
}
$("phoneCopy").onclick = async () => { await copy($("phoneUrl").textContent); toast("已复制链接"); };

if (DESKTOP) {
  document.body.classList.add("desktop");
  if (DESKTOP.remote) { $("phoneBtn").hidden = false; $("phoneBtn").onclick = openPhone; }
  $("desktopAudio").hidden = false;
  $("settingsForm").querySelector(".note").textContent = "所有 Key、资料和会议记录只保存在这台电脑上，只会发送给对应的服务商。";
  $("clearAll").textContent = "清除这台电脑上的所有数据";
  $("homeHint").hidden = true;
  $("settingsForm").sysDevice.onchange = (e) => (e.target.dataset.touched = "1");
}
$("intentSel").onchange = (e) => ($("jevBox").hidden = e.target.value !== "jev");

// 对方说的语言：下拉列表 + 各处跟着变的文字
$("settingsForm").otherLang.innerHTML = LANGS.map(([c, zh, en]) => `<option value="${c}">${zh}${zh === en ? "" : `（${en}）`}</option>`).join("");
function paintLangs(other) {
  const f = $("settingsForm"), n = langZh(other);
  const set = (sel, val, text) => { const o = f[sel].querySelector(`option[value="${val}"]`); if (o) o.textContent = text; };
  set("translate", "two_way", `中文 ↔ ${n}互译`);
  set("translate", "to_other", `全部翻成${n}`);
  f.translate.querySelector('option[value="to_en"]').hidden = other === "en";
  f.translate.querySelector('option[value="to_other"]').hidden = false;
  set("answerLang", "other", `总是用${n}回答`);
  set("answerLang", "both", `中文 + ${n}（先中文，再${n}）`);
  f.answerLang.querySelector('option[value="other"]').hidden = other === "en";
  set("summaryLang", "other", n);
  f.summaryLang.querySelector('option[value="other"]').hidden = other === "en";
}
$("settingsForm").otherLang.onchange = (e) => paintLangs(e.target.value);

// 回答方式：默认 / 自定义
$("defaultPrompt").textContent = ANSWER_SYSTEM;
$("settingsForm").customPrompt.maxLength = CUSTOM_MAX;
function paintStyle() {
  const f = $("settingsForm"), custom = f.answerStyle.value === "custom";
  $("customBox").hidden = !custom;
  $("defaultBox").hidden = custom;
  if (custom && !f.customPrompt.value.trim()) f.customPrompt.value = ANSWER_SYSTEM; // 从默认内容开始改
}
$("settingsForm").answerStyle.onchange = paintStyle;
$("resetPrompt").onclick = () => { $("settingsForm").customPrompt.value = ANSWER_SYSTEM; };

$("settingsForm").onsubmit = (e) => {
  e.preventDefault();
  const f = e.target;
  for (const el of f.elements) {
    if (!el.name || !(el.name in S)) continue;
    if (el.type === "checkbox") S[el.name] = el.checked;
    else if (KEY_FIELDS.includes(el.name)) { if (el.value.trim()) S[el.name] = el.value.trim(); }
    else if (el.type === "number") S[el.name] = Number(el.value) || 0;
    else S[el.name] = el.value.trim();
  }
  store.saveSettings(S);
  router = new Router(S);
  intent = new Intent(S, router);
  $("settingsSheet").hidden = true;
  for (const d of kb.docs) if (d.idx?.status === "waiting") d.idx.status = "pending";
  indexer.run();
  setStatus(); renderAnswers(); renderCaptions();
  toast(rec.on && S.translate !== rec.translate ? "已保存。翻译设置下次「开始」时生效" : "已保存");
};

// 错误信息只留关键部分，例如"DeepSeek 出错（500）：服务器暂时出错"
function shortErr(m) {
  m = String(m || "").replace(/^(AI 整理失败：)+/, "").replace(/\s*\(request_id[^)]*\)/i, "");
  const c5 = m.match(/（(5\d\d)/);
  if (c5) m = `${m.match(/^([^：（]+?)[：（]/)?.[1]?.trim() || "服务商"} 服务器暂时出错（${c5[1]}），稍后重试即可`;
  return m.length > 80 ? m.slice(0, 80) + "…" : m;
}
function idxText(d) {
  const x = d.idx || {};
  switch (x.status) {
    case "done": return `<span class="ok">✓ AI 已整理</span>${x.model ? ` · ${esc(x.model)}` : ""} · ${x.chunks.reduce((n, c) => n + (c?.qa?.length || 0), 0)} 个预备问答${x.vec ? " · 已向量化" : ""}${x.vecError ? " · 向量失败" : ""}${x.failed
      ? `<br><span class="warn-t">有 ${x.failed}/${x.total} 段暂时没整理好（${esc(shortErr(x.error))}），这些段落开会时用原文检索</span> <button type="button" data-retry="${d.id}">重试这些段落</button>` : ""}`;
    case "running": return `AI 整理中 ${x.done || 0}/${x.total || "?"}…`;
    case "vector": return "正在生成向量…";
    case "waiting": return "等待整理（需要先填大模型 Key）";
    case "error": return `<span class="bad">整理失败：${esc(shortErr(x.error))}</span>（开会时仍可用原文检索）<button type="button" data-retry="${d.id}">重试</button>`;
    default: return S.autoIndex === false ? "未整理（只用原文检索）" : "排队等待 AI 整理…";
  }
}
function renderDocs() {
  const chars = kb.totalChars;
  const ready = kb.indexedCount;
  const mode = !kb.docs.length ? "还没有资料。对方提问时会提示「资料中未找到」"
    : `开会时先查 AI 整理好的索引（${ready}/${kb.docs.length} 份已整理），找不到再查原文。`;
  $("kbInfo").textContent = `${kb.docs.length} 份资料，约 ${chars >= 10000 ? (chars / 10000).toFixed(1) + " 万" : chars} 字。${mode}`;
  $("docList").innerHTML = kb.docs.map(d => `<li><span>${esc(d.name)}<br><small>${(d.text.length / 1000).toFixed(1)}k 字 · ${dateLabel(d.addedAt)}</small><br><small class="idx">${idxText(d)}</small></span><button type="button" class="del" data-doc="${d.id}">删除</button></li>`).join("");
}
$("reindexAll").onclick = () => {
  if (!router.ready) return toast("整理资料需要至少一个大模型的 Key");
  for (const d of kb.docs) d.idx = { status: "pending" };
  renderDocs();
  indexer.run();
};
$("docList").onclick = async (e) => {
  const retry = e.target.dataset?.retry;
  if (retry) {
    const d = kb.docs.find(x => x.id === retry);
    if (d) { if (d.idx.status === "done") d.idx.status = "running"; d.idx.retry = true; renderDocs(); indexer.run(); }
    return;
  }
  const id = e.target.dataset?.doc;
  if (!id) return;
  const d = kb.docs.find(x => x.id === id);
  if (d && confirm(`删除「${d.name}」？`)) { await kb.remove(id); renderDocs(); setStatus(); }
};
// 添加资料：每个文件的进度和结果都显示在列表里（不只是一闪而过的提示）
function docStatus(id, text, cls) {
  let li = document.getElementById(id);
  if (!li) { li = document.createElement("li"); li.id = id; $("docStatus").appendChild(li); }
  li.className = cls || "";
  li.innerHTML = `<span>${esc(text)}</span>` + (cls === "err" ? `<button type="button" onclick="this.parentNode.remove()">知道了</button>` : "");
  if (cls === "ok") setTimeout(() => li.remove(), 2500);
}
$("pickFiles").onclick = () => $("fileInput").click();
$("fileInput").onchange = async (e) => {
  const files = [...(e.target.files || [])];
  e.target.value = "";
  if (!files.length) return;
  for (const file of files) {
    const id = "st-" + uid();
    docStatus(id, `正在读取 ${file.name}…`, "busy");
    try {
      const d = await kb.add(file);
      docStatus(id, `已添加 ${file.name}（${(d.text.length / 1000).toFixed(1)}k 字）`, "ok");
    } catch (err) {
      console.warn("add doc", err);
      docStatus(id, err.message || String(err), "err");
    }
    renderDocs();
  }
  setStatus();
  indexer.run();
};
$("pasteAdd").onclick = async () => {
  const name = $("pasteName").value.trim() || `粘贴的资料 ${kb.docs.length + 1}`;
  const id = "st-" + uid();
  try {
    await kb.addText(name, $("pasteText").value);
    indexer.run();
    $("pasteText").value = ""; $("pasteName").value = "";
    docStatus(id, `已添加「${name}」`, "ok");
  } catch (err) { docStatus(id, `没有添加：${err.message}`, "err"); }
  renderDocs(); setStatus();
};
$("clearAll").onclick = async () => {
  if (!confirm("清除这部手机上的所有 Key、资料和会议记录？此操作不能撤销。")) return;
  if (rec.on) await stopRec();
  await store.clearAll();
  localStorage.removeItem("mc.current");
  location.reload();
};
$("settingsBtn").onclick = () => openSettings();
$("statusLine").onclick = () => { if (!rec.on && (!S.sonioxKey || !router.ready || intent.jevError)) openSettings(); };

// ---------------- 会议记录 ----------------
async function openHistory() {
  await save(true);
  const list = (await store.getAll("meetings")).sort((a, b) => b.startedAt - a.startedAt);
  $("histList").innerHTML = list.length ? list.map(m => `<li class="${m.id === M.id ? "cur" : ""}">
      <div class="info"><b>${esc(m.title)}</b><small>${dateLabel(m.startedAt)} · ${dur(m.totalSec || 0)} · ${m.lines.length} 句${m.summary ? " · 有总结" : ""}</small></div>
      ${m.id === M.id ? "<small>当前</small>" : `<button data-open="${m.id}">打开</button>`}
      <button class="del" data-del="${m.id}">删除</button></li>`).join("")
    : `<li><div class="info"><small>还没有会议记录</small></div></li>`;
  $("newMeeting").disabled = rec.on;
  $("historySheet").hidden = false;
}
$("historyBtn").onclick = openHistory;
$("histList").onclick = async (e) => {
  const open = e.target.dataset?.open, del = e.target.dataset?.del;
  if (open) {
    if (rec.on) return toast("录音中不能切换会议，请先结束");
    await save(true);
    M = await store.get("meetings", open);
    localStorage.setItem("mc.current", M.id);
    $("historySheet").hidden = true;
    renderAll();
    showTab(M.summary ? "summary" : "captions");
  } else if (del) {
    if (del === M.id && rec.on) return toast("录音中不能删除当前会议");
    if (!confirm("删除这场会议的记录？")) return;
    await store.del("meetings", del);
    if (del === M.id) { M = newMeeting(); renderAll(); }
    openHistory();
  }
};
$("newMeeting").onclick = async () => {
  if (rec.on) return;
  await save(true);
  M = newMeeting();
  $("historySheet").hidden = true;
  renderAll();
  showTab("answers");
};

// 关闭面板：点"完成/取消"或点空白处
document.querySelectorAll(".sheet-wrap").forEach(w => w.addEventListener("click", (e) => {
  if (w.id === "continueSheet") return;
  if (e.target === w || e.target.closest("[data-close]")) {
    // 设置面板：点"完成"或空白处也保存，避免填好的 Key 丢失
    if (w.id === "settingsSheet") $("settingsForm").requestSubmit();
    else w.hidden = true;
  }
}));

// ---------------- 启动 ----------------
function renderAll() { setStatus(); paintRec(); renderAnswers(); renderCaptions(); renderSummary(); syncAll(); }

(async function init() {
  if (/MicroMessenger|WeChat|QQ\/|Weibo|DingTalk|Lark|Feishu|FBAN|FBAV|Instagram|Line\//i.test(navigator.userAgent)) $("inAppWarn").hidden = false;
  loadRich(() => { renderAnswers(); renderSummary(); }); // 表格、公式等完整渲染（后台加载，好了就重新显示）
  await kb.load();
  indexer.run(); // 上次没整理完的资料接着整理
  const curId = localStorage.getItem("mc.current");
  if (curId) {
    const m = await store.get("meetings", curId).catch(() => null);
    if (m) { M = m; if (!M.endedAt) M.endedAt = Date.now(); } // 页面被关掉过：当作已结束
  }
  renderAll();
  if (!S.sonioxKey && !S.claudeKey && !S.openaiKey && !S.deepseekKey) openSettings("欢迎使用！先填写 API Key：Soniox（语音识别）必填，回答问题的大模型至少填一个。");
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
  window.addEventListener("beforeunload", (e) => { if (rec.on) { e.preventDefault(); e.returnValue = ""; } });
  window.__mc = { get M() { return M; }, get S() { return S; }, kb, rec };
})();
