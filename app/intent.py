"""意图识别：判断对方的一段话是不是在向「我」提问。

可在 config.yaml 的 intent.provider 或页面「设置」里切换：
  llm      用大模型（默认；用 llm.fast_provider 指定的 Claude / ChatGPT / DeepSeek，会顺便把问题改写完整）
  jev      用 Jev 决策模型（返回"是问题"的概率，速度快、便宜）
  compare  以大模型的结果为准，同时调用 Jev，把两者的结果和耗时记到 logs/intent_compare.jsonl，方便对比
  rules    只用规则（离线、最快、最不准）
（旧配置里的 claude 等同于 llm）

所有 Detector 都实现同一个接口：
    async def detect(context: list[str], speaker: str, latest: str) -> dict | None
返回 None 表示不是问题；否则返回 {"question": str, "topic": str, "confidence": float, "provider": str}
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
from pathlib import Path

log = logging.getLogger("intent")

ZH_Q = ["吗", "呢", "什么", "怎么", "怎样", "为什么", "为何", "如何", "多少", "几个", "几时", "哪", "是否",
        "能不能", "可不可以", "可以吗", "有没有", "是不是", "会不会", "要不要", "对吧", "请问", "介绍一下",
        "讲一下", "说一下", "解释一下", "能否", "啥", "咋"]
EN_Q = (r"\b(what|how|why|when|where|which|who|whom|whose|can you|could you|would you|will you|do you|does|"
        r"did you|is it|are you|are there|is there|should|any idea|tell me|explain|walk me through|share)\b")


def looks_like_question(text: str) -> bool:
    t = text.strip().lower()
    if not t:
        return False
    if t.endswith(("?", "？")):
        return True
    if any(w in t for w in ZH_Q):
        return True
    return re.search(EN_Q, t) is not None


def _hit(question: str, provider: str, confidence: float = 1.0, topic: str = "") -> dict:
    return {"question": question, "topic": topic, "confidence": confidence, "provider": provider}


# ---------------------------------------------------------------- 规则
class RulesDetector:
    name = "rules"

    async def detect(self, context, speaker, latest):
        return _hit(latest, self.name, 0.5) if looks_like_question(latest) else None


# ---------------------------------------------------------------- 大模型
LLM_SYSTEM = """你在一场会议中实时辅助「我」。下面是最近的会议转写（可能中英混合，可能有识别错误）。
判断最后一段发言（来自 {speaker}）是否在提出一个需要「我」回答或回应的问题/请求。
寒暄、反问修辞、自问自答、会议流程性问题（"大家能听到吗"）不算。
只输出 JSON，不要任何其他文字：
{{"is_question": true/false, "confidence": 0到1, "question": "把问题改写成完整独立、可直接检索的一句话，保持原语言；不是问题则为空字符串", "topic": "2-6 个字的主题"}}"""


class LLMDetector:
    name = "llm"

    def __init__(self, router, context_lines: int = 8):
        self.router, self.context_lines = router, context_lines

    async def detect(self, context, speaker, latest):
        convo = "\n".join(context[-self.context_lines:])
        raw = await self.router.complete([{"text": LLM_SYSTEM.format(speaker=speaker)}],
                                         f"{convo}\n\n最后一段（{speaker}）：{latest}", max_tokens=200, fast=True)
        data = json.loads(re.search(r"\{.*\}", raw, re.S).group(0))
        if data.get("is_question") and data.get("question"):
            return _hit(data["question"].strip(), self.name, float(data.get("confidence", 0.8)), data.get("topic", ""))
        return None


# ---------------------------------------------------------------- Jev
class JevDetector:
    """Jev 决策模型（SystemOne 接口）。

    接口规则（jevmodel.org，与 TypeSafe 官方 SystemOne 接口格式相同，换地址和 Key 即可切换）：
      POST {url}   默认 https://jevmodel.org/v1/systemone
      Header: Authorization: Bearer <key>；重试时带相同的 Idempotency-Key 不会重复计费
      Body:   {"model": "jev-latest", "state": <文本/对象>, "questions": {名称: {type, instructions, criteria}}}
      返回:   {"answers": {名称: {"type": "noul", "noul": 0.12} 或 {"type": "choice", "choice": "...", "confidence": 0.9}}, "usage": {...}}
      错误:   401 Key 无效 / 402 余额不足 / 422 参数错误 / 429 超过每分钟 120 次 / 502 上游错误（均不计费）
    这里问两个问题：
      is_question（noul，是/否概率）：最后一句话是否在向我提问或提出需要我回应的请求
      intent（choice，多选一）：提问 / 请求 / 反对意见 / 陈述 / 闲聊
    """
    name = "jev"
    DEFAULT_URL = "https://jevmodel.org/v1/systemone"
    INTENTS = {
        "question": "asks the listener a question that needs an answer (提问)",
        "request": "asks the listener to do, provide or confirm something (请求)",
        "objection": "raises a concern or objection the listener should respond to (质疑/反对)",
        "statement": "states information, no response needed (陈述)",
        "small_talk": "greeting, filler, meeting logistics or rhetorical (寒暄/流程)",
    }

    def __init__(self, cfg: dict, context_lines: int = 8):
        self.url = cfg.get("url") or os.environ.get("JEV_API_URL", "") or self.DEFAULT_URL
        self.api_key = os.environ.get(cfg.get("api_key_env", "JEV_API_KEY"), "")
        self.model = cfg.get("model", "jev-latest")
        self.threshold = float(cfg.get("threshold", 0.6))
        self.timeout = float(cfg.get("timeout_s", 3))
        self.context_lines = context_lines
        self.last_error = ""
        self.remaining = None  # 剩余 token 余额（来自返回头 X-Tokens-Remaining）
        if not self.ready:
            log.warning("Jev 未配置：请在设置里填写 Jev API Key")

    @property
    def ready(self) -> bool:
        return bool(self.url and self.api_key)

    def build_payload(self, context: list[str], speaker: str, latest: str) -> dict:
        return {
            "model": self.model,
            "state": {
                "recent_conversation": context[-self.context_lines:],
                "latest_utterance": {"speaker": speaker, "text": latest},
                "listener": "我 (me) — the person being assisted in this meeting",
            },
            "questions": {
                "is_question": {
                    "type": "noul",
                    "instructions": "Does the latest utterance ask the listener a question, or make a request or "
                                    "objection the listener is expected to answer or respond to right now? "
                                    "The text may mix Chinese and English and may contain speech-recognition errors.",
                    "criteria": {"true": "a question or request directed at the listener",
                                 "false": "statement, greeting, meeting logistics, rhetorical or self-answered question"},
                },
                "intent": {
                    "type": "choice",
                    "instructions": "What is the latest utterance doing?",
                    "criteria": self.INTENTS,
                },
            },
        }

    @staticmethod
    def parse_response(data: dict) -> tuple[float, str]:
        """返回 (是问题的概率, 意图类型)。"""
        answers = data.get("answers") or {}
        p = answers.get("is_question") or {}
        prob = float(p.get("noul", p.get("value", 0.0)) or 0.0)
        c = answers.get("intent") or {}
        return prob, c.get("choice", "") or ""

    async def detect(self, context, speaker, latest):
        if not self.ready:
            raise RuntimeError("Jev 未配置 API Key")
        import uuid
        import httpx
        payload = self.build_payload(context, speaker, latest)
        headers = {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json",
                   "Idempotency-Key": uuid.uuid4().hex}
        async with httpx.AsyncClient(timeout=self.timeout) as http:
            for attempt in range(2):  # 429 / 502 重试一次（相同 Idempotency-Key，不会重复计费）
                r = await http.post(self.url, json=payload, headers=headers)
                if r.status_code in (429, 502) and attempt == 0:
                    await asyncio.sleep(0.4)
                    continue
                break
            if r.status_code >= 400:
                try:
                    err = r.json().get("error", {})
                    msg = f"{err.get('type', '')} {err.get('message', '')}".strip()
                except Exception:
                    msg = r.text[:200]
                hint = {401: "Key 无效", 402: "余额不足", 422: "请求格式有误", 429: "调用太频繁"}.get(r.status_code, "")
                self.last_error = f"HTTP {r.status_code} {hint} {msg}".strip()
                raise RuntimeError(self.last_error)
            self.last_error = ""
            if r.headers.get("X-Tokens-Remaining"):
                self.remaining = r.headers["X-Tokens-Remaining"]
            prob, intent = self.parse_response(r.json())
        log.info("Jev: p=%.2f intent=%s | %s", prob, intent, latest[:40])
        if prob >= self.threshold and intent not in ("statement", "small_talk"):
            # Jev 不改写问题，直接用原话去检索（回答模型会结合上下文理解）
            return _hit(latest, self.name, prob, intent)
        return None


# ---------------------------------------------------------------- 入口
class IntentEngine:
    def __init__(self, cfg: dict, router=None):
        icfg = cfg.get("intent", {})
        self.provider = {"claude": "llm", "chatgpt": "llm", "openai": "llm", "deepseek": "llm"}.get(
            icfg.get("provider", "llm"), icfg.get("provider", "llm"))
        n = icfg.get("context_lines", 8)
        self.rules = RulesDetector()
        self.llm = LLMDetector(router, n) if router is not None and router.ready else None
        self.jev = JevDetector(icfg.get("jev", {}), n) if self.provider in ("jev", "compare") else None
        self.log_path = Path(cfg.get("_root", ".")) / "logs" / "intent_compare.jsonl"

        primary = {"llm": self.llm, "jev": self.jev if self.jev and self.jev.ready else None,
                   "rules": self.rules, "compare": self.llm}.get(self.provider)
        if primary is None and self.provider != "rules":
            log.warning("意图识别 %s 不可用，改用 %s", self.provider, "llm" if self.llm else "rules")
            primary = self.llm or self.rules
        self.primary = primary
        self.router = router
        log.info("意图识别：%s%s", primary.name, "（同时对比 jev）" if self.provider == "compare" else "")

    @property
    def label(self) -> str:
        names = {"llm": "大模型", "jev": "Jev", "rules": "规则"}
        base = names.get(self.primary.name, self.primary.name)
        if self.primary.name == "llm" and self.router and self.router.fast_order:
            c = self.router.clients[self.router.fast_order[0]]
            base = f"{c.label} · {c.model(True)}"
        if self.provider == "compare":
            base += " + Jev 对比" if self.jev and self.jev.ready else "（Jev 未填 Key，未对比）"
        elif self.provider == "jev" and self.primary.name != "jev":
            base += "（Jev 未填 Key，已改用）"
        if self.jev and self.jev.last_error:
            base += f"｜Jev 出错：{self.jev.last_error[:40]}"
        return base

    async def detect(self, context: list[str], speaker: str, latest: str) -> dict | None:
        quick = looks_like_question(latest)
        # 规则没命中且句子很短：大概率不是问题，省一次调用
        if self.primary is not self.rules and not quick and len(latest) < 12:
            return None
        if self.provider == "compare" and self.jev and self.jev.ready and self.llm:
            return await self._compare(context, speaker, latest)
        return await self._safe(self.primary, context, speaker, latest)

    async def _safe(self, det, context, speaker, latest):
        try:
            return await det.detect(context, speaker, latest)
        except Exception as e:
            log.warning("%s 意图识别失败，退回规则：%s", det.name, e)
            return await self.rules.detect(context, speaker, latest)

    async def _timed(self, det, *a):
        t = time.perf_counter()
        try:
            res, err = await det.detect(*a), None
        except Exception as e:
            res, err = None, str(e)
        return res, err, round((time.perf_counter() - t) * 1000)

    async def _compare(self, context, speaker, latest):
        (c, ce, ct), (j, je, jt) = await asyncio.gather(
            self._timed(self.llm, context, speaker, latest), self._timed(self.jev, context, speaker, latest))
        try:
            self.log_path.parent.mkdir(exist_ok=True)
            with open(self.log_path, "a", encoding="utf-8") as f:
                f.write(json.dumps({"ts": time.time(), "speaker": speaker, "text": latest,
                                    "llm": {"hit": bool(c), "ms": ct, "err": ce, "res": c},
                                    "jev": {"hit": bool(j), "ms": jt, "err": je, "res": j}},
                                   ensure_ascii=False) + "\n")
        except Exception:
            pass
        if ce:
            return j if not je else await self.rules.detect(context, speaker, latest)
        return c
