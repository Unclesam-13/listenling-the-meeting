// 资料预处理：添加资料后，让 AI 提前把资料整理成"索引"，开会时直接查索引，更快。
//   每个片段：一句话摘要 + 中英文关键词 + 对方可能问的问题（中英文问法）和简短答案
//   填了 ChatGPT（OpenAI）Key 时，还会生成向量（text-embedding-3-small），支持语义搜索
// 进度保存在资料本身（IndexedDB），中途关掉页面，下次打开会接着整理。
import * as store from "./store.js";
import { split, tokenize } from "./kb.js";

export const CHUNK = 800;

const PROMPT = `你在会议开始前帮用户整理资料，供会议中快速检索和回答。下面是若干资料片段，每段带编号。
为每个片段输出：
- summary：一句话概括（不超过 50 字，用片段的主要语言）
- keywords：10-16 个检索关键词，中文和英文都要有；包括同义词、缩写、专业术语、产品/公司名、关键数字
- qa：2-4 个会议中别人可能会问、而这个片段能回答的问题。每个问题给出中文问法 q、英文问法 q_en、简短答案 a（不超过 60 字，只用片段里的信息，数字和名称必须与原文一致）
片段里没有实质内容（如目录、页眉）时，qa 给空数组。
只输出 JSON 数组，不要任何其他文字：
[{"id": 片段编号, "summary": "", "keywords": [], "qa": [{"q": "", "q_en": "", "a": ""}]}]`;

// ---------------- 匹配度：问题里的"实词"有多少出现在目标里 ----------------
const ZH_STOP = ["有没有", "是不是", "能不能", "为什么", "你们", "我们", "他们", "什么", "怎么", "怎样", "多少", "多久", "多长", "哪里", "哪些", "哪个",
  "是否", "可以", "不能", "请问", "一下", "这个", "那个", "没有", "不是", "的话", "如何", "介绍", "告诉", "知道", "关于", "现在", "目前",
  "情况", "问题", "还有", "就是", "那么", "所以", "一个", "大概", "的", "吗", "呢", "了", "吧", "啊", "呀"];
const EN_STOP = new Set(("what how why when where which who whom whose is are was were the a an do does did you your we our us they their " +
  "can could would will should to of in on for and or it its this that there be been about me tell please any some much many long").split(" "));

// 英文简单词干：store / stored / storage -> stor，price / pricing -> pric
export function stem(w) {
  if (w.length <= 4 || /\d/.test(w)) return w;
  return w.replace(/(ations?|ings?|ments?|ed|es|age|s|e)$/, "") || w;
}

// 目标（资料、索引）里的词：中文单字 + 两字组合，英文按词干
export function targetTokens(text) {
  return tokenize(text).map(t => (/[a-z]/.test(t) ? stem(t) : t));
}

// 问题里的实词：去掉疑问词后，中文按两字组合，英文按词干；expect ≈ 问题里大约有几个词
export function queryTerms(text) {
  const t = (text || "").toLowerCase();
  const en = (t.match(/[a-z0-9][a-z0-9_\-.]*/g) || []).filter(w => !EN_STOP.has(w) && w.length > 1).map(stem);
  const zh = [];
  let expect = en.length;
  for (let run of t.match(/[\u4e00-\u9fff]+/g) || []) {
    for (const w of ZH_STOP) run = run.split(w).join("|");
    for (const sub of run.split("|")) {
      if (sub.length < 2) continue;
      expect += Math.ceil(sub.length / 2);
      for (let i = 0; i + 1 < sub.length; i++) zh.push(sub.slice(i, i + 2));
    }
  }
  return { terms: [...new Set([...en, ...zh])], expect };
}
// 兼容旧名字
export function contentTokens(text) { return queryTerms(text).terms; }

function coverage(q, set) {
  if (!q.terms.length) return 0;
  let n = 0;
  for (const t of q.terms) if (set.has(t)) n++;
  return Math.min(1, n / Math.max(1, q.expect));
}

// ---------------- 向量 ----------------
const EMB_MODEL = "text-embedding-3-small", EMB_DIMS = 512;

function toB64(f32) {
  const u8 = new Uint8Array(f32.buffer);
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromB64(b64) {
  const s = atob(b64), u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return new Float32Array(u8.buffer);
}
function norm(v) {
  let s = 0; for (const x of v) s += x * x;
  s = Math.sqrt(s) || 1;
  return Float32Array.from(v, x => x / s);
}
function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }

async function embed(key, inputs) {
  const out = [];
  for (let i = 0; i < inputs.length; i += 96) {
    const r = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: EMB_MODEL, dimensions: EMB_DIMS, input: inputs.slice(i, i + 96).map(x => x.slice(0, 6000)) }),
    });
    if (!r.ok) {
      let m = ""; try { m = (await r.json()).error?.message || ""; } catch { /* ignore */ }
      throw new Error(`生成向量失败（${r.status}）${m}`);
    }
    const d = await r.json();
    for (const e of d.data.sort((a, b) => a.index - b.index)) out.push(norm(e.embedding));
  }
  return out;
}

// ---------------- 整理（预处理） ----------------
export class Indexer {
  constructor(kb, getRouter, getSettings, onProgress) {
    this.kb = kb;
    this.getRouter = getRouter;
    this.getS = getSettings;
    this.onProgress = onProgress || (() => {});
    this.running = false;
    this.qcache = new Map();
  }

  get busy() { return this.running; }

  // 整理所有还没整理好的资料（可以反复调用，正在运行时不会重复启动）
  async run() {
    if (this.running) { this.again = true; return; }
    const S = this.getS();
    if (S.autoIndex === false) return;
    this.running = true;
    try {
      do {
        this.again = false;
        for (const doc of [...this.kb.docs]) {
          if (!this.kb.docs.includes(doc)) continue; // 中途被删除了
          const st = doc.idx?.status;
          const needVec = !!this.getS().openaiKey && st === "done" && !doc.idx.vec;
          if (st === "done" && !needVec) continue;
          if (st === "error" && !doc.idx.retry) continue;
          await this.processDoc(doc);
        }
      } while (this.again);
    } finally {
      this.running = false;
      this.onProgress(null);
    }
  }

  async processDoc(doc) {
    const router = this.getRouter();
    if (!router.ready) { doc.idx = { ...(doc.idx || {}), status: "waiting" }; this.onProgress(doc); return; }
    const parts = split(doc.text, CHUNK, 100);
    const idx = doc.idx?.status === "running" || doc.idx?.status === "done" ? doc.idx : null;
    doc.idx = idx && idx.total === parts.length ? idx : { status: "running", total: parts.length, chunks: [] };
    doc.idx.status = "running";
    delete doc.idx.error; delete doc.idx.retry;
    this.onProgress(doc);
    try {
      // 1) AI 整理：每次送几段，减少调用次数
      let i = 0;
      while (i < parts.length && doc.idx.chunks[i]) i++; // 接着上次整理到的地方
      while (i < parts.length) {
        const batch = [];
        let size = 0;
        while (i < parts.length && batch.length < 6 && size + parts[i].length <= 5000) { batch.push(i); size += parts[i].length; i++; }
        if (!batch.length) batch.push(i++);
        const res = await this.callLLM(router, doc.name, batch.map(j => [j, parts[j]]));
        for (const j of batch) {
          const r = res.find(x => Number(x.id) === j) || {};
          doc.idx.chunks[j] = {
            summary: String(r.summary || "").slice(0, 200),
            keywords: (Array.isArray(r.keywords) ? r.keywords : []).map(String).slice(0, 24),
            qa: (Array.isArray(r.qa) ? r.qa : []).filter(x => x && x.q && x.a).slice(0, 5)
              .map(x => ({ q: String(x.q), q_en: String(x.q_en || ""), a: String(x.a) })),
          };
        }
        doc.idx.done = doc.idx.chunks.filter(Boolean).length;
        await store.put("docs", doc); // 保存进度：中途关掉也不会白做
        this.onProgress(doc);
      }
      // 2) 向量（可选：需要 OpenAI Key）
      const key = this.getS().openaiKey;
      if (key && !doc.idx.vec) {
        doc.idx.status = "vector";
        this.onProgress(doc);
        try {
          const chunkIn = parts.map((p, j) => `${doc.idx.chunks[j]?.summary || ""}\n${p}`);
          const qaList = doc.idx.chunks.flatMap((c, j) => (c?.qa || []).map((x, k) => [j, k, `${x.q} / ${x.q_en}`]));
          const vecs = await embed(key, [...chunkIn, ...qaList.map(x => x[2])]);
          doc.idx.vec = {
            model: EMB_MODEL, dims: EMB_DIMS,
            chunk: vecs.slice(0, parts.length).map(toB64),
            qa: qaList.map((x, n) => [x[0], x[1], toB64(vecs[parts.length + n])]),
          };
        } catch (e) {
          doc.idx.vecError = e.message; // 向量失败不影响关键词索引
        }
      }
      doc.idx.status = "done";
      doc.idx.at = Date.now();
      doc.idx.model = router.primary.c.fast;
    } catch (e) {
      doc.idx.status = "error";
      doc.idx.error = e.message || String(e);
    }
    await store.put("docs", doc);
    this.kb.build();
    this.onProgress(doc);
  }

  async callLLM(router, name, items) {
    const user = `资料文件：${name}\n\n` + items.map(([j, t]) => `【片段 ${j}】\n${t}`).join("\n\n");
    let last;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const raw = await router.complete([{ text: PROMPT }], user, { maxTokens: 3000, fast: true });
        const m = raw.match(/\[[\s\S]*\]/);
        const arr = JSON.parse(m ? m[0] : raw);
        if (Array.isArray(arr)) return arr;
        throw new Error("返回格式不对");
      } catch (e) { last = e; }
    }
    throw new Error(`AI 整理失败：${last?.message || last}`);
  }

  // 开会时：把问题转成向量（只在资料有向量时用；1.5 秒内没结果就跳过）
  async embedQuery(question) {
    const key = this.getS().openaiKey;
    if (!key || !this.kb.hasVectors) return null;
    if (this.qcache.has(question)) return this.qcache.get(question);
    const p = embed(key, [question]).then(v => v[0]);
    const v = await Promise.race([p, new Promise(r => setTimeout(() => r(null), 1500))]).catch(() => null);
    if (v) this.qcache.set(question, v);
    return v;
  }
}

// ---------------- 查索引 ----------------
// entries: 每个已整理片段 { source, text, summary, keywords, qa, tokens:Set, vec }
export function buildIndex(docs) {
  const entries = [], qas = [];
  for (const d of docs) {
    if (d.idx?.status !== "done") continue;
    const parts = split(d.text, CHUNK, 100);
    const vec = d.idx.vec;
    parts.forEach((text, j) => {
      const c = d.idx.chunks[j];
      if (!c) return;
      const meta = `${c.summary} ${c.keywords.join(" ")} ${c.qa.map(x => x.q + " " + x.q_en).join(" ")}`;
      const e = { source: d.name, text, summary: c.summary, keywords: c.keywords, qa: c.qa,
                  tokens: new Set([...targetTokens(meta), ...targetTokens(text)]), meta: new Set(targetTokens(meta)),
                  vec: vec?.chunk?.[j] ? fromB64(vec.chunk[j]) : null };
      entries.push(e);
      c.qa.forEach((x, k) => {
        const qv = vec?.qa?.find(v => v[0] === j && v[1] === k);
        qas.push({ entry: e, ...x, tokens: new Set(targetTokens(x.q + " " + x.q_en)), vec: qv ? fromB64(qv[2]) : null });
      });
    });
  }
  return { entries, qas };
}

export function searchIndex(ix, query, qvec, k = 5) {
  if (!ix.entries.length) return { confident: false, hits: [], instant: null };
  const qt = queryTerms(query);
  // 1) 预备问答：问题几乎一样时，可以先显示预备答案
  let bestQa = null, bestQaScore = 0;
  for (const x of ix.qas) {
    const cov = coverage(qt, x.tokens);
    const cos = qvec && x.vec ? dot(qvec, x.vec) : 0;
    const s = Math.max(cov, cos >= 0.55 ? 0.6 + (cos - 0.55) : 0);
    if (s > bestQaScore) { bestQaScore = s; bestQa = { ...x, cov, cos }; }
  }
  const qaStrong = bestQa && qt.terms.length >= 2 && (bestQa.cov >= 0.75 || bestQa.cos >= 0.8);
  // 2) 片段：关键词/摘要覆盖度 + 原文覆盖度 + 向量相似度
  const scored = ix.entries.map(e => {
    const covMeta = coverage(qt, e.meta), covAll = coverage(qt, e.tokens);
    const cos = qvec && e.vec ? dot(qvec, e.vec) : 0;
    const s = 0.6 * covMeta + 0.4 * covAll + (cos > 0 ? Math.max(0, cos - 0.2) : 0);
    return { e, s, covMeta, covAll, cos };
  }).sort((a, b) => b.s - a.s);
  const top = scored[0];
  if (qaStrong && scored.length) { // 预备答案所在的片段排第一
    const i = scored.findIndex(x => x.e === bestQa.entry);
    if (i > 0) scored.unshift(scored.splice(i, 1)[0]);
  }
  const confident = !!qaStrong || (qt.terms.length > 0 && (top.covMeta >= 0.5 || top.covAll >= 0.6 || top.cos >= 0.5));
  const hits = scored.filter(x => x.s > 0).slice(0, k).map(x => ({
    source: x.e.source, text: x.e.text, summary: x.e.summary, qa: x.e.qa, score: +x.s.toFixed(3),
  }));
  return {
    confident, hits,
    instant: qaStrong ? { q: bestQa.q, a: bestQa.a, source: bestQa.entry.source } : null,
    debug: { qt, top: top && { covMeta: top.covMeta, covAll: top.covAll, cos: top.cos }, qa: bestQa && { cov: bestQa.cov, cos: bestQa.cos } },
  };
}
