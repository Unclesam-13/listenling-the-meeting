"""意图识别（委托给 intent.IntentEngine）+ 生成回答。

用问题去资料库检索后，流式生成"一句话结论 + 要点 + 出处"。
没有 ANTHROPIC_API_KEY 时：直接展示检索到的资料片段。
"""
from __future__ import annotations

import logging
import os
import re
from typing import AsyncIterator

from .intent import IntentEngine

log = logging.getLogger("brain")

ANSWER_SYSTEM = """你是会议中的实时提词助手。对方刚问了一个问题，「我」需要在几秒内看一眼手机就能回答。
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
- 不要寒暄，不要重复问题。"""


class Brain:
    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.client = None
        if os.environ.get("ANTHROPIC_API_KEY"):
            try:
                from anthropic import AsyncAnthropic
                self.client = AsyncAnthropic()
            except Exception as e:
                log.warning("Anthropic SDK 不可用：%s", e)
        if self.client is None:
            log.warning("未设置 ANTHROPIC_API_KEY：回答将直接展示资料片段")
        if not cfg.get("intent", {}).get("use_llm", True):
            cfg["intent"]["provider"] = "rules"
        self.intent = IntentEngine(cfg, self.client)

    @property
    def llm_ready(self) -> bool:
        return self.client is not None

    async def detect(self, context: list[str], speaker: str, latest: str) -> dict | None:
        return await self.intent.detect(context, speaker, latest)

    async def retrieve(self, question: str, kb) -> list[dict] | None:
        """返回检索到的片段；资料库为 full 模式时返回 None（整个资料库直接交给 Claude）。"""
        if kb.mode == "full" and self.llm_ready:
            return None
        keywords = await self._expand(question) if self.llm_ready else []
        return kb.search(question, keywords=keywords)

    async def _expand(self, question: str) -> list[str]:
        """让 Claude 把问题扩展成中英文检索词，解决"中文问题搜英文资料"的问题。"""
        try:
            r = await self.client.messages.create(
                model=self.cfg["llm"]["fast_model"], max_tokens=120,
                messages=[{"role": "user", "content":
                           "为下面的问题生成 6-10 个用于在资料库中做关键词检索的词，中文和英文都要有，"
                           f"包括同义词和专业术语。只输出词，用逗号分隔。\n问题：{question}"}],
            )
            raw = "".join(b.text for b in r.content if getattr(b, "type", "") == "text")
            return [w.strip() for w in re.split(r"[,，、\n]", raw) if w.strip()][:12]
        except Exception as e:
            log.warning("扩展检索词失败：%s", e)
            return []

    async def answer(self, question: str, hits: list[dict] | None, context: list[str], kb) -> AsyncIterator[str]:
        if not self.llm_ready:
            if not hits:
                yield "**资料中未找到**相关内容。"
                return
            yield "**相关资料**（未配置 Claude，直接展示检索结果）\n"
            for h in hits[:3]:
                snippet = h["text"].strip().replace("\n", " ")
                yield f"\n- {snippet[:160]}{'…' if len(snippet) > 160 else ''}  \n  来源：[{h['source']}]"
            return

        system = [{"type": "text", "text": ANSWER_SYSTEM}]
        if hits is None:
            # full 模式：整个资料库放进 system，并开启提示词缓存（同一场会议里后续提问会快很多、便宜很多）
            system.append({"type": "text", "text": "【资料】\n" + (kb.full_text() or "（资料库为空）"),
                           "cache_control": {"type": "ephemeral"}})
            refs = "（见系统提示中的【资料】）"
        else:
            parts = []
            for i, h in enumerate(hits):
                page = " 第%s页" % h["page"] if h.get("page") else ""
                parts.append(f"[{i+1}] 文件：{h['source']}{page}\n{h['text']}")
            refs = "\n\n".join(parts) or "（资料库中没有检索到相关内容）"
        convo = "\n".join(context[-6:])
        user = f"【最近对话】\n{convo}\n\n【问题】{question}\n\n【资料】\n{refs}"
        try:
            async with self.client.messages.stream(
                model=self.cfg["llm"]["answer_model"], max_tokens=self.cfg["llm"].get("max_answer_tokens", 600),
                system=system, messages=[{"role": "user", "content": user}],
            ) as stream:
                async for text in stream.text_stream:
                    yield text
        except Exception as e:
            log.exception("生成回答失败")
            yield f"\n\n（生成回答出错：{e}）"

    async def warm_cache(self, kb):
        """开会前预热：先把资料库写入 Claude 的提示词缓存，第一次提问也能快速出答案。"""
        if not self.llm_ready or kb.mode != "full" or not kb.docs:
            return
        try:
            await self.client.messages.create(
                model=self.cfg["llm"]["answer_model"], max_tokens=1,
                system=[{"type": "text", "text": ANSWER_SYSTEM},
                        {"type": "text", "text": "【资料】\n" + kb.full_text(), "cache_control": {"type": "ephemeral"}}],
                messages=[{"role": "user", "content": "预热，回复 ok"}],
            )
            log.info("资料库已写入提示词缓存")
        except Exception as e:
            log.warning("缓存预热失败（不影响使用）：%s", e)
