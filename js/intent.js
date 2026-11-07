// 判断对方的一段话是不是在向「我」提问：规则 / 大模型 / Jev
import { netError } from "./util.js";

const ZH_Q = ["吗", "呢", "什么", "怎么", "怎样", "为什么", "为何", "如何", "多少", "几个", "几时", "哪", "是否",
  "能不能", "可不可以", "可以吗", "有没有", "是不是", "会不会", "要不要", "对吧", "请问", "介绍一下",
  "讲一下", "说一下", "解释一下", "能否", "啥", "咋"];
const EN_Q = /\b(what|how|why|when|where|which|who|whom|whose|can you|could you|would you|will you|do you|does|did you|is it|are you|are there|is there|should|any idea|tell me|explain|walk me through|share)\b/i;

export function looksLikeQuestion(text) {
  const t = (text || "").trim().toLowerCase();
  if (!t) return false;
  if (/[?？]$/.test(t)) return true;
  if (ZH_Q.some(w => t.includes(w))) return true;
  return EN_Q.test(t);
}

const LLM_SYSTEM = (speaker) => `你在一场会议中实时辅助「我」。下面是最近的会议转写（可能中英混合，可能有识别错误）。
判断最后一段发言（来自 ${speaker}）是否在提出一个需要「我」回答或回应的问题/请求。
寒暄、反问修辞、自问自答、会议流程性问题（"大家能听到吗"）不算。
只输出 JSON，不要任何其他文字：
{"is_question": true/false, "confidence": 0到1, "question": "把问题改写成完整独立、可直接检索的一句话，保持原语言；不是问题则为空字符串", "topic": "2-6 个字的主题"}`;

const JEV_INTENTS = {
  question: "asks the listener a question that needs an answer (提问)",
  request: "asks the listener to do, provide or confirm something (请求)",
  objection: "raises a concern or objection the listener should respond to (质疑/反对)",
  statement: "states information, no response needed (陈述)",
  small_talk: "greeting, filler, meeting logistics or rhetorical (寒暄/流程)",
};

export class Intent {
  constructor(settings, router) {
    this.s = settings;
    this.router = router;
    this.jevError = "";
    this.jevRemaining = null;
  }

  get mode() {
    const m = this.s.intentProvider;
    if (m === "jev" && this.s.jevKey) return "jev";
    if (m === "rules" || !this.router.ready) return "rules";
    return "llm";
  }

  label() {
    const m = this.mode;
    let t = m === "jev" ? "Jev" : m === "rules" ? "规则" : `${this.router.primary.c.label} · ${this.router.primary.c.fast}`;
    if (this.s.intentProvider === "jev" && m !== "jev") t += "（Jev 未填 Key）";
    if (this.jevError) t += `｜Jev 出错：${this.jevError.slice(0, 30)}`;
    return t;
  }

  async detect(context, speaker, latest) {
    const quick = looksLikeQuestion(latest);
    const mode = this.mode;
    if (mode === "rules") return quick ? { question: latest, by: "规则" } : null;
    if (!quick && latest.length < 12) return null; // 很短又不像问题：省一次调用
    try {
      return mode === "jev" ? await this.jev(context, speaker, latest) : await this.llm(context, speaker, latest);
    } catch (e) {
      console.warn("intent", e);
      return quick ? { question: latest, by: "规则（模型出错）" } : null;
    }
  }

  async llm(context, speaker, latest) {
    const raw = await this.router.complete([{ text: LLM_SYSTEM(speaker) }],
      `${context.slice(-8).join("\n")}\n\n最后一段（${speaker}）：${latest}`, { maxTokens: 200, fast: true });
    const d = JSON.parse(raw.match(/\{[\s\S]*\}/)[0]);
    return d.is_question && d.question ? { question: d.question.trim(), by: "大模型", confidence: d.confidence } : null;
  }

  // Jev：POST /v1/systemone，noul（是/否概率）+ choice（发言类型）
  async jev(context, speaker, latest) {
    const body = {
      model: this.s.jevModel || "jev-latest",
      state: {
        recent_conversation: context.slice(-8),
        latest_utterance: { speaker, text: latest },
        listener: "我 (me) — the person being assisted in this meeting",
      },
      questions: {
        is_question: {
          type: "noul",
          instructions: "Does the latest utterance ask the listener a question, or make a request or objection the listener is expected to answer or respond to right now? The text may mix Chinese and English and may contain speech-recognition errors.",
          criteria: { true: "a question or request directed at the listener", false: "statement, greeting, meeting logistics, rhetorical or self-answered question" },
        },
        intent: { type: "choice", instructions: "What is the latest utterance doing?", criteria: JEV_INTENTS },
      },
    };
    const headers = { Authorization: `Bearer ${this.s.jevKey}`, "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID?.() || String(Date.now()) };
    let r;
    for (let attempt = 0; attempt < 2; attempt++) {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 4000);
      try {
        r = await fetch(this.s.jevUrl || "https://jevmodel.org/v1/systemone", { method: "POST", headers, body: JSON.stringify(body), signal: ctl.signal });
      } catch (e) {
        this.jevError = netError(e, "Jev").replace(/^Jev /, "");
        throw e;
      } finally { clearTimeout(t); }
      if ((r.status === 429 || r.status === 502) && attempt === 0) { await new Promise(res => setTimeout(res, 400)); continue; }
      break;
    }
    if (!r.ok) {
      let msg = ""; try { const j = await r.json(); msg = j.error?.message || ""; } catch { /* ignore */ }
      this.jevError = `${r.status} ${({ 401: "Key 无效", 402: "余额不足", 422: "请求格式有误", 429: "调用太频繁" })[r.status] || ""} ${msg}`.trim();
      throw new Error(this.jevError);
    }
    this.jevError = "";
    this.jevRemaining = r.headers.get("X-Tokens-Remaining") || this.jevRemaining;
    const d = await r.json();
    const p = d.answers?.is_question || {};
    const prob = Number(p.noul ?? p.value ?? 0);
    const kind = d.answers?.intent?.choice || "";
    if (prob >= Number(this.s.jevThreshold || 0.6) && !["statement", "small_talk"].includes(kind)) {
      return { question: latest, by: "Jev", confidence: prob };
    }
    return null;
  }
}
