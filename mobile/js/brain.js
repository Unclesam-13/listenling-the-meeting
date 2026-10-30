// 根据资料生成回答 + 会议总结
import { FULL_MAX_CHARS } from "./kb.js";
import { dateLabel, dur, hhmm } from "./util.js";

const ANSWER_SYSTEM = `你是会议中的实时提词助手。对方刚问了一个问题，「我」需要在几秒内看一眼手机就能回答。
根据【资料】回答，格式严格如下（Markdown）：
**结论**：一句话直接回答（不超过 40 字）
- 要点 1
- 要点 2
- 要点 3（最多 4 条，每条简短，可直接念出来）
来源：[文件名]

规则：
- 用提问者使用的语言回答（中文问题用中文，英文问题用英文，混合则以主要语言为准，专业术语保留英文）。
- 只使用资料中的信息；关键数字、名称必须与资料一致。
- 资料里没有答案时，第一行写「**资料中未找到**」，然后给出 1-2 条稳妥的通用回应思路，并标注（非资料内容）。
- 不要寒暄，不要重复问题。
- 数学公式用 LaTeX：行内写成 $...$，单独一行写成 $$...$$；需要对比多项数据时可以用 Markdown 表格。`;

export function useFull(router, kb) {
  return router.ready && kb.docs.length > 0 && kb.totalChars <= FULL_MAX_CHARS;
}

// 查找顺序：① AI 整理好的索引（本机，几乎不花时间）→ ② 找不到再查原文
// 返回 { hits, full, via: "index" | "fulltext" | "full", instant }
export async function retrieve(router, kb, question, indexer, { skipIndex = false } = {}) {
  if (kb.indexedCount && !skipIndex) {
    const qvec = indexer ? await indexer.embedQuery(question) : null;
    const r = kb.searchIndexed(question, qvec);
    if (r.confident) return { hits: r.hits, full: false, via: "index", instant: r.instant };
  }
  if (useFull(router, kb)) return { hits: null, full: true, via: "full" };
  let keywords = [];
  if (router.ready && kb.chunks.length) {
    try {
      const raw = await router.complete([], "为下面的问题生成 6-10 个用于在资料库中做关键词检索的词，中文和英文都要有，" +
        `包括同义词和专业术语。只输出词，用逗号分隔。\n问题：${question}`, { maxTokens: 120, fast: true });
      keywords = raw.split(/[,，、\n]/).map(x => x.trim()).filter(Boolean).slice(0, 12);
    } catch (e) { console.warn("expand", e); }
  }
  return { hits: kb.search(question, keywords), full: false, via: "fulltext" };
}

export async function* answer(router, kb, question, context, { hits, full }) {
  if (!router.ready) {
    if (!hits?.length) { yield "**资料中未找到**相关内容。（未设置大模型 Key，只能做关键词检索）"; return; }
    yield "**相关资料**（未设置大模型 Key，直接显示检索结果）\n";
    for (const h of hits.slice(0, 3)) {
      const s = h.text.replace(/\n/g, " ");
      yield `\n- ${s.slice(0, 160)}${s.length > 160 ? "…" : ""}  \n  来源：[${h.source}]`;
    }
    return;
  }
  const system = [{ text: ANSWER_SYSTEM }];
  let refs;
  if (full) {
    system.push({ text: "【资料】\n" + kb.fullText(), cache: true });
    refs = "（见系统提示中的【资料】）";
  } else {
    refs = (hits || []).map((h, i) => {
      let t = `[${i + 1}] 文件：${h.source}`;
      if (h.summary) t += `\n摘要：${h.summary}`;
      t += `\n原文：${h.text}`;
      if (h.qa?.length) t += `\n整理时预备的问答：\n` + h.qa.map(x => `- 问：${x.q}　答：${x.a}`).join("\n");
      return t;
    }).join("\n\n") || "（资料库中没有检索到相关内容）";
  }
  const user = `【最近对话】\n${context.slice(-6).join("\n")}\n\n【问题】${question}\n\n【资料】\n${refs}`;
  yield* router.stream(system, user, { maxTokens: 600 });
}

// ---------------- 会议总结 ----------------
const LANG = {
  zh: "用中文写（专业术语、人名、产品名保留原文）。",
  en: "Write in English (keep names and product terms as spoken).",
  both: "先写完整的中文版，再写完整的英文版（English version），两版内容一致。",
};

function summarySystem(lang) {
  return `你是专业的会议纪要助手。根据会议转写（可能中英混合、有识别错误、说话人可能被标成"说话人1/2"）写会议纪要。
${LANG[lang] || LANG.zh}
格式（Markdown），没有内容的部分写"无"：
## 会议摘要
3-5 句话概括会议目的、主要讨论和结果。
## 关键结论与决定
- 每条一句，写清楚决定了什么
## 待办事项
- [ ] 事项 —— 负责人（如能判断）· 截止时间（如提到）
## 对方提出的问题
- 问题 → 当时的回答要点（如有）
## 待跟进 / 未解决
- 还没有结论、需要后续确认的事项
规则：只根据转写内容，不要编造；数字、日期、名称与原文一致；识别错误明显时按上下文合理修正。
数学公式用 LaTeX（行内 $...$，单独一行 $$...$$）；多项数据对比可以用 Markdown 表格。`;
}

export function transcriptText(m, withTrans = false) {
  return m.lines.map(l => {
    const name = m.names[l.sid] || l.sid;
    return `[${hhmm(l.ts)}] ${name}: ${l.text}` + (withTrans && l.trans ? `\n    （译）${l.trans}` : "");
  }).join("\n");
}

export async function* summarize(router, m, lang) {
  const head = `会议：${m.title}\n时间：${dateLabel(m.startedAt)}，时长约 ${dur(m.totalSec || 0)}\n` +
    (m.answers.length ? `会议中识别到的提问：\n${m.answers.map(a => "- " + a.question).join("\n")}\n` : "");
  let text = transcriptText(m);
  const LIMIT = 60000;
  if (text.length > LIMIT) {
    // 会议很长：先分段整理要点，再合成纪要
    const parts = [];
    for (let i = 0; i < text.length; i += LIMIT) parts.push(text.slice(i, i + LIMIT));
    const notes = [];
    for (let i = 0; i < parts.length; i++) {
      yield { progress: `正在整理第 ${i + 1}/${parts.length} 段…` };
      notes.push(await router.complete([{ text: "把这段会议转写整理成详细要点（谁说了什么、数字、决定、待办、问题），用转写的主要语言。" }],
        parts[i], { maxTokens: 1500, fast: false }));
    }
    text = notes.map((n, i) => `【第 ${i + 1} 段要点】\n${n}`).join("\n\n");
  }
  for await (const t of router.stream([{ text: summarySystem(lang) }], `${head}\n【会议转写】\n${text}`, { maxTokens: 2000 })) {
    yield { text: t };
  }
}
