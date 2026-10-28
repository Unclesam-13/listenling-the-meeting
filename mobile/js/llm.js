// 大模型调用（浏览器直连）：Claude / ChatGPT（OpenAI）/ DeepSeek。
// system: [{ text, cache }]；Claude 会对 cache=true 的段落启用提示词缓存，OpenAI/DeepSeek 自动缓存相同开头。
// 选中的模型出错时，自动换用下一个已填 Key 的模型。
import { netError } from "./util.js";

export const PROVIDERS = {
  claude: { label: "Claude" },
  openai: { label: "ChatGPT", base: "https://api.openai.com/v1", maxParam: "max_completion_tokens" },
  deepseek: { label: "DeepSeek", base: "https://api.deepseek.com", maxParam: "max_tokens", extra: { thinking: { type: "disabled" } } },
};

function conf(s, name) {
  if (name === "claude") return { name, label: "Claude", key: s.claudeKey, answer: s.claudeModel, fast: s.claudeFast || s.claudeModel };
  if (name === "openai") return { name, label: "ChatGPT", key: s.openaiKey, answer: s.openaiModel, fast: s.openaiModel, ...PROVIDERS.openai };
  if (name === "deepseek") return { name, label: "DeepSeek", key: s.deepseekKey, answer: s.deepseekModel, fast: s.deepseekModel, ...PROVIDERS.deepseek };
}

// 读取 SSE（服务器推送事件）流，逐个返回 data 行
async function* sse(resp) {
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
      if (line.startsWith("data:")) yield line.slice(5).trim();
    }
  }
  if (buf.startsWith("data:")) yield buf.slice(5).trim();
}

async function httpError(r, label) {
  let msg = "";
  try { const j = await r.json(); msg = j.error?.message || j.message || JSON.stringify(j).slice(0, 200); } catch { msg = r.statusText; }
  const hint = { 401: "Key 无效", 402: "余额不足", 403: "没有权限", 404: "模型名称不存在", 429: "调用太频繁或额度用完" }[r.status] || "";
  return new Error(`${label} 出错（${r.status}${hint ? " " + hint : ""}）：${msg}`);
}

class Claude {
  constructor(c) { this.c = c; }
  headers() {
    return {
      "x-api-key": this.c.key, "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true", "content-type": "application/json",
    };
  }
  body(system, user, maxTokens, fast, stream) {
    return JSON.stringify({
      model: fast ? this.c.fast : this.c.answer, max_tokens: maxTokens, stream,
      system: system.filter(x => x.text).map(x => x.cache ? { type: "text", text: x.text, cache_control: { type: "ephemeral" } } : { type: "text", text: x.text }),
      messages: [{ role: "user", content: user }],
    });
  }
  async complete(system, user, maxTokens, fast) {
    const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: this.headers(), body: this.body(system, user, maxTokens, fast, false) });
    if (!r.ok) throw await httpError(r, "Claude");
    const d = await r.json();
    return (d.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  }
  async *stream(system, user, maxTokens) {
    const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: this.headers(), body: this.body(system, user, maxTokens, false, true) });
    if (!r.ok) throw await httpError(r, "Claude");
    for await (const data of sse(r)) {
      let ev; try { ev = JSON.parse(data); } catch { continue; }
      if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") yield ev.delta.text;
      else if (ev.type === "error") throw new Error(`Claude 出错：${ev.error?.message || "未知错误"}`);
    }
  }
}

class OpenAICompat {
  constructor(c) { this.c = c; }
  req(system, user, maxTokens, fast, stream) {
    const sys = system.filter(x => x.text).map(x => x.text).join("\n\n");
    const body = {
      model: fast ? this.c.fast : this.c.answer,
      messages: [...(sys ? [{ role: "system", content: sys }] : []), { role: "user", content: user }],
      [this.c.maxParam]: maxTokens, stream, ...(this.c.extra || {}),
    };
    return { method: "POST", headers: { Authorization: `Bearer ${this.c.key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) };
  }
  async complete(system, user, maxTokens, fast) {
    const r = await fetch(this.c.base + "/chat/completions", this.req(system, user, maxTokens, fast, false));
    if (!r.ok) throw await httpError(r, this.c.label);
    const d = await r.json();
    return d.choices?.[0]?.message?.content || "";
  }
  async *stream(system, user, maxTokens) {
    const r = await fetch(this.c.base + "/chat/completions", this.req(system, user, maxTokens, false, true));
    if (!r.ok) throw await httpError(r, this.c.label);
    for await (const data of sse(r)) {
      if (data === "[DONE]") break;
      let ev; try { ev = JSON.parse(data); } catch { continue; }
      const t = ev.choices?.[0]?.delta?.content;
      if (t) yield t;
    }
  }
}

export class Router {
  constructor(s) {
    this.s = s;
    this.clients = {};
    for (const n of Object.keys(PROVIDERS)) {
      const c = conf(s, n);
      if (c.key) this.clients[n] = n === "claude" ? new Claude(c) : new OpenAICompat(c);
    }
    const want = s.answerProvider || "claude";
    const ready = Object.keys(this.clients);
    this.order = [...(ready.includes(want) ? [want] : []), ...ready.filter(n => n !== want)];
    this.wanted = want;
  }
  get ready() { return this.order.length > 0; }
  get primary() { return this.order[0] ? this.clients[this.order[0]] : null; }

  label() {
    if (!this.ready) return "未设置大模型 Key";
    const p = this.primary.c;
    const note = p.name === this.wanted ? "" : `（${PROVIDERS[this.wanted]?.label} 未填 Key，已改用）`;
    return `${p.label} · ${p.answer}${note}`;
  }

  async complete(system, user, { maxTokens = 300, fast = true } = {}) {
    let last;
    for (const n of this.order) {
      try { return await this.clients[n].complete(system, user, maxTokens, fast); } catch (e) { last = e; console.warn(n, e); }
    }
    throw new Error(netError(last, PROVIDERS[this.order.at(-1)]?.label || "大模型"));
  }

  async *stream(system, user, { maxTokens = 600 } = {}) {
    const errors = [];
    for (let i = 0; i < this.order.length; i++) {
      const n = this.order[i];
      let got = false;
      try {
        if (i > 0) yield `（${PROVIDERS[this.order[i - 1]].label} 暂时不可用，已改用 ${PROVIDERS[n].label}）\n\n`;
        for await (const t of this.clients[n].stream(system, user, maxTokens)) { got = true; yield t; }
        return;
      } catch (e) {
        console.warn(n, e);
        errors.push(netError(e, PROVIDERS[n].label));
        if (got) { yield `\n\n（生成中断：${e.message}）`; return; }
      }
    }
    yield errors.length ? "（生成失败：" + errors.join("；") + "）" : "（没有可用的大模型，请在设置里填写 API Key）";
  }
}
