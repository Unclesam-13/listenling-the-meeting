// 通用小工具：转义、Markdown 渲染、时间格式、提示
export const $ = (id) => document.getElementById(id);

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ---------------- 渲染：Markdown（表格、代码、列表…）+ 数学公式（KaTeX） ----------------
// 渲染库发布时由 GitHub 打包到 vendor/；万一没有就从公共 CDN 加载；都加载不了时用下面的简易渲染
const RICH = {
  marked: ["vendor/marked.umd.js", "https://cdn.jsdelivr.net/npm/marked@12.0.2/lib/marked.umd.js"],
  purify: ["vendor/purify.min.js", "https://cdn.jsdelivr.net/npm/dompurify@3.1.6/dist/purify.min.js"],
  katex: ["vendor/katex/katex.min.js", "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js"],
  katexCss: ["vendor/katex/katex.min.css", "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css"],
};
let rich = null;

function addScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = src; el.onload = resolve; el.onerror = () => { el.remove(); reject(new Error(src)); };
    document.head.appendChild(el);
  });
}
async function firstOk(list, loader) {
  for (const src of list) { try { await loader(src); return true; } catch { /* 试下一个 */ } }
  return false;
}
async function hasLocal(path) {
  try { return (await fetch(path, { method: "HEAD" })).ok; } catch { return false; }
}

// 启动时在后台加载；加载好之后调用 onReady 重新渲染
export async function loadRich(onReady) {
  try {
    const local = await hasLocal(RICH.marked[0]);
    const pick = (l) => (local ? l : l.slice(1)); // 没有本地文件就直接用 CDN，不发多余的请求
    const css = document.createElement("link");
    css.rel = "stylesheet"; css.href = pick(RICH.katexCss)[0];
    document.head.appendChild(css);
    const [m, p, k] = await Promise.all([firstOk(pick(RICH.marked), addScript), firstOk(pick(RICH.purify), addScript), firstOk(pick(RICH.katex), addScript)]);
    if (m && p && window.marked && window.DOMPurify) {
      rich = { marked: window.marked, purify: window.DOMPurify, katex: k ? window.katex : null };
      onReady?.();
    }
  } catch (e) { console.warn("rich render", e); }
}
export const richReady = () => !!rich;

// 把公式先取出来（避免被 Markdown 改坏），渲染完 Markdown 再放回去
export function extractMath(src) {
  const maths = [], codes = [];
  const hold = (tex, display) => { maths.push([tex.trim(), display]); return `\u0000M${maths.length - 1}\u0000`; };
  let s = src.replace(/```[\s\S]*?(?:```|$)|`[^`\n]+`/g, (m) => { codes.push(m); return `\u0000C${codes.length - 1}\u0000`; });
  s = s.replace(/\$\$([\s\S]+?)\$\$/g, (_, t) => hold(t, true))
       .replace(/\\\[([\s\S]+?)\\\]/g, (_, t) => hold(t, true))
       .replace(/\\\(([\s\S]+?)\\\)/g, (_, t) => hold(t, false))
       // 行内 $...$：前后不能是空格、后面不能紧跟数字（避免把 "$99 到 $199" 这种价格当成公式）
       .replace(/\$([^$\n]+?)\$/g, (m, t, off, str) => {
         if (/^\s|\s$/.test(t) || /\d/.test(str[off + m.length] || "") || str[off - 1] === "\\") return m;
         return hold(t, false);
       });
  s = s.replace(/\u0000C(\d+)\u0000/g, (_, i) => codes[i]);
  return { s, maths };
}

function renderMath(tex, display) {
  if (!rich?.katex) return `<code class="tex">${esc(display ? `$$${tex}$$` : `$${tex}$`)}</code>`;
  try { return rich.katex.renderToString(tex, { displayMode: display, throwOnError: false, output: "html", strict: "ignore" }); }
  catch { return `<code class="tex">${esc(tex)}</code>`; }
}

export function md(text) {
  if (!rich) return mdSimple(text);
  const { s, maths } = extractMath(text || "");
  let html = rich.marked.parse(s, { gfm: true, breaks: true, async: false });
  html = rich.purify.sanitize(html, { ADD_ATTR: ["target"] });
  html = html.replace(/\u0000M(\d+)\u0000/g, (_, i) => renderMath(...maths[i]))
    .replace(/<table>/g, '<div class="tbl"><table>').replace(/<\/table>/g, "</table></div>")
    .replace(/<a /g, '<a target="_blank" rel="noopener" ')
    .replace(/<p>((?:来源|Source|Sources)\s*[:：][\s\S]*?)<\/p>/gi, '<p class="src">$1</p>');
  return html;
}

// 简易渲染（渲染库还没加载好时用）：标题、列表、待办、加粗、来源行
export function mdSimple(text) {
  const lines = esc(text || "").split("\n");
  let html = "", list = null;
  const close = () => { if (list) { html += `</${list}>`; list = null; } };
  for (const raw of lines) {
    let l = raw.trim().replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, "<code>$1</code>");
    let m;
    if ((m = l.match(/^(#{1,4})\s+(.*)/))) { close(); html += `<h${Math.min(m[1].length + 2, 5)}>${m[2]}</h${Math.min(m[1].length + 2, 5)}>`; continue; }
    if ((m = l.match(/^[-*•]\s+\[( |x|X)\]\s+(.*)/))) {
      if (list !== "ul") { close(); html += `<ul class="todo">`; list = "ul"; }
      html += `<li><span class="box">${m[1].trim() ? "☑" : "☐"}</span>${m[2]}</li>`; continue;
    }
    if ((m = l.match(/^[-*•]\s+(.*)/))) { if (list !== "ul") { close(); html += "<ul>"; list = "ul"; } html += `<li>${m[1]}</li>`; continue; }
    if ((m = l.match(/^\d+[.)、]\s+(.*)/))) { if (list !== "ol") { close(); html += "<ol>"; list = "ol"; } html += `<li>${m[1]}</li>`; continue; }
    close();
    if (!l) continue;
    if (/^(来源|Source|Sources)[:：]/i.test(l)) html += `<p class="src">${l}</p>`;
    else html += `<p>${l}</p>`;
  }
  close();
  return html;
}

export function hhmm(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function dur(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
  return (h ? h + ":" : "") + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
}

export function dateLabel(ts) {
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

let toastTimer;
export function toast(text, ms = 3500) {
  const el = $("toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

// 说话人颜色（稳定）
const PALETTE = ["#2f7d6d", "#b5562b", "#6a4fb3", "#a33a62", "#3d6fa8", "#7a6a1f"];
export function colorOf(sid, me) {
  if (me) return "var(--me)";
  const n = parseInt(String(sid).replace(/\D/g, "")) || 1;
  return PALETTE[(n - 1) % PALETTE.length];
}

export function download(name, text, type = "text/markdown") {
  const blob = new Blob([text], { type: type + ";charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

export async function shareOrCopy(title, text) {
  if (navigator.share) {
    try { await navigator.share({ title, text }); return "shared"; } catch (e) { if (e.name === "AbortError") return "cancel"; }
  }
  await copy(text);
  return "copied";
}

export async function copy(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {
    const t = document.createElement("textarea");
    t.value = text; document.body.appendChild(t); t.select();
    try { document.execCommand("copy"); } finally { t.remove(); }
    return true;
  }
}

// 把网络错误翻译成人话
export function netError(e, label) {
  const msg = String(e?.message || e);
  if (e?.name === "TypeError" || /Failed to fetch|Load failed|NetworkError/i.test(msg)) {
    return `${label} 无法连接：可能是网络问题，或该服务不允许手机网页直接调用`;
  }
  return `${label}：${msg}`;
}
