"""意图识别：判断对方的一段话是不是在向「我」提问。

可在 config.yaml 的 intent.provider 里切换：
  rules    只用规则（离线、最快、最不准）
  claude   用 Claude（默认，会顺便把问题改写成完整的一句话）
  jev      用 Jev（TypeSafe AI 的决策模型，适合这种"是/否 + 概率"的判断）——接口已预留，见 JevDetector
  compare  以 claude 的结果为准，同时调用 jev，把两者的结果和耗时记到 logs/intent_compare.jsonl，方便对比

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


# ---------------------------------------------------------------- Claude
CLAUDE_SYSTEM = """你在一场会议中实时辅助「我」。下面是最近的会议转写（可能中英混合，可能有识别错误）。
判断最后一段发言（来自 {speaker}）是否在提出一个需要「我」回答或回应的问题/请求。
寒暄、反问修辞、自问自答、会议流程性问题（"大家能听到吗"）不算。
只输出 JSON，不要任何其他文字：
{{"is_question": true/false, "confidence": 0到1, "question": "把问题改写成完整独立、可直接检索的一句话，保持原语言；不是问题则为空字符串", "topic": "2-6 个字的主题"}}"""


class ClaudeDetector:
    name = "claude"

    def __init__(self, client, model: str, context_lines: int = 8):
        self.client, self.model, self.context_lines = client, model, context_lines

    async def detect(self, context, speaker, latest):
        convo = "\n".join(context[-self.context_lines:])
        r = await self.client.messages.create(
            model=self.model, max_tokens=200, system=CLAUDE_SYSTEM.format(speaker=speaker),
            messages=[{"role": "user", "content": f"{convo}\n\n最后一段（{speaker}）：{latest}"}],
        )
        raw = "".join(b.text for b in r.content if getattr(b, "type", "") == "text")
        data = json.loads(re.search(r"\{.*\}", raw, re.S).group(0))
        if data.get("is_question") and data.get("question"):
            return _hit(data["question"].strip(), self.name, float(data.get("confidence", 0.8)), data.get("topic", ""))
        return None


# ---------------------------------------------------------------- Jev（预留接口）
class JevDetector:
    """Jev 决策模型适配器。

    Jev 不生成文字，而是对一段"状态"回答预先定义好的问题，返回概率/选项。这里用两个问题：
      1) noul（是/否概率）："最后一句话是在向我提问或提出需要我回应的请求"
      2) choice（多选一）：这句话的类型 —— 提问 / 请求 / 反对意见 / 陈述 / 闲聊

    ⚠️ 拿到 Jev 的接口文档后，只需要修改下面两个方法：
        build_payload()   —— 按官方格式组织请求
        parse_response()  —— 从官方返回里取出概率和选项
    其余代码（配置、超时、降级、对比日志）都不用动。
    """
    name = "jev"
    INTENT_OPTIONS = ["question", "request", "objection", "statement", "small_talk"]

    def __init__(self, cfg: dict, context_lines: int = 8):
        self.url = cfg.get("url") or os.environ.get("JEV_API_URL", "")
        self.api_key = os.environ.get(cfg.get("api_key_env", "JEV_API_KEY"), "")
        self.model = cfg.get("model", "jev")
        self.threshold = float(cfg.get("threshold", 0.6))
        self.timeout = float(cfg.get("timeout_s", 3))
        self.context_lines = context_lines
        if not self.ready:
            log.warning("Jev 未配置：请在 config.yaml 填 intent.jev.url，并设置环境变量 %s",
                        cfg.get("api_key_env", "JEV_API_KEY"))

    @property
    def ready(self) -> bool:
        return bool(self.url and self.api_key)

    # ----- 需要按官方文档修改 -----
    def build_payload(self, context: list[str], speaker: str, latest: str) -> dict:
        return {
            "model": self.model,
            "state": {
                "recent_conversation": context[-self.context_lines:],
                "latest_utterance": {"speaker": speaker, "text": latest},
                "listener": "我 (me)",
            },
            "questions": [
                {"id": "is_question", "type": "noul",
                 "statement": "The latest utterance asks the listener a question, or makes a request "
                              "the listener is expected to answer or respond to now."},
                {"id": "intent", "type": "choice", "options": self.INTENT_OPTIONS},
            ],
        }

    def parse_response(self, data: dict) -> tuple[float, str]:
        """返回 (是问题的概率, 意图类型)。"""
        answers = data.get("answers") or data.get("results") or {}
        if isinstance(answers, list):
            answers = {a.get("id"): a for a in answers}
        p = answers.get("is_question", {})
        prob = float(p.get("value", p.get("probability", 0.0)))
        c = answers.get("intent", {})
        intent = c.get("choice") or c.get("value") or ""
        return prob, intent
    # ------------------------------

    async def detect(self, context, speaker, latest):
        if not self.ready:
            raise RuntimeError("Jev 未配置 url / api key")
        import httpx
        async with httpx.AsyncClient(timeout=self.timeout) as http:
            r = await http.post(self.url, json=self.build_payload(context, speaker, latest),
                                headers={"Authorization": f"Bearer {self.api_key}"})
            r.raise_for_status()
            prob, intent = self.parse_response(r.json())
        if prob >= self.threshold and intent in ("question", "request", "objection", ""):
            # Jev 不改写问题，直接用原话去检索（回答模型会结合上下文理解）
            return _hit(latest, self.name, prob, intent)
        return None


# ---------------------------------------------------------------- 入口
class IntentEngine:
    def __init__(self, cfg: dict, claude_client=None):
        icfg = cfg.get("intent", {})
        self.provider = icfg.get("provider", "claude")
        n = icfg.get("context_lines", 8)
        self.rules = RulesDetector()
        self.claude = ClaudeDetector(claude_client, cfg["llm"]["fast_model"], n) if claude_client else None
        self.jev = JevDetector(icfg.get("jev", {}), n) if self.provider in ("jev", "compare") else None
        self.log_path = Path(cfg.get("_root", ".")) / "logs" / "intent_compare.jsonl"

        primary = {"claude": self.claude, "jev": self.jev if self.jev and self.jev.ready else None,
                   "rules": self.rules, "compare": self.claude}.get(self.provider)
        if primary is None and self.provider != "rules":
            log.warning("意图识别 %s 不可用，改用 %s", self.provider, "claude" if self.claude else "rules")
            primary = self.claude or self.rules
        self.primary = primary
        log.info("意图识别：%s%s", primary.name, "（同时对比 jev）" if self.provider == "compare" else "")

    @property
    def label(self) -> str:
        return self.primary.name + (" + jev对比" if self.provider == "compare" else "")

    async def detect(self, context: list[str], speaker: str, latest: str) -> dict | None:
        quick = looks_like_question(latest)
        # 规则没命中且句子很短：大概率不是问题，省一次调用
        if self.primary is not self.rules and not quick and len(latest) < 12:
            return None
        if self.provider == "compare" and self.jev and self.jev.ready:
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
            self._timed(self.claude, context, speaker, latest), self._timed(self.jev, context, speaker, latest))
        try:
            self.log_path.parent.mkdir(exist_ok=True)
            with open(self.log_path, "a", encoding="utf-8") as f:
                f.write(json.dumps({"ts": time.time(), "speaker": speaker, "text": latest,
                                    "claude": {"hit": bool(c), "ms": ct, "err": ce, "res": c},
                                    "jev": {"hit": bool(j), "ms": jt, "err": je, "res": j}},
                                   ensure_ascii=False) + "\n")
        except Exception:
            pass
        if ce:
            return j if not je else await self.rules.detect(context, speaker, latest)
        return c
