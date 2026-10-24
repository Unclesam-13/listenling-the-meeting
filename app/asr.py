"""Soniox 实时语音识别（WebSocket）。

- 中英文混说可在同一句里切换，无需设置
- enable_speaker_diarization：实时区分说话人（"1"、"2"…）
- enable_endpoint_detection：判断一句话是否说完，说完时返回特殊 token "<end>"
每个声道开一个独立的连接；断线自动重连。
文档：https://soniox.com/docs/stt/rt/real-time-transcription
"""
from __future__ import annotations

import asyncio
import json
import logging
import os

log = logging.getLogger("asr")

URL = "wss://stt-rt.soniox.com/transcribe-websocket"
END_TOKENS = ("<end>", "<fin>")


class SonioxStream:
    def __init__(self, cfg: dict, channel: str, diarize: bool, on_final, on_partial, on_status):
        """
        on_final(channel, speaker_label, text)   一句话（或一个人的一段话）说完
        on_partial(channel, speaker_label, text) 正在说的内容（实时字幕，会不断变化）
        on_status(channel, text)                 连接状态
        """
        self.cfg, self.channel, self.diarize = cfg, channel, diarize
        self.on_final, self.on_partial, self.on_status = on_final, on_partial, on_status
        self.api_key = os.environ.get(cfg.get("api_key_env", "SONIOX_API_KEY"), "")
        self.queue: asyncio.Queue[bytes] = asyncio.Queue(maxsize=150)  # 约 15 秒缓冲
        self.buf: list[tuple[str, str | None]] = []  # 已确定的 (文字, 说话人)
        self.closing = False  # 点了「结束」：把剩下的音频识别完就断开，不再重连

    def close(self):
        """结束会议：通知服务端音频结束，等最后一句识别完后断开（断开后不再计费）。"""
        if self.closing:
            return
        self.closing = True
        if self.queue.full():
            try:
                self.queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
        self.queue.put_nowait(b"")  # 空帧 = 音频结束

    # ---- 音频入口（由事件循环调用）----
    def push(self, pcm: bytes):
        if self.closing:
            return
        if self.queue.full():  # 断线时丢弃最旧的音频，避免越积越多
            try:
                self.queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
        self.queue.put_nowait(pcm)

    def _config(self) -> dict:
        c = {
            "model": self.cfg.get("model", "stt-rt-v5"),
            "audio_format": "pcm_s16le", "sample_rate": 16000, "num_channels": 1,
            "language_hints": self.cfg.get("language_hints", ["zh", "en"]),
            "enable_language_identification": True,
            "enable_speaker_diarization": self.diarize,
            "enable_endpoint_detection": True,
            "max_endpoint_delay_ms": int(self.cfg.get("max_endpoint_delay_ms", 1500)),
            "client_reference_id": f"meeting-copilot-{self.channel}",
        }
        terms = self.cfg.get("terms") or []
        if terms or self.cfg.get("context_text"):
            c["context"] = {k: v for k, v in {"terms": terms, "text": self.cfg.get("context_text")}.items() if v}
        return c

    async def run(self):
        import websockets
        if not self.api_key:
            self.on_status(self.channel, "未设置 SONIOX_API_KEY")
            return
        delay = 1
        while not self.closing:
            try:
                async with websockets.connect(URL, additional_headers={"Authorization": f"Bearer {self.api_key}"},
                                              max_size=None, ping_interval=20) as ws:
                    await ws.send(json.dumps(self._config()))
                    self.on_status(self.channel, "识别中")
                    delay = 1
                    sender = asyncio.create_task(self._sender(ws))
                    try:
                        async for raw in ws:
                            msg = json.loads(raw)
                            self._handle(msg)
                            if msg.get("finished"):
                                break
                    finally:
                        sender.cancel()
            except asyncio.CancelledError:
                self._flush()
                raise
            except Exception as e:
                if self.closing:
                    break
                log.warning("Soniox[%s] 连接中断：%s", self.channel, e)
                self.on_status(self.channel, f"重连中（{str(e)[:60]}）")
            self._flush()
            if self.closing:
                self.on_status(self.channel, "已断开")
                break
            await asyncio.sleep(delay)
            delay = min(delay * 2, 15)

    async def _sender(self, ws):
        while True:
            data = await self.queue.get()
            if data == b"":
                await ws.send("")  # 空字符串通知服务端音频结束，服务端识别完后会关闭连接
                return
            await ws.send(data)

    def _handle(self, msg: dict):
        if msg.get("error_code"):
            raise RuntimeError(f"{msg.get('error_code')} {msg.get('error_message')}")
        partial = []
        for t in msg.get("tokens", []):
            text, spk = t.get("text", ""), t.get("speaker")
            if t.get("is_final"):
                if text in END_TOKENS:
                    self._flush()
                    continue
                # 换人说话了：先把上一个人的话交出去
                if self.buf and spk and self.buf[-1][1] and spk != self.buf[-1][1]:
                    self._flush()
                self.buf.append((text, spk))
            elif text not in END_TOKENS:
                partial.append((text, spk))
        live = "".join(x for x, _ in self.buf) + "".join(x for x, _ in partial)
        spk = (partial or self.buf or [("", None)])[-1][1]
        self.on_partial(self.channel, spk, live.strip())
        if msg.get("finished"):
            self._flush()

    def _flush(self):
        if not self.buf:
            return
        text = "".join(x for x, _ in self.buf).strip()
        spk = next((s for _, s in reversed(self.buf) if s), None)
        self.buf = []
        self.on_partial(self.channel, spk, "")
        if text:
            self.on_final(self.channel, spk, text)
