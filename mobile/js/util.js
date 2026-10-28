// 通用小工具：转义、Markdown 渲染、时间格式、提示
export const $ = (id) => document.getElementById(id);

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// 回答和总结里会出现的 Markdown：标题、列表、待办、加粗、来源行
export function md(text) {
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
