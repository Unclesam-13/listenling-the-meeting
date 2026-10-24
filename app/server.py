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
from .speakers import SpeakerTracker

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
        self.status["llm"] = "Claude 已连接" if self.brain.llm_ready else "未配置（仅展示资料片段）"
        self.status["intent"] = self.brain.intent.label
        self.speakers = SpeakerTracker(cfg.get("speakers", {})) if self.audio_enabled else SpeakerTracker({"enabled": False})
        self.asr = None
        self.capture = None
        self.loop: asyncio.AbstractEventLoop | None = None
        self.utt_q: asyncio.Queue = asyncio.Queue()
        self.pending: dict[str, dict] = {}   # 每个说话人正在说的一"轮"话
        self.last_q: tuple[str, float] = ("", 0.0)
        self.seq = 0

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
                "kb": self.kb.stats(), "clients": len(self.clients)}

    def _id(self) -> str:
        self.seq += 1
        return f"{int(time.time()*1000)}-{self.seq}"

    # ---------------- 启动 ----------------
    async def start(self):
        self.loop = asyncio.get_running_loop()
        asyncio.create_task(self._init_kb())
        asyncio.create_task(self._asr_worker())
        if self.audio_enabled:
            asyncio.create_task(self._init_audio())
        else:
            self.status.update(asr="已关闭（测试模式）", audio="已关闭（测试模式）")

    async def _init_kb(self):
        info = await asyncio.to_thread(self.kb.build)
        mode = "语义+关键词" if info["vector"] else "仅关键词"
        await self.set_status(kb=f"{info['files']} 个文件 / {info['chunks']} 段（{mode}）")

    async def _init_audio(self):
        try:
            await self.set_status(asr="模型加载中（首次需下载）…")
            from .asr import ASR
            self.asr = await asyncio.to_thread(ASR, self.cfg["asr"])
            await asyncio.to_thread(self.asr.warmup)
            await self.set_status(asr=f"就绪（{self.asr.backend}）")
        except Exception as e:
            log.exception("ASR 初始化失败")
            await self.set_status(asr=f"失败：{e}")
            return
        try:
            from .audio import AudioCapture
            self.capture = AudioCapture(self.cfg["audio"], self._on_utterance_thread)
            names = await asyncio.to_thread(self.capture.start)
            label = {"me": "我", "others": "对方", "room": "会议室"}
            await self.set_status(audio="录音中：" + "，".join(f"{label[k]}←{v}" for k, v in names.items()))
        except Exception as e:
            log.exception("音频启动失败")
            await self.set_status(audio=f"失败：{e}")

    def _on_utterance_thread(self, utt):
        # 在音频线程里被调用，转交给事件循环
        self.loop.call_soon_threadsafe(self.utt_q.put_nowait, utt)

    def stop(self):
        if self.capture:
            self.capture.stop()

    # ---------------- 识别 ----------------
    def _context(self) -> list[str]:
        return [f"{self.speakers.name(t['sid'])}: {t['text']}" for t in self.transcript[-12:]]

    async def _asr_worker(self):
        while True:
            utt = await self.utt_q.get()
            try:
                ctx = " ".join(t["text"] for t in self.transcript[-3:])
                text = await asyncio.to_thread(self.asr.transcribe, utt.audio, ctx)
                if not text:
                    continue
                sid = await asyncio.to_thread(self.speakers.assign, utt.channel, utt.audio)
                await self.add_line(sid, text, utt.channel)
            except Exception:
                log.exception("识别出错")

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
        hits = await asyncio.to_thread(self.kb.search, question)
        sources = []
        for h in hits:
            label = h["source"] + (f" p{h['page']}" if h.get("page") else "")
            if label not in sources:
                sources.append(label)
        ans = {"id": aid, "question": question, "raw": raw, "asker": asker, "origin": origin,
               "sources": sources, "text": "", "ts": time.time(), "done": False}
        self.answers.append(ans)
        self.answers = self.answers[-100:]
        await self.broadcast({"type": "answer_start", **ans})
        async for delta in self.brain.answer(question, hits, self._context()):
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
