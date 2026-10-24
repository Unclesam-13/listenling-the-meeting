"""网络部分自检：在本机起一个模拟服务器，模拟 OpenAI/DeepSeek 格式的接口和 Jev 接口，
用真实的 httpx 代码走一遍「流式回答 / 普通调用 / Jev 判断 / 各种错误」。打包 DMG 时自动运行。

    python -m app.selftest_net
"""
from __future__ import annotations

import asyncio
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SEEN: dict = {}


class Mock(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, code, obj, headers=None):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        auth = self.headers.get("Authorization", "")
        if self.path.endswith("/chat/completions"):
            SEEN["chat"] = body
            if auth != "Bearer good":
                return self._json(401, {"error": {"message": "Incorrect API key provided"}})
            if body.get("stream"):
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                for piece in ["**结论**：", "数据存放在", "悉尼。"]:
                    chunk = {"choices": [{"delta": {"content": piece}}]}
                    self.wfile.write(f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n".encode())
                    self.wfile.flush()
                self.wfile.write(b": keep-alive\n\ndata: [DONE]\n\n")
                return
            return self._json(200, {"choices": [{"message": {"role": "assistant", "content": "数据, data, AWS"}}]})
        if self.path.endswith("/v1/systemone"):
            SEEN["jev"] = {"body": body, "idem": self.headers.get("Idempotency-Key")}
            if auth == "Bearer broke":
                return self._json(402, {"error": {"type": "insufficient_credits", "message": "balance too low"}})
            text = body["state"]["latest_utterance"]["text"]
            q = "？" in text or "?" in text
            return self._json(200, {
                "model": "jev-1.13.0",
                "answers": {
                    "is_question": {"type": "noul", "noul": 0.93 if q else 0.08},
                    "intent": {"type": "choice", "choice": "question" if q else "statement",
                               "probabilities": {}, "confidence": 0.9},
                },
                "usage": {"input_tokens": 300},
            }, headers={"X-Tokens-Remaining": "99700"})
        self._json(404, {"error": {"message": "not found"}})


def run() -> str:
    from .intent import JevDetector
    from .llm import OpenAICompatClient

    srv = ThreadingHTTPServer(("127.0.0.1", 0), Mock)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_address[1]}"

    def client(key):
        os.environ["SELFTEST_KEY"] = key
        return OpenAICompatClient("deepseek", {
            "label": "DeepSeek", "key_env": "SELFTEST_KEY", "base_url": base + "/v1",
            "fast_model": "deepseek-flash", "answer_model": "deepseek-flash",
            "max_tokens_param": "max_tokens", "extra": {"thinking": {"type": "disabled"}}})

    async def main():
        c = client("good")
        text = "".join([t async for t in c.stream([{"text": "sys"}], "问题", 100)])
        assert text == "**结论**：数据存放在悉尼。", text
        assert SEEN["chat"]["thinking"] == {"type": "disabled"} and SEEN["chat"]["max_tokens"] == 100
        assert await c.complete([], "q", 50, fast=True) == "数据, data, AWS"
        try:
            await client("bad").complete([], "q", 50)
            raise AssertionError("401 没有报错")
        except RuntimeError as e:
            assert "401" in str(e) and "Incorrect API key" in str(e), e
        try:
            async for _ in client("bad").stream([], "q", 50):
                pass
            raise AssertionError("流式 401 没有报错")
        except RuntimeError as e:
            assert "401" in str(e), e

        os.environ["JEV_API_KEY"] = "good"
        j = JevDetector({"url": base + "/v1/systemone"})
        hit = await j.detect(["对方1: 你好"], "对方1", "你们的数据存在哪里？")
        assert hit and hit["provider"] == "jev" and hit["confidence"] > 0.9, hit
        assert SEEN["jev"]["idem"] and SEEN["jev"]["body"]["questions"]["is_question"]["type"] == "noul"
        assert j.remaining == "99700"
        assert await j.detect([], "对方1", "好的，我们继续。") is None
        os.environ["JEV_API_KEY"] = "broke"
        try:
            await JevDetector({"url": base + "/v1/systemone"}).detect([], "对方1", "多少钱？")
            raise AssertionError("402 没有报错")
        except RuntimeError as e:
            assert "402" in str(e) and "余额不足" in str(e), e

    asyncio.run(main())
    srv.shutdown()
    return "network selftest ok"


if __name__ == "__main__":
    print(run())
