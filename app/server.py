"""服务端：串起 音频 -> 识别 -> 说话人 -> 意图 -> 检索 -> 回答，并通过 WebSocket 推送到电脑和手机。"""
from __future__ import annotations

import asyncio
import io
import logging
import secrets
import socket
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from .brain import Brain
from .kb import KnowledgeBase
from .speakers import SpeakerRegistry

log = logging.getLogger("server")
WEB = Path(__file__).parent / "web"


def lan_ip() -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))  # 不会真正发包，只是让系统选出局域网网卡
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


class Copilot:
    def __init__(self, cfg: dict, audio_enabled: bool = True):
        self.cfg = cfg
        self.audio_enabled = audio_enabled and cfg.get("audio", {}).get("enabled", True)
        self.token = secrets.token_urlsafe(8)
        self.port = cfg["server"]["port"]
        self.phone_url = f"http://{lan_ip()}:{self.port}/phone?t={self.token}"
        self.clients: set[WebSocket] = set()
        self.transcript: list[dict] = []
        self.answers: list[dict] = []
        self.status: dict = {"asr": "未启动", "audio": "未启动", "kb": "加载中", "llm": ""}
        self.kb = KnowledgeBase(cfg["kb"])
        self.brain = Brain(cfg)
        self.status["llm"] = "Claude 已连接" if self.brain.llm_ready else "未设置 Claude API Key"
        self.status["intent"] = self.brain.intent.label
        self.speakers = SpeakerRegistry()
        self.streams: dict = {}          # channel -> SonioxStream
        self.audio_tasks: list = []
        self.capture = None
        self.loop: asyncio.AbstractEventLoop | None = None
        self.partials: dict[str, dict] = {}  # channel -> 正在说的实时字幕
        self.pending: dict[str, dict] = {}   # 每个说话人正在说的一"轮"话
        self.last_q: tuple[str, float] = ("", 0.0)
        self.seq = 0
        # 开始 / 结束：只有点了「开始」才录音、连接识别服务（按时长计费）
        self.recording = False
        self.rec_started = 0.0
        self.last_activity = 0.0
        self._rec_lock = asyncio.Lock()

    # ---------------- 推送 ----------------
    async def broadcast(self, msg: dict):
        dead = []
        for ws in list(self.clients):
            try:
                await ws.send_json(msg)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.clients.discard(ws)

    async def set_status(self, **kw):
        self.status.update(kw)
        await self.broadcast({"type": "status", "status": self.status})

    def snapshot(self) -> dict:
        return {"type": "snapshot", "transcript": self.transcript[-200:], "answers": self.answers[-30:],
                "status": self.status, "names": self.speakers.names, "phone_url": self.phone_url,
                "kb": self.kb.stats(), "clients": len(self.clients), "needs_setup": self.needs_setup(),
                "rec": self.rec_state()}

    def _id(self) -> str:
        self.seq += 1
        return f"{int(time.time()*1000)}-{self.seq}"

    # ---------------- 启动 ----------------
    async def start(self):
        self.loop = asyncio.get_running_loop()
        asyncio.create_task(self._init_kb())
        asyncio.create_task(self._watchdog())
        if self.audio_enabled:
            self.status.update(asr="未连接", audio="未开始（点「开始」开始录音）")
        else:
            self.status.update(asr="已关闭（测试模式）", audio="已关闭（测试模式）")

    async def _init_kb(self):
        info = await asyncio.to_thread(self.kb.build)
        mode = "整体交给 Claude" if info["mode"] == "full" else "关键词检索"
        size = f"约 {info['chars'] / 10000:.1f} 万字" if info["chars"] >= 10000 else f"{info['chars']} 字"
        await self.set_status(kb=f"{info['files']} 个文件 / {size}（{mode}）")
        await self.brain.warm_cache(self.kb)

    # ---------------- 开始 / 结束 ----------------
    def rec_state(self) -> dict:
        return {"recording": self.recording, "started": self.rec_started, "now": time.time(),
                "auto_stop_min": self.cfg.get("audio", {}).get("auto_stop_minutes", 10),
                "test_mode": not self.audio_enabled}

    async def _broadcast_rec(self, notice: str = ""):
        await self.broadcast({"type": "rec", **self.rec_state(), "notice": notice})

    async def start_recording(self):
        async with self._rec_lock:
            if self.recording:
                return
            if not self.audio_enabled:
                await self._broadcast_rec("测试模式下不录音，可用左下角输入框模拟发言")
                return
            if self.needs_setup():
                await self._broadcast_rec("请先在「设置」里填写 Soniox 和 Claude 的 API Key")
                return
            self.recording = True
            self.rec_started = self.last_activity = time.time()
            self._asr_state = {}
            await self.set_status(asr="连接中…", audio="启动中…")
            ok = await self._init_audio()
            if not ok:
                self.recording = False
                self._hard_stop()
            await self._broadcast_rec()

    async def stop_recording(self, notice: str = ""):
        async with self._rec_lock:
            if not self.recording:
                return
            self.recording = False
            if self.capture:  # 先停麦克风
                self.capture.stop()
                self.capture = None
            for st in self.streams.values():  # 再通知识别服务：音频结束，把最后一句识别完
                st.close()
            if self.audio_tasks:
                _, pending = await asyncio.wait(self.audio_tasks, timeout=5)
                for t in pending:
                    t.cancel()
            self.audio_tasks, self.streams, self.partials = [], {}, {}
            mins = (time.time() - self.rec_started) / 60
            self.rec_started = 0.0
            await self.set_status(asr="已断开（不再计费）", audio=f"已结束（本次 {mins:.0f} 分钟）")
            await self.broadcast({"type": "partial_clear"})
            await self._broadcast_rec(notice)

    async def _watchdog(self):
        """忘了点「结束」时的保险：连续 N 分钟没有任何人说话，自动结束。"""
        while True:
            await asyncio.sleep(15)
            limit = float(self.cfg.get("audio", {}).get("auto_stop_minutes", 10) or 0)
            if self.recording and limit > 0 and time.time() - self.last_activity > limit * 60:
                log.info("连续 %.0f 分钟无人说话，自动结束", limit)
                await self.stop_recording(f"连续 {limit:.0f} 分钟没有人说话，已自动结束，避免浪费识别时长")

    async def _init_audio(self) -> bool:
        from .asr import SonioxStream
        from .audio import AudioCapture
        try:
            self.capture = AudioCapture(self.cfg["audio"], self._on_audio_thread)
            diarize = self.cfg.get("speakers", {}).get("enabled", True)
            for ch in self.capture.channels():
                st = SonioxStream(self.cfg["asr"], ch, diarize and ch != "me",
                                  self._on_final, self._on_partial, self._on_asr_status)
                self.streams[ch] = st
                self.audio_tasks.append(asyncio.create_task(st.run()))
            names = await asyncio.to_thread(self.capture.start)
            label = {"me": "我", "others": "对方", "room": "会议室"}
            await self.set_status(audio="录音中：" + "，".join(f"{label[k]}←{v}" for k, v in names.items()))
            return True
        except Exception as e:
            log.exception("音频启动失败")
            await self.set_status(audio=f"失败：{e}", asr="未连接")
            return False

    def _on_audio_thread(self, channel: str, pcm: bytes):
        # 在音频线程里被调用，转交给事件循环
        st = self.streams.get(channel)
        if st and self.loop:
            self.loop.call_soon_threadsafe(st.push, pcm)

    def _hard_stop(self):
        if self.capture:
            self.capture.stop()
            self.capture = None
        for t in self.audio_tasks:
            t.cancel()
        self.audio_tasks, self.streams, self.partials = [], {}, {}
        self._asr_state = {}

    def stop(self):
        """程序退出时调用：立即断开所有连接。"""
        self.recording = False
        self._hard_stop()

    async def reload(self, cfg: dict):
        """设置保存后重新加载：重建 Claude/意图识别；如果正在录音，用新设置重新开始。"""
        was_recording = self.recording
        await self.stop_recording()
        self.cfg = cfg
        self.brain = Brain(cfg)
        self.status["llm"] = "Claude 已连接" if self.brain.llm_ready else "未设置 Claude API Key"
        self.status["intent"] = self.brain.intent.label
        await self.set_status()
        if was_recording:
            await self.start_recording()
        await self.brain.warm_cache(self.kb)

    def needs_setup(self) -> bool:
        import os
        return not (os.environ.get(self.cfg["asr"].get("api_key_env", "SONIOX_API_KEY"))
                    and os.environ.get("ANTHROPIC_API_KEY"))

    # ---------------- 识别回调 ----------------
    def _on_asr_status(self, channel: str, text: str):
        self._asr_state = getattr(self, "_asr_state", {})
        self._asr_state[channel] = text
        label = {"me": "我", "others": "对方", "room": "会议室"}
        asyncio.create_task(self.set_status(
            asr="Soniox " + "，".join(f"{label.get(k, k)}:{v}" for k, v in self._asr_state.items())))

    def _on_final(self, channel: str, label, text: str):
        self.last_activity = time.time()
        sid = self.speakers.sid(channel, label)
        asyncio.create_task(self.add_line(sid, text, channel))

    def _on_partial(self, channel: str, label, text: str):
        sid = self.speakers.sid(channel, label) if text else None
        prev = self.partials.get(channel, {}).get("text", "")
        if text == prev:
            return
        self.partials[channel] = {"sid": sid, "text": text}
        if text:
            self.last_activity = time.time()
        # 对方还在说：推迟"是不是问题"的判断
        if text and sid in self.pending:
            self.pending[sid]["task"].cancel()
            self.pending[sid]["task"] = asyncio.create_task(self._settle(sid))
        asyncio.create_task(self.broadcast({"type": "partial", "channel": channel, "sid": sid,
                                            "name": self.speakers.name(sid) if sid else "", "text": text}))

    def _context(self) -> list[str]:
        return [f"{self.speakers.name(t['sid'])}: {t['text']}" for t in self.transcript[-12:]]

    async def add_line(self, sid: str, text: str, channel: str = "others"):
        item = {"type": "transcript", "id": self._id(), "sid": sid, "name": self.speakers.name(sid),
                "channel": channel, "text": text, "ts": time.time()}
        self.transcript.append(item)
        self.transcript = self.transcript[-1000:]
        await self.broadcast(item)

        answer_for = self.cfg["intent"].get("answer_for", "others")
        if sid == "me" and answer_for != "all":
            return
        # 同一个人连续说的几句合并成一"轮"，停顿 settle_ms 后再判断
        turn = self.pending.get(sid)
        if turn:
            turn["task"].cancel()
            turn["text"] += " " + text
        else:
            turn = self.pending[sid] = {"text": text}
        turn["task"] = asyncio.create_task(self._settle(sid))

    async def _settle(self, sid: str):
        try:
            await asyncio.sleep(self.cfg["intent"].get("settle_ms", 1200) / 1000)
        except asyncio.CancelledError:
            return
        turn = self.pending.pop(sid, None)
        if not turn:
            return
        await self._evaluate(sid, turn["text"])

    async def _evaluate(self, sid: str, text: str):
        name = self.speakers.name(sid)
        res = await self.brain.detect(self._context(), name, text)
        if not res:
            return
        q = res["question"]
        # 去重：30 秒内同样的问题不重复回答
        if q == self.last_q[0] and time.time() - self.last_q[1] < 30:
            return
        self.last_q = (q, time.time())
        await self.answer(q, asker=name, origin="auto", raw=text)

    # ---------------- 回答 ----------------
    async def answer(self, question: str, asker: str = "", origin: str = "manual", raw: str = ""):
        aid = self._id()
        hits = await self.brain.retrieve(question, self.kb)
        sources = []
        for h in hits or []:
            label = h["source"] + (f" p{h['page']}" if h.get("page") else "")
            if label not in sources:
                sources.append(label)
        ans = {"id": aid, "question": question, "raw": raw, "asker": asker, "origin": origin,
               "sources": sources, "text": "", "ts": time.time(), "done": False}
        self.answers.append(ans)
        self.answers = self.answers[-100:]
        await self.broadcast({"type": "answer_start", **ans})
        async for delta in self.brain.answer(question, hits, self._context(), self.kb):
            ans["text"] += delta
            await self.broadcast({"type": "answer_delta", "id": aid, "text": delta})
        ans["done"] = True
        await self.broadcast({"type": "answer_end", "id": aid, "text": ans["text"]})

    # ---------------- 客户端指令 ----------------
    async def handle(self, msg: dict, is_desktop: bool):
        t = msg.get("type")
        if t == "ask" and msg.get("text", "").strip():
            asyncio.create_task(self.answer(msg["text"].strip(), asker="手动提问", origin="manual"))
        elif t == "inject" and is_desktop and msg.get("text", "").strip():
            # 测试用：模拟某人说了一句话
            sid = msg.get("sid") or "spk1"
            if sid not in self.speakers.names:
                self.speakers.names[sid] = msg.get("name") or "对方"
            await self.add_line(sid, msg["text"].strip(), "others" if sid != "me" else "me")
        elif t == "rename" and is_desktop and msg.get("sid") and msg.get("name"):
            self.speakers.rename(msg["sid"], msg["name"].strip()[:20])
            await self.broadcast({"type": "names", "names": self.speakers.names})
        elif t == "start":
            asyncio.create_task(self.start_recording())
        elif t == "stop":
            asyncio.create_task(self.stop_recording())
        elif t == "reload_kb" and is_desktop:
            await self.set_status(kb="重新加载中…")
            asyncio.create_task(self._init_kb())
        elif t == "clear" and is_desktop:
            self.transcript.clear(); self.answers.clear()
            await self.broadcast(self.snapshot())


def create_app(cfg: dict, audio_enabled: bool = True) -> FastAPI:
    cp = Copilot(cfg, audio_enabled)

    @asynccontextmanager
    async def lifespan(app):
        await cp.start()
        yield
        cp.stop()

    app = FastAPI(lifespan=lifespan)
    app.state.copilot = cp
    app.mount("/static", StaticFiles(directory=WEB), name="static")

    def is_local(req) -> bool:
        return req.client is not None and req.client.host in ("127.0.0.1", "::1", "localhost")

    @app.get("/", response_class=HTMLResponse)
    async def desktop(request: Request):
        if not is_local(request):
            raise HTTPException(403, "电脑端页面只能在本机打开；手机请扫码")
        html = (WEB / "desktop.html").read_text(encoding="utf-8")
        return html.replace("__TOKEN__", cp.token)

    @app.get("/phone", response_class=HTMLResponse)
    async def phone(t: str = ""):
        if t != cp.token:
            return HTMLResponse("<h3 style='font-family:sans-serif'>链接已失效，请在电脑上重新扫码。</h3>", 403)
        return (WEB / "phone.html").read_text(encoding="utf-8").replace("__TOKEN__", cp.token)

    @app.get("/api/qr")
    async def qr(request: Request):
        if not is_local(request):
            raise HTTPException(403)
        import qrcode
        import qrcode.image.svg
        img = qrcode.make(cp.phone_url, image_factory=qrcode.image.svg.SvgPathImage, box_size=8, border=2)
        buf = io.BytesIO(); img.save(buf)
        return Response(buf.getvalue(), media_type="image/svg+xml")

    @app.get("/api/kb/search")
    async def kb_search(request: Request, q: str):
        if not is_local(request):
            raise HTTPException(403)
        return JSONResponse(await asyncio.to_thread(cp.kb.search, q))

    # ---------------- 设置（仅本机）----------------
    @app.get("/api/settings")
    async def get_settings(request: Request):
        if not is_local(request):
            raise HTTPException(403)
        import os
        from .config import ROOT, load_settings
        devices, err = [], ""
        try:
            import sounddevice as sd
            devices = [d["name"] for d in sd.query_devices() if d["max_input_channels"] > 0]
        except Exception as e:
            err = str(e)
        a = cp.cfg.get("audio", {})
        st = load_settings()
        return {
            "has": {k: bool(os.environ.get(k)) for k in ("SONIOX_API_KEY", "ANTHROPIC_API_KEY", "JEV_API_KEY")},
            "devices": devices, "device_error": err,
            "mic_device": a.get("mic_device") or "", "system_device": a.get("system_device") or "",
            "blackhole": any("blackhole" in d.lower() for d in devices),
            "jev_url": cp.cfg.get("intent", {}).get("jev", {}).get("url", ""),
            "intent_provider": st.get("intent_provider") or cp.cfg.get("intent", {}).get("provider", "claude"),
            "data_dir": str(ROOT), "kb_dir": cp.cfg["kb"]["dir"],
        }

    @app.post("/api/settings")
    async def post_settings(request: Request):
        if not is_local(request):
            raise HTTPException(403)
        from .config import load_config, save_env, save_settings
        body = await request.json()
        save_env({k: (body.get(k) or "").strip() for k in ("SONIOX_API_KEY", "ANTHROPIC_API_KEY", "JEV_API_KEY")})
        upd = {k: body[k] for k in ("mic_device", "system_device", "jev_url", "intent_provider") if k in body}
        if upd:
            save_settings(upd)
        await cp.reload(load_config())
        return {"ok": True}

    @app.post("/api/open_folder")
    async def open_folder(request: Request):
        if not is_local(request):
            raise HTTPException(403)
        import subprocess
        import sys
        path = cp.cfg["kb"]["dir"]
        if sys.platform == "darwin":
            subprocess.Popen(["open", path])
        return {"path": path}

    @app.websocket("/ws")
    async def ws_endpoint(ws: WebSocket, t: str = ""):
        if t != cp.token:
            await ws.close(code=4403)
            return
        await ws.accept()
        is_desktop = ws.client is not None and ws.client.host in ("127.0.0.1", "::1")
        cp.clients.add(ws)
        await ws.send_json(cp.snapshot())
        await cp.broadcast({"type": "clients", "count": len(cp.clients)})
        try:
            while True:
                await cp.handle(await ws.receive_json(), is_desktop)
        except (WebSocketDisconnect, RuntimeError):
            pass
        finally:
            cp.clients.discard(ws)
            await cp.broadcast({"type": "clients", "count": len(cp.clients)})

    return app
