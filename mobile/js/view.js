// 回答卡片和字幕行的 HTML：会议助手页面和"手机查看电脑会议"页面共用。
import { esc, md, hhmm, colorOf } from "./util.js";

const VIA = { index: "⚡ 资料索引", fulltext: "原文检索", full: "全部资料" };
export function viaLabel(a) { return a.via ? VIA[a.via] || "" : ""; }

export function bodyHTML(a) {
  if (!a.text && a.pre) {
    return `<div class="pre"><div class="pre-h">⚡ 资料里预备的答案（完整回答生成中…）</div>${md(a.pre.a)}<p class="src">来源：[${esc(a.pre.source)}]</p></div>`;
  }
  return md(a.text);
}

export function answerHTML(a, latest) {
  const tag = a.origin === "manual" ? `<span class="tag manual">${esc(a.asker && a.asker !== "手动提问" ? a.asker : "手动提问")}</span>` : `<span class="tag">${esc(a.asker || "对方")}</span>`;
  return `<div class="card ${latest ? "latest" : ""} ${a.done ? "" : "streaming"}" id="a-${a.id}">
    <div class="q">${tag}<b>${esc(a.question)}</b> <span style="color:var(--faint)">· ${hhmm(a.ts)}</span><span class="via" id="via-${a.id}">${viaLabel(a)}</span></div>
    <div class="body">${bodyHTML(a)}</div></div>`;
}

// who: { name(sid), me(sid) }
export function lineHTML(l, who) {
  const me = who.me(l.sid), name = who.name(l.sid);
  return `<div class="line ${me ? "me" : ""}" id="${l.id}">
    <div class="h"><button class="who" data-sid="${l.sid}" style="color:${colorOf(l.sid, me)}">${esc(name)}${me && name !== "我" ? "（我）" : ""}</button><span class="time">${hhmm(l.ts)}</span></div>
    <div class="tx">${esc(l.text)}</div>${l.trans ? `<div class="tr">${esc(l.trans)}</div>` : ""}</div>`;
}

export function liveHTML(live, who) {
  return Object.values(live || {}).filter(v => v?.text).map((v) => {
    const sid = v.sid || "spk1";
    return `<div class="line live"><div class="h"><span class="who" style="color:${colorOf(sid, who.me(sid))}">${esc(who.name(sid))}</span></div>
    <div class="tx">${esc(v.text)}</div>${v.trans ? `<div class="tr">${esc(v.trans)}</div>` : ""}</div>`;
  }).join("");
}
