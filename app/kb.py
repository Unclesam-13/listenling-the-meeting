"""资料库：读取文件 -> 切块 -> 向量 + 关键词混合检索。

支持 .md .txt .pdf .docx。向量模型默认 BAAI/bge-m3（多语言，中文问题能搜到英文资料）。
向量模型加载失败时自动退化为纯关键词检索（BM25），保证仍可用。
"""
from __future__ import annotations

import hashlib
import logging
import re
from dataclasses import dataclass
from pathlib import Path

import numpy as np

log = logging.getLogger("kb")

EXTS = {".md", ".txt", ".pdf", ".docx"}


@dataclass
class Chunk:
    source: str
    text: str
    page: int | None = None


def read_file(p: Path) -> list[tuple[str, int | None]]:
    """返回 [(文本, 页码)]"""
    ext = p.suffix.lower()
    if ext in (".md", ".txt"):
        return [(p.read_text(encoding="utf-8", errors="ignore"), None)]
    if ext == ".pdf":
        from pypdf import PdfReader
        return [(pg.extract_text() or "", i + 1) for i, pg in enumerate(PdfReader(str(p)).pages)]
    if ext == ".docx":
        import docx
        d = docx.Document(str(p))
        parts = [para.text for para in d.paragraphs]
        for t in d.tables:
            for row in t.rows:
                parts.append(" | ".join(c.text.strip() for c in row.cells))
        return [("\n".join(parts), None)]
    return []


def split_text(text: str, size: int, overlap: int) -> list[str]:
    """先按标题分节（Markdown # 标题），每节内再按段落拼块；每块带上所属标题，检索更准。"""
    sections, head, body = [], "", []
    for line in text.splitlines():
        if re.match(r"^#{1,6}\s+\S", line):
            if "\n".join(body).strip():
                sections.append((head, "\n".join(body)))
            head, body = line.lstrip("#").strip(), []
        else:
            body.append(line)
    if "\n".join(body).strip():
        sections.append((head, "\n".join(body)))
    out = []
    for head, body in sections:
        for c in _pack(body, size, overlap):
            out.append(f"{head}\n{c}" if head else c)
    return out


def _pack(text: str, size: int, overlap: int) -> list[str]:
    paras = [x.strip() for x in re.split(r"\n\s*\n", text) if x.strip()]
    chunks, cur = [], ""
    for para in paras:
        while len(para) > size:  # 超长段落硬切
            if cur:
                chunks.append(cur); cur = ""
            chunks.append(para[:size]); para = para[size - overlap:]
        if len(cur) + len(para) + 1 <= size:
            cur = f"{cur}\n{para}" if cur else para
        else:
            if cur:
                chunks.append(cur)
            tail = cur[-overlap:] if overlap and cur else ""
            cur = f"{tail}\n{para}" if tail else para
    if cur:
        chunks.append(cur)
    return chunks


_jieba = None


def tokenize(text: str) -> list[str]:
    """中英混合分词：英文按单词，中文用 jieba。"""
    global _jieba
    text = text.lower()
    toks = re.findall(r"[a-z0-9][a-z0-9_\-\.]*", text)
    zh = "".join(re.findall(r"[一-鿿]+", text))
    if zh:
        if _jieba is None:
            import jieba
            jieba.setLogLevel(logging.WARNING)
            _jieba = jieba
        toks += [w for w in _jieba.cut_for_search(zh) if w.strip()]
    return toks


class KnowledgeBase:
    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.dir = Path(cfg["dir"])
        self.cache_dir = self.dir.parent / ".cache"
        self.chunks: list[Chunk] = []
        self.emb: np.ndarray | None = None
        self.bm25 = None
        self.embedder = None
        self.embed_error: str | None = None

    # ---------- 构建 ----------
    def _load_embedder(self):
        if self.embedder is not None or self.embed_error:
            return
        try:
            from sentence_transformers import SentenceTransformer
            self.embedder = SentenceTransformer(self.cfg.get("embed_model", "BAAI/bge-m3"))
            log.info("向量模型已加载：%s", self.cfg.get("embed_model"))
        except Exception as e:
            self.embed_error = str(e)
            log.warning("向量模型不可用（%s），只用关键词检索", e)

    def build(self) -> dict:
        self.dir.mkdir(parents=True, exist_ok=True)
        files = sorted(p for p in self.dir.rglob("*") if p.suffix.lower() in EXTS and not p.name.startswith("."))
        size, ov = self.cfg.get("chunk_chars", 500), self.cfg.get("chunk_overlap", 100)
        chunks: list[Chunk] = []
        for f in files:
            try:
                for text, page in read_file(f):
                    for c in split_text(text, size, ov):
                        chunks.append(Chunk(str(f.relative_to(self.dir)), c, page))
            except Exception as e:
                log.warning("读取失败 %s: %s", f.name, e)
        self.chunks = chunks

        from rank_bm25 import BM25Okapi
        self.bm25 = BM25Okapi([tokenize(c.text) for c in chunks]) if chunks else None

        self.emb = None
        self._load_embedder()
        if self.embedder is not None and chunks:
            self.emb = self._embed_with_cache([c.text for c in chunks])
        log.info("资料库：%d 个文件，%d 个片段", len(files), len(chunks))
        return {"files": len(files), "chunks": len(chunks), "vector": self.emb is not None}

    def _embed_with_cache(self, texts: list[str]) -> np.ndarray:
        self.cache_dir.mkdir(exist_ok=True)
        key = hashlib.sha1((self.cfg.get("embed_model", "") + "\x00".join(texts)).encode()).hexdigest()[:16]
        f = self.cache_dir / f"emb_{key}.npy"
        if f.exists():
            return np.load(f)
        emb = self.embedder.encode(texts, batch_size=16, normalize_embeddings=True, show_progress_bar=len(texts) > 50)
        emb = np.asarray(emb, dtype=np.float32)
        for old in self.cache_dir.glob("emb_*.npy"):
            old.unlink()
        np.save(f, emb)
        return emb

    # ---------- 检索 ----------
    def search(self, query: str, k: int | None = None) -> list[dict]:
        k = k or self.cfg.get("top_k", 5)
        if not self.chunks:
            return []
        rankings = []
        if self.bm25 is not None:
            s = self.bm25.get_scores(tokenize(query))
            order = [i for i in np.argsort(-s) if s[i] > 0][: k * 4]
            rankings.append(order)
        if self.emb is not None:
            q = self.embedder.encode([query], normalize_embeddings=True)[0]
            sims = self.emb @ q
            rankings.append(list(np.argsort(-sims)[: k * 4]))
        # Reciprocal Rank Fusion 融合两种排序
        fused: dict[int, float] = {}
        for r in rankings:
            for rank, i in enumerate(r):
                fused[int(i)] = fused.get(int(i), 0.0) + 1.0 / (60 + rank)
        top = sorted(fused, key=fused.get, reverse=True)[:k]
        return [{"source": self.chunks[i].source, "page": self.chunks[i].page,
                 "text": self.chunks[i].text, "score": round(fused[i], 4)} for i in top]

    def stats(self) -> dict:
        return {"chunks": len(self.chunks), "files": len({c.source for c in self.chunks}),
                "vector": self.emb is not None, "dir": str(self.dir)}
