// 同声传译（独立页面）：OpenAI gpt-realtime-translate，浏览器用 WebRTC 直连。
// 文档：https://developers.openai.com/api/docs/guides/realtime-translation
//   · 外语 → 中文：一路会话，目标语言中文（你说中文时模型不会重复翻译）
//   · 双向：再加一路，目标语言为对方语言，把你的中文翻给对方（对方说的外语不会被重复翻译）
// 双向时用手机外放，翻译的声音会被麦克风录回去：播放期间暂停收音，播完自动恢复。
import { $, esc, toast, dur, download } from "../js/util.js";

const SECRET_URL = "https://api.openai.com/v1/realtime/translations/client_secrets";
const CALLS_URL = "https://api.openai.com/v1/realtime/translations/calls";
const MODEL = "gpt-realtime-translate";
const LANG_NAME = { zh: "中文", en: "English", ja: "日本語", ko: "한국어", fr: "Français", de: "Deutsch", es: "Español",
  pt: "Português", ru: "Русский", it: "Italiano", hi: "हिन्दी", id: "Indonesia", vi: "Tiếng Việt" };

// ---------------- 设置（和会议助手分开保存） ----------------
const KEY = "mi.settings.v1";
const DEF = { openaiKey: "", mode: "to_me", otherLang: "en", gate: "auto", autoStopMin: 10, showOriginal: true };
let S;
try { S = { ...DEF, ...JSON.parse(localStorage.getItem(KEY) || "{}") }; } catch { S = { ...DEF }; }
function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch { /* ignore */ } }
// 没填 Key 时，用会议助手里填的 OpenAI Key
function mainKey() { try { return JSON.parse(localStorage.getItem("mc.settings.v1") || "{}").openaiKey || ""; } catch { return ""; } }
const apiKey = () => S.openaiKey || mainKey();

// ---------------- 对话记录（只保留本机最近一次） ----------------
const LOG_KEY = "mi.log.v1";
let items = [];
try { items = JSON.parse(localStorage.getItem(LOG_KEY) || "[]"); } catch { items = []; }
let saveTimer;
function saveLog() { clearTimeout(saveTimer); saveTimer = setTimeout(() => { try { localStorage.setItem(LOG_KEY, JSON.stringify(items.slice(-300))); } catch { /* ignore */ } }, 800); }

const hasHan = (s) => (s.match(/[一-鿿]/g) || []).length;
const hasKana = (s) => /[぀-ヿ가-힯]/.test(s);
const looksChinese = (s) => hasHan(s) > 0 && !hasKana(s) && hasHan(s) >= s.replace(/\s/g, "").length * 0.3;

// ---------------- 一路同传 ----------------
class Channel {
  constructor({ lang, side, track }) {
    Object.assign(this, { lang, side, track });
    this.lastOutAt = 0;
    this.cur = null;          // 正在显示的气泡
    this.src = [];            // 最近收到的原文片段 [{t, text}]
    this.closed = false;
  }

  async start(key, audioCtx) {
    let r;
    try {
      r = await fetch(SECRET_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ session: { model: MODEL, audio: { output: { language: this.lang } } } }),
      });
    } catch {
      throw new Error("无法连接 OpenAI：请检查网络");
    }
    if (!r.ok) {
      let m = ""; try { m = (await r.json()).error?.message || ""; } catch { /* ignore */ }
      const hint = { 401: "OpenAI Key 无效", 403: "这个 Key 没有同传模型的权限", 429: "调用太频繁或额度用完" }[r.status] || "";
      throw new Error(`同传连接失败（${r.status}${hint ? " " + hint : ""}）${m ? "：" + m : ""}`);
    }
    const secret = (await r.json()).value;
    if (!secret) throw new Error("同传连接失败：没有拿到会话凭证");

    const PC = window.__mcFakeRTC || window.RTCPeerConnection; // 测试时可替换成模拟连接
    if (!PC) throw new Error("这个浏览器不支持实时通话（WebRTC）");
    const pc = (this.pc = new PC());
    this.audio = new Audio();
    this.audio.autoplay = true;
    this.audio.playsInline = true;
    pc.ontrack = ({ streams }) => {
      this.audio.srcObject = streams[0];
      this.audio.play?.().catch(() => {});
      this.watchLevel(audioCtx, streams[0]);
    };
    pc.addTrack(this.track, new MediaStream([this.track]));
    this.dc = pc.createDataChannel("oai-events");
    this.dc.onmessage = (ev) => { try { onEvent(this, JSON.parse(ev.data)); } catch { /* ignore */ } };
    pc.onconnectionstatechange = () => {
      if ((pc.connectionState === "failed" || pc.connectionState === "disconnected") && !this.closed) {
        toast("同传连接中断，请点「结束」后重新开始", 6000);
      }
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const ans = await fetch(CALLS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/sdp" },
      body: offer.sdp,
    });
    if (!ans.ok) throw new Error(`同传连接失败（${ans.status}）`);
    await pc.setRemoteDescription({ type: "answer", sdp: await ans.text() });
  }

  // 用音量判断"正在播放翻译"
  watchLevel(ctx, stream) {
    try {
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(an);
      const buf = new Float32Array(an.fftSize);
      const tick = () => {
        if (this.closed) return;
        an.getFloatTimeDomainData(buf);
        let p = 0; for (const v of buf) p = Math.max(p, Math.abs(v));
        if (p > 0.02) this.lastOutAt = Date.now();
        this.lvTimer = setTimeout(tick, 50);
      };
      tick();
    } catch { /* 不支持就只用文字事件判断 */ }
  }

  get playing() { return Date.now() - this.lastOutAt < 600; }

  close() {
    this.closed = true;
    clearTimeout(this.lvTimer);
    try { if (this.dc?.readyState === "open") this.dc.send(JSON.stringify({ type: "session.close" })); } catch { /* ignore */ }
    setTimeout(() => { try { this.pc?.close(); } catch { /* ignore */ } try { this.track.stop(); } catch { /* ignore */ } }, 800);
    if (this.audio) this.audio.srcObject = null;
  }
}

// ---------------- 收到同传事件 ----------------
const GAP = 1800; // 停顿超过这么久，下一句另起一个气泡
function onEvent(ch, ev) {
  const t = ev.type || "";
  const now = Date.now();
  if (t === "session.output_transcript.delta" && ev.delta) {
    ch.lastOutAt = now;
    st.lastActivity = now;
    if (!ch.cur || now - ch.cur.at > GAP) {
      // 新的一句：带上这一路最近听到的、对应语言的原文
      const orig = ch.src.filter(x => now - x.t < 15000).map(x => x.text).join("").trim();
      ch.src = [];
      ch.cur = { id: "b" + now + ch.side, side: ch.side, lang: ch.lang, tr: "", orig, ts: now, at: now };
      items.push(ch.cur);
      addBubble(ch.cur);
    }
    ch.cur.tr += ev.delta;
    ch.cur.at = now;
    updateBubble(ch.cur, true);
    saveLog();
  } else if (t === "session.output_audio.delta") {
    ch.lastOutAt = now;
  } else if (t === "session.input_transcript.delta" && ev.delta) {
    st.lastActivity = now;
    // 只保留"需要被这一路翻译"的原文：→中文 那路留外语，→对方语言 那路留中文
    const zh = looksChinese(ev.delta);
    if ((ch.side === "them") !== zh) {
      ch.src.push({ t: now, text: ev.delta });
      if (ch.cur && now - ch.cur.at < GAP) { ch.cur.orig = (ch.cur.orig + ev.delta).trim(); updateBubble(ch.cur, true); }
    }
  } else if (t === "error") {
    toast(`同传出错：${ev.error?.message || ev.message || "未知错误"}`, 6000);
  }
}

// ---------------- 界面 ----------------
const st = { on: false, busy: false, started: 0, lastActivity: 0, channels: [], mic: null, ctx: null, gated: false, wake: null, hiddenAt: 0 };

function bubbleHTML(b, live) {
  const who = b.side === "me" ? `我 → ${LANG_NAME[b.lang] || b.lang}` : `对方 → 中文`;
  return `<div class="bub ${b.side}${live ? " live" : ""}" id="${b.id}">
    <div class="who">${esc(who)}</div>${b.orig ? `<div class="orig">${esc(b.orig)}</div>` : ""}<div class="tr">${esc(b.tr)}</div></div>`;
}
function nearBottom() { return window.innerHeight + window.scrollY >= document.body.scrollHeight - 160; }
function addBubble(b) {
  const stick = nearBottom();
  $("convo").querySelector(".hello")?.remove();
  $("convo").insertAdjacentHTML("beforeend", bubbleHTML(b, true));
  if (stick) window.scrollTo(0, document.body.scrollHeight);
  setTimeout(() => { const el = $(b.id); if (el && Date.now() - b.at >= GAP) el.classList.remove("live"); }, GAP + 200);
}
function updateBubble(b, live) {
  const el = $(b.id);
  if (!el) return;
  const stick = nearBottom();
  el.outerHTML = bubbleHTML(b, live);
  if (stick) window.scrollTo(0, document.body.scrollHeight);
  clearTimeout(b._t);
  b._t = setTimeout(() => $(b.id)?.classList.remove("live"), GAP + 200);
}
function renderConvo() {
  $("convo").classList.toggle("hide-orig", !S.showOriginal);
  if (!items.length) {
    $("convo").innerHTML = `<div class="hello">
      <b>怎么用</b>
      <ol>
        <li>在右上角「设置」里填 OpenAI API Key（会议助手里填过的会自动使用）</li>
        <li>选择方向：<b>外语 → 中文</b>（戴耳机自己听）或 <b>双向</b>（外放，对方也能听到你的话的翻译）</li>
        <li>点下面的<b>「开始同传」</b>，结束时点「结束」</li>
      </ol>
      左边是对方的话翻成的中文，右边是你的话翻成的${esc(LANG_NAME[S.otherLang] || "外语")}。</div>`;
    return;
  }
  $("convo").innerHTML = items.map(b => bubbleHTML(b, false)).join("");
}

function paint() {
  document.querySelectorAll(".modes button").forEach(b => { b.classList.toggle("on", b.dataset.mode === S.mode); b.setAttribute("aria-checked", b.dataset.mode === S.mode); });
  $("otherLang").value = S.otherLang;
  $("otherLang").closest(".lang").style.visibility = S.mode === "two_way" ? "visible" : "hidden";
  document.querySelector(".modes").classList.toggle("locked", st.on || st.busy);
  const g = $("goBtn");
  g.classList.toggle("on", st.on);
  g.classList.toggle("busy", st.busy);
  $("goLabel").textContent = st.busy ? (st.on ? "结束中…" : "连接中…") : st.on ? "结束" : "开始同传";
  $("timer").textContent = st.on ? dur((Date.now() - st.started) / 1000) : "";
  let s;
  if (st.on) s = `同传中 · ${st.channels.map(c => c.side === "me" ? `我→${LANG_NAME[c.lang]}` : "对方→中文").join(" / ")}`;
  else if (!apiKey()) s = "请先在设置里填写 OpenAI Key";
  else s = S.mode === "two_way" ? `双向：对方↔中文（我的话翻成 ${LANG_NAME[S.otherLang]}）` : "外语 → 中文";
  $("status").textContent = s;
  $("status").classList.toggle("bad", !st.on && !apiKey());
}
setInterval(() => { if (st.on) paint(); }, 1000);

document.querySelectorAll(".modes button").forEach(b => (b.onclick = () => { S.mode = b.dataset.mode; save(); paint(); renderConvo(); }));
$("otherLang").onchange = (e) => { S.otherLang = e.target.value; save(); paint(); renderConvo(); };

// ---------------- 开始 / 结束 ----------------
async function start() {
  if (st.on || st.busy) return;
  const key = apiKey();
  if (!key) return openSettings("请先填写 OpenAI API Key。");
  // iOS 要求在点击时同步创建音频环境
  const AC = window.AudioContext || window.webkitAudioContext;
  st.ctx = new AC();
  st.busy = true; paint();
  try {
    st.mic = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    if (st.ctx.state === "suspended") await st.ctx.resume();
  } catch (e) {
    st.busy = false; paint(); st.ctx.close?.();
    return toast(e.name === "NotAllowedError" ? "没有麦克风权限：请在浏览器设置里允许这个网页使用麦克风" : `无法启动麦克风：${e.message}`, 6000);
  }
  const plan = [{ lang: "zh", side: "them" }];
  if (S.mode === "two_way") plan.push({ lang: S.otherLang, side: "me" });
  st.channels = plan.map(p => new Channel({ ...p, track: st.mic.getAudioTracks()[0].clone() }));
  try {
    await Promise.all(st.channels.map(c => c.start(key, st.ctx)));
  } catch (e) {
    st.channels.forEach(c => c.close()); st.channels = [];
    st.mic.getTracks().forEach(t => t.stop()); st.mic = null;
    st.busy = false; paint();
    return toast(e.message, 8000);
  }
  Object.assign(st, { on: true, busy: false, started: Date.now(), lastActivity: Date.now() });
  keepAwake();
  paint();
  toast(S.mode === "two_way" ? "已开始。请用手机外放，保持屏幕亮着" : "已开始。建议戴耳机，保持屏幕亮着", 4000);
}

async function stop(reason) {
  if (!st.on) return;
  st.busy = true; paint();
  setGate(false);
  st.channels.forEach(c => c.close());
  await new Promise(r => setTimeout(r, 300));
  st.mic?.getTracks().forEach(t => t.stop());
  try { st.ctx?.close(); } catch { /* ignore */ }
  Object.assign(st, { on: false, busy: false, channels: [], mic: null, ctx: null });
  releaseAwake();
  document.querySelectorAll(".bub.live").forEach(el => el.classList.remove("live"));
  paint();
  toast(reason || "已结束，不再计费", 5000);
  saveLog();
}

$("goBtn").onclick = () => (st.on ? stop() : start());

// 防回声：任一路在播放翻译时暂停收音
function gateWanted() { return S.gate === "on" || (S.gate === "auto" && S.mode === "two_way"); }
function setGate(on) {
  if (on === st.gated) return;
  st.gated = on;
  for (const c of st.channels) c.track.enabled = !on;
  $("gate").hidden = !on;
}
setInterval(() => {
  if (!st.on) return;
  setGate(gateWanted() && st.channels.some(c => c.playing));
  const min = Number(S.autoStopMin) || 0;
  if (min > 0 && Date.now() - st.lastActivity > min * 60000) stop(`连续 ${min} 分钟没有人说话，已自动结束`);
}, 100);

async function keepAwake() { try { st.wake = await navigator.wakeLock?.request("screen"); } catch { /* ignore */ } }
function releaseAwake() { try { st.wake?.release(); } catch { /* ignore */ } st.wake = null; }
document.addEventListener("visibilitychange", () => {
  if (!st.on) return;
  if (document.hidden) { st.hiddenAt = Date.now(); return; }
  keepAwake();
  st.ctx?.resume?.();
  if (st.hiddenAt && Date.now() - st.hiddenAt > 3000) {
    const b = $("banner");
    b.textContent = "刚才切到了后台或锁屏，这段时间可能没有同传。使用时请保持这个页面在前台、屏幕亮着。";
    b.hidden = false;
    setTimeout(() => (b.hidden = true), 10000);
  }
});
window.addEventListener("beforeunload", (e) => { if (st.on) { e.preventDefault(); e.returnValue = ""; } });

// ---------------- 导出 / 清空 ----------------
$("exportBtn").onclick = () => {
  if (!items.length) return toast("还没有内容");
  const text = items.map(b => {
    const t = new Date(b.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const who = b.side === "me" ? `我 → ${LANG_NAME[b.lang] || b.lang}` : "对方 → 中文";
    return `[${t}] ${who}\n${b.orig ? `原文：${b.orig}\n` : ""}译文：${b.tr}\n`;
  }).join("\n");
  download(`同声传译 ${new Date().toLocaleDateString()}.txt`, text, "text/plain");
};
$("clearBtn").onclick = () => {
  if (!items.length) return;
  if (!confirm("清空这页上的同传记录？")) return;
  items = []; saveLog(); renderConvo();
};

// ---------------- 设置 ----------------
function openSettings(msg) {
  const f = $("settingsForm");
  f.openaiKey.value = "";
  f.openaiKey.placeholder = S.openaiKey ? "已设置（留空保持不变）" : "sk-…";
  $("keyFrom").hidden = !!S.openaiKey || !mainKey();
  f.gate.value = S.gate;
  f.autoStopMin.value = S.autoStopMin;
  f.showOriginal.checked = !!S.showOriginal;
  $("setupMsg").hidden = !msg;
  $("setupMsg").textContent = msg || "";
  $("settingsSheet").hidden = false;
}
$("settingsForm").onsubmit = (e) => {
  e.preventDefault();
  const f = e.target;
  if (f.openaiKey.value.trim()) S.openaiKey = f.openaiKey.value.trim();
  S.gate = f.gate.value;
  S.autoStopMin = Number(f.autoStopMin.value) || 0;
  S.showOriginal = f.showOriginal.checked;
  save();
  $("settingsSheet").hidden = true;
  paint(); renderConvo();
  toast("已保存");
};
$("settingsBtn").onclick = () => openSettings();
$("settingsSheet").addEventListener("click", (e) => {
  if (e.target === $("settingsSheet") || e.target.closest("[data-close]")) $("settingsForm").requestSubmit();
});

// ---------------- 启动 ----------------
if (/MicroMessenger|WeChat|QQ\/|Weibo|DingTalk|Lark|Feishu/i.test(navigator.userAgent)) {
  const b = $("banner");
  b.textContent = "你正在微信（或其他 App）里打开，这里不能录音：请点右上角「···」，选择「在浏览器中打开」。";
  b.hidden = false;
}
paint();
renderConvo();
if (!apiKey()) openSettings("欢迎使用同声传译！先填写 OpenAI API Key。");
window.__mi = { st, get items() { return items; }, S };
