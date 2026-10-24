"""统一的大模型调用层：Claude / ChatGPT（OpenAI）/ DeepSeek。

用法：
    router = LLMRouter(cfg)
    text = await router.complete(system, user, max_tokens, fast=True)    # 短任务（判断提问、扩展关键词）
    async for t in router.stream(system, user, max_tokens): ...           # 生成回答（流式）

system 是若干段文字：[{"text": "...", "cache": True/False}]
- Claude：cache=True 的段落会开启提示词缓存
- OpenAI / DeepSeek：会自动缓存相同的开头内容，所以把不变的资料放在最前面即可

选中的模型出错时，自动换用下一个已填写 Key 的模型（会议中不会断）。
"""
from __future__ import annotations

import json
import logging
import os
from typing import AsyncIterator

log = logging.getLogger("llm")

# 默认值；config.yaml 的 llm.providers.<名称> 或页面「设置」可以覆盖
PROVIDERS: dict[str, dict] = {
    "claude": {
        "label": "Claude", "key_env": "ANTHROPIC_API_KEY",
        "fast_model": "claude-haiku-5-5", "answer_model": "claude-sonnet-5-5",
        "full_max_chars": 150000,
    },
    "openai": {
        "label": "ChatGPT", "key_env": "OPENAI_API_KEY", "base_url": "https://api.openai.com/v1",
        "fast_model": "gpt-5.4-mini", "answer_model": "gpt-5.4-mini",
        "max_tokens_param": "max_completion_tokens",
        "full_max_chars": 150000,
    },
    "deepseek": {
        "label": "DeepSeek", "key_env": "DEEPSEEK_API_KEY", "base_url": "https://api.deepseek.com",
        "fast_model": "deepseek-flash", "answer_model": "deepseek-flash",
        "max_tokens_param": "max_tokens",
        "extra": {"thinking": {"type": "disabled"}},  # 关闭深度思考，会议中要的是快
        "full_max_chars": 150000,
    },
}
ALIASES = {"chatgpt": "openai", "gpt": "openai", "anthropic": "claude"}


def provider_conf(cfg: dict, name: str) -> dict:
    name = ALIASES.get(name, name)
    c = dict(PROVIDERS.get(name, {}))
    c.update((cfg.get("llm", {}).get("providers", {}) or {}).get(name, {}) or {})
    # 旧版配置兼容：llm.fast_model / llm.answer_model 只作用于 Claude
    if name == "claude":
        for k in ("fast_model", "answer_model"):
            if cfg.get("llm", {}).get(k):
                c[k] = cfg["llm"][k]
    return c


class BaseClient:
    def __init__(self, name: str, conf: dict):
        self.name, self.conf = name, conf
        self.label = conf.get("label", name)
        self.api_key = os.environ.get(conf.get("key_env", ""), "")

    @property
    def ready(self) -> bool:
        return bool(self.api_key)

    def model(self, fast: bool) -> str:
        return self.conf["fast_model" if fast else "answer_model"]


class ClaudeClient(BaseClient):
    def __init__(self, name, conf):
        super().__init__(name, conf)
        self._client = None
        if self.ready:
            from anthropic import AsyncAnthropic
            self._client = AsyncAnthropic(api_key=self.api_key)

    @staticmethod
    def _system(system):
        out = []
        for s in system:
            b = {"type": "text", "text": s["text"]}
            if s.get("cache"):
                b["cache_control"] = {"type": "ephemeral"}
            out.append(b)
        return out

    async def complete(self, system, user, max_tokens, fast=False) -> str:
        r = await self._client.messages.create(model=self.model(fast), max_tokens=max_tokens,
                                               system=self._system(system),
                                               messages=[{"role": "user", "content": user}])
        return "".join(b.text for b in r.content if getattr(b, "type", "") == "text")

    async def stream(self, system, user, max_tokens) -> AsyncIterator[str]:
        async with self._client.messages.stream(model=self.model(False), max_tokens=max_tokens,
                                                system=self._system(system),
                                                messages=[{"role": "user", "content": user}]) as s:
            async for t in s.text_stream:
                yield t


class OpenAICompatClient(BaseClient):
    """OpenAI 格式的接口（ChatGPT、DeepSeek，以及其他兼容 OpenAI 的服务）。"""

    def _body(self, system, user, max_tokens, fast, stream):
        sys_text = "\n\n".join(s["text"] for s in system if s.get("text"))
        body = {
            "model": self.model(fast),
            "messages": ([{"role": "system", "content": sys_text}] if sys_text else []) +
                        [{"role": "user", "content": user}],
            self.conf.get("max_tokens_param", "max_tokens"): max_tokens,
            "stream": stream,
        }
        body.update(self.conf.get("extra") or {})
        return body

    def _url(self):
        return self.conf["base_url"].rstrip("/") + "/chat/completions"

    def _headers(self):
        return {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}

    @staticmethod
    def _raise(r):
        if r.status_code >= 400:
            try:
                msg = r.json().get("error", {}).get("message", r.text)
            except Exception:
                msg = r.text
            raise RuntimeError(f"HTTP {r.status_code}: {str(msg)[:200]}")

    async def complete(self, system, user, max_tokens, fast=False) -> str:
        import httpx
        async with httpx.AsyncClient(timeout=30) as http:
            r = await http.post(self._url(), headers=self._headers(),
                                json=self._body(system, user, max_tokens, fast, False))
            self._raise(r)
            return r.json()["choices"][0]["message"].get("content") or ""

    async def stream(self, system, user, max_tokens) -> AsyncIterator[str]:
        import httpx
        async with httpx.AsyncClient(timeout=httpx.Timeout(60, connect=10)) as http:
            async with http.stream("POST", self._url(), headers=self._headers(),
                                   json=self._body(system, user, max_tokens, False, True)) as r:
                if r.status_code >= 400:
                    await r.aread()
                    self._raise(r)
                async for line in r.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        break
                    try:
                        delta = json.loads(data)["choices"][0].get("delta", {}).get("content")
                    except (ValueError, KeyError, IndexError):
                        continue
                    if delta:
                        yield delta


def make_client(cfg: dict, name: str) -> BaseClient:
    name = ALIASES.get(name, name)
    conf = provider_conf(cfg, name)
    if name == "claude":
        return ClaudeClient(name, conf)
    if conf.get("base_url"):
        return OpenAICompatClient(name, conf)
    raise ValueError(f"未知的模型服务：{name}")


class LLMRouter:
    def __init__(self, cfg: dict):
        lc = cfg.get("llm", {})
        names = list(PROVIDERS) + [n for n in (lc.get("providers") or {}) if n not in PROVIDERS]
        self.clients: dict[str, BaseClient] = {}
        for n in names:
            try:
                self.clients[n] = make_client(cfg, n)
            except Exception as e:
                log.warning("模型服务 %s 初始化失败：%s", n, e)
        want = ALIASES.get(lc.get("answer_provider", "claude"), lc.get("answer_provider", "claude"))
        fast = lc.get("fast_provider") or "same"
        fast = want if fast == "same" else ALIASES.get(fast, fast)
        ready = [n for n, c in self.clients.items() if c.ready]
        # 选中的放第一位，其余已填 Key 的作为备用
        self.answer_order = ([want] if want in ready else []) + [n for n in ready if n != want]
        self.fast_order = ([fast] if fast in ready else []) + [n for n in self.answer_order if n != fast]
        self.wanted = want
        if self.answer_order:
            log.info("回答模型：%s（备用：%s）", self.answer_order[0], ",".join(self.answer_order[1:]) or "无")
        else:
            log.warning("没有可用的大模型：请在设置里至少填写一个 Claude / ChatGPT / DeepSeek 的 API Key")

    @property
    def ready(self) -> bool:
        return bool(self.answer_order)

    @property
    def primary(self) -> BaseClient | None:
        return self.clients[self.answer_order[0]] if self.answer_order else None

    def label(self) -> str:
        if not self.ready:
            return "未设置大模型 API Key"
        p = self.primary
        note = "" if p.name == self.wanted else f"（{PROVIDERS.get(self.wanted, {}).get('label', self.wanted)} 未填 Key，已改用）"
        backup = [self.clients[n].label for n in self.answer_order[1:]]
        return f"{p.label} · {p.model(False)}{note}" + (f"，备用 {'/'.join(backup)}" if backup else "")

    def full_max_chars(self) -> int:
        return int(self.primary.conf.get("full_max_chars", 150000)) if self.primary else 0

    async def complete(self, system, user, max_tokens=300, fast=True) -> str:
        last = None
        for n in (self.fast_order if fast else self.answer_order):
            try:
                return await self.clients[n].complete(system, user, max_tokens, fast=fast)
            except Exception as e:
                last = e
                log.warning("%s 调用失败，尝试下一个：%s", n, e)
        raise RuntimeError(f"所有模型都调用失败：{last}")

    async def stream(self, system, user, max_tokens=600) -> AsyncIterator[str]:
        errors = []
        for i, n in enumerate(self.answer_order):
            c = self.clients[n]
            got = False
            try:
                if i > 0:
                    yield f"（{self.clients[self.answer_order[i - 1]].label} 暂时不可用，已改用 {c.label}）\n\n"
                async for t in c.stream(system, user, max_tokens):
                    got = True
                    yield t
                return
            except Exception as e:
                log.warning("%s 生成回答失败：%s", n, e)
                errors.append(f"{c.label}：{e}")
                if got:  # 已经输出了一部分，不再切换，避免内容重复
                    yield f"\n\n（生成中断：{e}）"
                    return
        yield "（生成回答失败：" + "；".join(errors) + "）" if errors else "（没有可用的大模型，请在设置里填写 API Key）"
