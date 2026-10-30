// 会议助手 手机版：录音 -> 识别 + 翻译 -> 判断提问 -> 根据资料回答；结束后生成会议总结
import { $, esc, md, uid, hhmm, dur, dateLabel, toast, colorOf, download, shareOrCopy, copy, netError } from "./util.js";
import * as store from "./store.js";
import { Mic } from "./audio.js";
import { SonioxClient } from "./soniox.js";
import { Router } from "./llm.js";
import { Intent } from "./intent.js";
import { KnowledgeBase } from "./kb.js";
import { retrieve, answer as genAnswer, summarize, transcriptText, useFull } from "./brain.js";

// ---------------- 状态 ----------------
let S = store.loadSettings();
let router = new Router(S);
let intent = new Intent(S, router);
const kb = new KnowledgeBase();
let M = newMeeting();          // 当前会议
let tab = "answers";
const rec = { on: false, busy: false, mic: null, sx: null, started: 0, lastActivity: 0, wake: null, hiddenAt: 0, asr: "" };
const pending = {};            // sid -> { text, timer }：同一个人连续说的话合并成一"轮"再判断
let lastQ = ["", 0];
let live = { text: "", trans: "", sid: null };
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
function sidOf(spk) { return `spk${spk || 1}`; }
function nameOf(sid) {
  if (!M.names[sid]) M.names[sid] = "说话人" + (String(sid).replace(/\D/g, "") || "1");
  return M.names[sid];
}
const isMe = (sid) => M.me.includes(sid);
function context() { return M.lines.slice(-12).map(l => `${nameOf(l.sid)}: ${l.text}`); }

// ---------------- 顶部状态 ----------------
function setStatus() {
  const el = $("statusLine");
  let text, bad = false;
  if (rec.on) text = rec.asr || "识别中";
  else if (!S.sonioxKey || !router.ready) { text = "请先在设置里填写 API Key"; bad = true; }
  else {
    const docs = kb.docs.length ? `资料 ${kb.docs.length} 份` : "资料库为空";
    text = `${M.endedAt ? "已结束" : "未开始"} · ${docs} · ${router.label()}`;
  }
  if (intent.jevError) { text += ` · Jev 出错`; bad = true; }
  el.textContent = text;
  el.classList.toggle("bad", bad || /失败|中断|无效|出错/.test(text));
  $("mTitle").textContent = M.title;
}

function paintRec() {
  const b = $("recBtn");
  b.classList.toggle("on", rec.on);
  b.classList.toggle("busy", rec.busy);
  $("recLabel").textContent = rec.busy ? (rec.on ? "结束中" : "连接中") : rec.on ? "结束" : "开始";
  $("recTime").textContent = rec.on ? dur((Date.now() - rec.started) / 1000) : "";
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
function answerHTML(a, latest) {
  const tag = a.origin === "manual" ? `<span class="tag manual">手动提问</span>` : `<span class="tag">${esc(a.asker || "对方")}</span>`;
  return `<div class="card ${latest ? "latest" : ""} ${a.done ? "" : "streaming"}" id="a-${a.id}">
    <div class="q">${tag}<b>${esc(a.question)}</b> <span style="color:var(--faint)">· ${hhmm(a.ts)}</span></div>
    <div class="body">${md(a.text)}</div></div>`;
}

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
  const el = $("a-" + a.id);
  if (!el) return renderAnswers();
  el.querySelector(".body").innerHTML = md(a.text);
  el.classList.toggle("streaming", !a.done);
}

async function ask(question, asker, origin) {
  const a = { id: uid(), question, asker, origin, text: "", ts: Date.now(), done: false, sources: [] };
  M.answers.push(a);
  renderAnswers(true);
  badge("answers");
  if (tab === "answers") window.scrollTo({ top: 0, behavior: "smooth" });
  if (origin !== "manual") navigator.vibrate?.(60);
  try {
    const r = await retrieve(router, kb, question);
    a.sources = r.full ? kb.docs.map(d => d.name) : [...new Set((r.hits || []).map(h => h.source))];
    let n = 0;
    for await (const t of genAnswer(router, kb, question, context(), r)) {
      a.text += t;
      if (++n % 2 === 0) updateAnswer(a);
    }
  } catch (e) {
    a.text += `\n\n（出错：${netError(e, "回答")}）`;
  }
  a.done = true;
  updateAnswer(a);
  save();
}

// ---------------- 字幕 ----------------
function lineHTML(l) {
  const me = isMe(l.sid);
  return `<div class="line ${me ? "me" : ""}" id="${l.id}">
    <div class="h"><button class="who" data-sid="${l.sid}" style="color:${colorOf(l.sid, me)}">${esc(nameOf(l.sid))}${me ? "（我）" : ""}</button><span class="time">${hhmm(l.ts)}</span></div>
    <div class="tx">${esc(l.text)}</div>${l.trans ? `<div class="tr">${esc(l.trans)}</div>` : ""}</div>`;
}

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
  if (!live.text) { $("live").innerHTML = ""; return; }
  const sid = live.sid || "spk1";
  $("live").innerHTML = `<div class="line live"><div class="h"><span class="who" style="color:${colorOf(sid, isMe(sid))}">${esc(nameOf(sid))}</span></div>
    <div class="tx">${esc(live.text)}</div>${live.trans ? `<div class="tr">${esc(live.trans)}</div>` : ""}</div>`;
}

$("showTrans").onchange = (e) => { S.showTranslation = e.target.checked; store.saveSettings(S); renderCaptions(); };

$("lines").addEventListener("click", (e) => {
  const b = e.target.closest(".who");
  if (b) openSpeaker(b.dataset.sid);
});

// ---------------- 识别回调 ----------------
function onLine(l) {
  const sid = sidOf(l.spk);
  nameOf(sid);
  const line = { id: l.id, sid, text: l.text, trans: l.trans, ts: Date.now() };
  M.lines.push(line);
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
  const el = $(id);
  if (el) el.outerHTML = lineHTML(l);
  save();
}

function onPartial(p) {
  live = { text: p.text, trans: p.trans, sid: p.text ? sidOf(p.spk) : null };
  if (p.text) {
    rec.lastActivity = Date.now();
    // 对方还在说：推迟判断
    const pp = pending[live.sid];
    if (pp) { clearTimeout(pp.timer); pp.timer = setTimeout(() => settle(live.sid), S.settleMs || 1200); }
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

async function startRec() {
  if (rec.on || rec.busy) return;
  if (!S.sonioxKey) return openSettings("开始录音前，请先填写 Soniox API Key（用于语音识别和翻译）。");
  // iOS 要求在点击时同步创建音频环境，所以先建好再做其他事
  const AC = window.AudioContext || window.webkitAudioContext;
  let ctx = null;
  try { ctx = new AC(); } catch { /* 在 Mic 里再试 */ }
  if (M.endedAt && (M.lines.length || M.answers.length)) {
    const c = await chooseContinue();
    if (c === "cancel") { ctx?.close(); return; }
    if (c === "new") { await save(true); M = newMeeting(); live = { text: "", trans: "", sid: null }; renderAll(); }
  }
  rec.busy = true; paintRec();
  const sx = new SonioxClient({
    key: S.sonioxKey, translate: S.translate,
    terms: S.terms.split(/[,，、\n]/).map(x => x.trim()).filter(Boolean), context: S.contextText,
    onLine, onPartial, onLateTranslation,
    onStatus: (t) => { rec.asr = t; setStatus(); },
    onError: (msg) => { toast(msg, 6000); rec.asr = msg; setStatus(); if (/Key 无效/.test(msg)) stopRec(); },
  });
  const mic = new Mic((pcm) => sx.send(pcm), (lv) => $("recBtn").style.setProperty("--lv", Math.min(1, lv * 3).toFixed(2)));
  try {
    await mic.start(ctx);
  } catch (e) {
    rec.busy = false; paintRec(); ctx?.close();
    const denied = e.name === "NotAllowedError" || e.name === "SecurityError";
    return toast(denied ? "没有麦克风权限：请在浏览器设置里允许这个网页使用麦克风" : `无法启动麦克风：${e.message}`, 6000);
  }
  try {
    await sx.connect();
  } catch (e) {
    mic.stop(); rec.busy = false; paintRec();
    return toast(e.message || "无法连接识别服务", 6000);
  }
  Object.assign(rec, { on: true, busy: false, mic, sx, started: Date.now(), lastActivity: Date.now(), asr: "识别中", translate: S.translate });
  M.endedAt = null;
  keepAwake();
  paintRec(); setStatus(); renderCaptions();
  if (!M.lines.length) toast("已开始。请保持屏幕亮着、不要切到其他 App");
}

async function stopRec(reason) {
  if (!rec.on || rec.busy) return;
  rec.busy = true; paintRec();
  rec.mic?.stop();
  await rec.sx?.finish();
  M.totalSec += (Date.now() - rec.started) / 1000;
  M.endedAt = Date.now();
  Object.assign(rec, { on: false, busy: false, mic: null, sx: null, asr: "" });
  live = { text: "", trans: "", sid: null };
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
  await rec.mic?.resume();
  rec.sx?.ensure();
  keepAwake();
  if (rec.hiddenAt && Date.now() - rec.hiddenAt > 3000) {
    showBanner("刚才切到了后台或锁屏，这段时间的声音可能没有录到。开会时请保持这个页面在前台、屏幕亮着。");
  }
  if (rec.mic && !rec.mic.alive) {
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
    for await (const x of summarize(router, M, S.summaryLang)) {
      if (x.progress) { $("sumBody").innerHTML = `<div class="empty">${esc(x.progress)}</div>`; continue; }
      M.summary += x.text;
      if (++n % 3 === 0 && tab === "summary") $("sumBody").innerHTML = md(M.summary);
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
  renderCaptions(); renderAnswers(); save();
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
  $("jevRemain").textContent = intent.jevRemaining ? `剩余 ${Number(intent.jevRemaining).toLocaleString()} tokens` : "";
  renderDocs();
  $("settingsSheet").hidden = false;
}
for (const el of $("settingsForm").elements) if (KEY_FIELDS.includes(el.name)) el.dataset.ph = el.placeholder;
$("intentSel").onchange = (e) => ($("jevBox").hidden = e.target.value !== "jev");

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
  setStatus(); renderAnswers(); renderCaptions();
  toast(rec.on && S.translate !== rec.translate ? "已保存。翻译设置下次「开始」时生效" : "已保存");
};

function renderDocs() {
  const chars = kb.totalChars;
  const mode = useFull(router, kb) ? "资料较少，会整体交给大模型阅读（最准确）" : kb.docs.length ? "资料较多，会先检索相关段落再回答" : "还没有资料。对方提问时会提示「资料中未找到」";
  $("kbInfo").textContent = `${kb.docs.length} 份资料，约 ${chars >= 10000 ? (chars / 10000).toFixed(1) + " 万" : chars} 字。${mode}`;
  $("docList").innerHTML = kb.docs.map(d => `<li><span>${esc(d.name)}<br><small>${(d.text.length / 1000).toFixed(1)}k 字 · ${dateLabel(d.addedAt)}</small></span><button type="button" class="del" data-doc="${d.id}">删除</button></li>`).join("");
}
$("docList").onclick = async (e) => {
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
};
$("pasteAdd").onclick = async () => {
  const name = $("pasteName").value.trim() || `粘贴的资料 ${kb.docs.length + 1}`;
  const id = "st-" + uid();
  try {
    await kb.addText(name, $("pasteText").value);
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
function renderAll() { setStatus(); paintRec(); renderAnswers(); renderCaptions(); renderSummary(); }

(async function init() {
  if (/MicroMessenger|WeChat|QQ\/|Weibo|DingTalk|Lark|Feishu|FBAN|FBAV|Instagram|Line\//i.test(navigator.userAgent)) $("inAppWarn").hidden = false;
  await kb.load();
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
