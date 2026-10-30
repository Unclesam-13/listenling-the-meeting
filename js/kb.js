// 资料库（存在手机本机）：读取 .md .txt .pdf .docx -> 切块 -> 检索
// 资料不多时（默认 15 万字以内）整体交给大模型，最准确；资料多时用关键词检索（BM25），
// 并让大模型先把问题扩展成中英文关键词，中文问题也能搜到英文资料。
import * as store from "./store.js";
import { uid } from "./util.js";
import { buildIndex, searchIndex } from "./indexer.js";

export const FULL_MAX_CHARS = 150000;

// PDF / Word 解析库：发布时由 GitHub 打包到 vendor/；万一没有就从公共 CDN 加载
const LIBS = {
  pdf: { local: "vendor/pdf.min.js", cdn: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",
         worker: ["vendor/pdf.worker.min.js", "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js"] },
  docx: { local: "vendor/mammoth.browser.min.js", cdn: "https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js" },
};

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error("加载失败：" + src));
    document.head.appendChild(s);
  });
}

async function loadLib(kind) {
  const lib = LIBS[kind];
  const ok = () => (kind === "pdf" ? window.pdfjsLib : window.mammoth);
  if (ok()) return ok();
  try { await loadScript(lib.local); } catch { await loadScript(lib.cdn); }
  if (kind === "pdf") {
    const local = await fetch(lib.worker[0], { method: "HEAD" }).then(r => r.ok).catch(() => false);
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = local ? lib.worker[0] : lib.worker[1];
  }
  return ok();
}

export async function readFile(file) {
  const name = file.name || "未命名";
  let ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
  // 有些手机给的文件没有扩展名，按文件类型判断
  if (!ext) ext = { "application/pdf": "pdf", "text/plain": "txt", "text/markdown": "md",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx" }[file.type] || "";
  if (["doc", "wps", "pages"].includes(ext)) throw new Error(`${name}：暂不支持这种格式，请在 Word / WPS 里"另存为 .docx"或导出 PDF 后再添加`);
  if (["jpg", "jpeg", "png", "heic", "gif", "webp"].includes(ext) || file.type.startsWith("image/")) throw new Error(`${name}：这是图片，读不出文字。请添加 PDF、Word 或文本文件，或者用下面的"粘贴文字"`);
  if (["md", "txt", "markdown", "csv", "text"].includes(ext) || file.type.startsWith("text/")) return await file.text();
  if (ext === "pdf") {
    const pdfjs = await loadLib("pdf");
    const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      let line = "", out = [];
      let lastY = null;
      for (const it of tc.items) {
        const y = it.transform?.[5];
        if (lastY !== null && Math.abs(y - lastY) > 2) { out.push(line); line = ""; }
        line += it.str;
        lastY = y;
        if (it.hasEOL) { out.push(line); line = ""; lastY = null; }
      }
      if (line) out.push(line);
      const text = out.join("\n").trim();
      if (text) pages.push(`[第${i}页]\n${text}`);
    }
    return pages.join("\n\n");
  }
  if (ext === "docx") {
    const mammoth = await loadLib("docx");
    // 转成 Markdown 风格的纯文本，保留标题层级，切块时更准
    const r = await mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() });
    const div = document.createElement("div");
    div.innerHTML = r.value;
    const parts = [];
    for (const el of div.children) {
      const t = el.textContent.trim();
      if (!t) continue;
      const m = el.tagName.match(/^H(\d)$/);
      if (m) parts.push("#".repeat(+m[1]) + " " + t);
      else if (el.tagName === "TABLE") parts.push([...el.querySelectorAll("tr")].map(tr => [...tr.children].map(td => td.textContent.trim()).join(" | ")).join("\n"));
      else if (el.tagName === "UL" || el.tagName === "OL") parts.push([...el.querySelectorAll("li")].map(li => "- " + li.textContent.trim()).join("\n"));
      else parts.push(t);
    }
    return parts.join("\n\n");
  }
  throw new Error(`${name}：不支持这种文件${ext ? `（.${ext}）` : ""}，请添加 PDF、Word(.docx)、Markdown 或 TXT`);
}

// ---------------- 切块 ----------------
export function split(text, size = 500, overlap = 100) {
  const sections = [];
  let head = "", body = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^#{1,6}\s+(\S.*)/);
    if (m) {
      if (body.join("\n").trim()) sections.push([head, body.join("\n")]);
      head = m[1].trim(); body = [];
    } else body.push(line);
  }
  if (body.join("\n").trim()) sections.push([head, body.join("\n")]);
  const out = [];
  for (const [h, b] of sections) {
    const paras = b.split(/\n\s*\n/).map(x => x.trim()).filter(Boolean);
    let cur = "";
    const push = (c) => out.push(h ? `${h}\n${c}` : c);
    for (let p of paras) {
      while (p.length > size) {
        if (cur) { push(cur); cur = ""; }
        push(p.slice(0, size)); p = p.slice(size - overlap);
      }
      if (cur.length + p.length + 1 <= size) cur = cur ? cur + "\n" + p : p;
      else { if (cur) push(cur); const tail = overlap && cur ? cur.slice(-overlap) : ""; cur = tail ? tail + "\n" + p : p; }
    }
    if (cur) push(cur);
  }
  return out;
}

// 中英混合分词：英文按单词，中文按单字 + 相邻两字
export function tokenize(text) {
  const t = (text || "").toLowerCase();
  const out = t.match(/[a-z0-9][a-z0-9_\-.]*/g) || [];
  for (const run of t.match(/[一-鿿]+/g) || []) {
    for (let i = 0; i < run.length; i++) {
      out.push(run[i]);
      if (i + 1 < run.length) out.push(run.slice(i, i + 2));
    }
  }
  return out;
}

export class KnowledgeBase {
  constructor() {
    this.docs = [];
    this.chunks = [];
    this.index = null;
    this.ix = { entries: [], qas: [] };
  }

  get indexedCount() { return this.docs.filter(d => d.idx?.status === "done").length; }
  get hasVectors() { return this.docs.some(d => d.idx?.vec); }
  get qaCount() { return this.ix.qas.length; }
  searchIndexed(query, qvec) { return searchIndex(this.ix, query, qvec); }

  get totalChars() { return this.docs.reduce((n, d) => n + d.text.length, 0); }

  async load() {
    this.docs = (await store.getAll("docs")).sort((a, b) => a.addedAt - b.addedAt);
    this.build();
  }

  async addText(name, text) {
    text = (text || "").trim();
    if (!text) throw new Error("内容是空的");
    const doc = { id: uid(), name: name || "粘贴的资料", text, size: text.length, addedAt: Date.now(), idx: { status: "pending" } };
    await store.put("docs", doc);
    this.docs.push(doc);
    this.build();
    return doc;
  }

  async add(file) {
    const text = (await readFile(file)).trim();
    if (!text) throw new Error(`${file.name}：没有读到文字（可能是扫描版 PDF）`);
    const doc = { id: uid(), name: file.name, text, size: file.size, addedAt: Date.now(), idx: { status: "pending" } };
    await store.put("docs", doc);
    this.docs.push(doc);
    this.build();
    return doc;
  }

  async remove(id) {
    await store.del("docs", id);
    this.docs = this.docs.filter(d => d.id !== id);
    this.build();
  }

  build() {
    this.chunks = [];
    for (const d of this.docs) for (const c of split(d.text)) this.chunks.push({ source: d.name, text: c });
    // BM25 索引
    const N = this.chunks.length;
    const tf = this.chunks.map(c => { const m = new Map(); for (const w of tokenize(c.text)) m.set(w, (m.get(w) || 0) + 1); return m; });
    const df = new Map();
    for (const m of tf) for (const w of m.keys()) df.set(w, (df.get(w) || 0) + 1);
    const lens = tf.map(m => [...m.values()].reduce((a, b) => a + b, 0));
    const avg = lens.reduce((a, b) => a + b, 0) / (N || 1);
    this.index = { N, tf, df, lens, avg };
    this.ix = buildIndex(this.docs); // AI 整理好的索引
  }

  fullText() {
    return this.docs.map(d => `<document name="${d.name}">\n${d.text}\n</document>`).join("\n\n");
  }

  search(query, keywords = [], k = 6) {
    if (!this.chunks.length) return [];
    const { N, tf, df, lens, avg } = this.index;
    const q = [...new Set([...tokenize(query), ...keywords.flatMap(tokenize)])];
    const k1 = 1.5, b = 0.75;
    const scores = tf.map((m, i) => {
      let s = 0;
      for (const w of q) {
        const f = m.get(w);
        if (!f) continue;
        const idf = Math.log(1 + (N - df.get(w) + 0.5) / (df.get(w) + 0.5));
        s += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * lens[i] / avg));
      }
      return s;
    });
    return scores.map((s, i) => [s, i]).filter(x => x[0] > 0).sort((a, b) => b[0] - a[0]).slice(0, k)
      .map(([s, i]) => ({ ...this.chunks[i], score: +s.toFixed(3) }));
  }
}
