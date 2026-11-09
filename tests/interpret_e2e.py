"""同声传译页面端到端测试：真实 Chromium + 模拟麦克风 + 模拟 OpenAI 同传（WebRTC 换成模拟连接）。

    python tests/interpret_e2e.py [站点目录，默认 mobile] [截图输出目录]
"""
import json
import sys
import tempfile
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

SITE = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).parent.parent / "mobile").resolve()
SHOTS = Path(sys.argv[2] if len(sys.argv) > 2 else tempfile.mkdtemp()).resolve()
SHOTS.mkdir(parents=True, exist_ok=True)
CORS = {"access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST, OPTIONS"}
LOG = {"secrets": [], "calls": []}

FAKE_RTC = """
window.__rtc = [];
window.__mcFakeRTC = class {
  constructor() { window.__rtc.push(this); this.connectionState = 'new'; this.sent = []; }
  addTrack(track) { this.track = track; }
  createDataChannel(name) { this.dc = { name, readyState: 'open', send: (m) => this.sent.push(m), onmessage: null }; return this.dc; }
  async createOffer() { return { type: 'offer', sdp: 'v=0 fake-offer' }; }
  async setLocalDescription(o) { this.local = o; }
  async setRemoteDescription(a) {
    this.remote = a;
    const ctx = new AudioContext(); const dst = ctx.createMediaStreamDestination();
    this.ontrack && this.ontrack({ streams: [dst.stream] });
  }
  ev(type, delta) { this.dc.onmessage({ data: JSON.stringify({ type, delta }) }); }
  close() { this.closed = true; }
};
"""


def serve(directory):
    class Quiet(SimpleHTTPRequestHandler):
        def log_message(self, *a):
            pass
    srv = ThreadingHTTPServer(("127.0.0.1", 0), partial(Quiet, directory=str(directory)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://localhost:{srv.server_address[1]}/"


def on_translate(route):
    req = route.request
    if req.method == "OPTIONS":
        return route.fulfill(status=204, headers=CORS)
    if req.url.endswith("/client_secrets"):
        body = json.loads(req.post_data or "{}")
        LOG["secrets"].append({"body": body, "auth": req.headers.get("authorization")})
        if req.headers.get("authorization") == "Bearer bad-key":
            return route.fulfill(status=401, headers={**CORS, "content-type": "application/json"},
                                 body=json.dumps({"error": {"message": "Incorrect API key provided"}}))
        lang = body["session"]["audio"]["output"]["language"]
        return route.fulfill(status=200, headers={**CORS, "content-type": "application/json"}, body=json.dumps({"value": f"ek_{lang}"}))
    LOG["calls"].append({"auth": req.headers.get("authorization"), "type": req.headers.get("content-type")})
    route.fulfill(status=201, headers={**CORS, "content-type": "application/sdp"}, body="v=0 fake-answer")


def main():
    srv, base = serve(SITE)
    errors = []
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"])
        ctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True,
                            permissions=["microphone"], locale="zh-CN")
        ctx.route("https://api.openai.com/v1/realtime/translations/**", on_translate)
        ctx.add_init_script(FAKE_RTC)
        # 会议助手里已经填过 OpenAI Key：同传页面应自动使用
        ctx.add_init_script("try { if (!localStorage.getItem('mc.settings.v1')) localStorage.setItem('mc.settings.v1', JSON.stringify({ openaiKey: 'sk-from-main' })); } catch (e) {}")
        page = ctx.new_page()
        page.on("console", lambda m: m.type == "error" and errors.append(m.text))
        page.on("pageerror", lambda e: errors.append(str(e)))

        page.goto(base + "interpret/")
        page.wait_for_selector("#goBtn")
        assert page.locator("#settingsSheet[hidden]").count() == 1, "已有会议助手的 Key，不应弹出设置"
        page.screenshot(path=SHOTS / "i1-首页.png")

        # 1) 外语 -> 中文（一路），自动使用会议助手的 Key
        page.click(".modes button[data-mode=to_me]")
        page.click("#goBtn")
        page.wait_for_function("window.__mi.st.on && window.__rtc.length === 1 && window.__rtc[0].remote", timeout=8000)
        s0 = LOG["secrets"][0]
        assert s0["auth"] == "Bearer sk-from-main" and s0["body"]["session"] == {"model": "gpt-realtime-translate", "audio": {"output": {"language": "zh"}}}, s0
        assert LOG["calls"][0]["type"] == "application/sdp" and LOG["calls"][0]["auth"] == "Bearer ek_zh"
        r0 = "window.__rtc[0]"
        page.evaluate(f"{r0}.ev('session.input_transcript.delta', 'Where is your data stored?')")
        page.evaluate(f"{r0}.ev('session.output_transcript.delta', '你们的数据')")
        page.evaluate(f"{r0}.ev('session.output_transcript.delta', '存在哪里？')")
        page.wait_for_selector(".bub.them")
        assert page.inner_text(".bub.them .tr") == "你们的数据存在哪里？"
        assert "Where is your data stored?" in page.inner_text(".bub.them .orig")
        assert page.evaluate("window.__mi.st.gated") is False  # 单向默认不暂停收音（戴耳机）
        page.click("#goBtn")
        page.wait_for_function("!window.__mi.st.on && window.__rtc[0].closed", timeout=5000)
        assert page.evaluate("window.__rtc[0].sent.some(m => m.includes('session.close'))")

        # 2) 双向：两路（zh + ja），播放时暂停收音
        page.click(".modes button[data-mode=two_way]")
        page.select_option("#otherLang", "ja")
        page.click("#goBtn")
        page.wait_for_function("window.__mi.st.on && window.__rtc.length === 3 && window.__rtc[1].remote && window.__rtc[2].remote", timeout=8000)
        langs = sorted(x["body"]["session"]["audio"]["output"]["language"] for x in LOG["secrets"][1:])
        assert langs == ["ja", "zh"], langs
        assert page.locator(".modes.locked").count() == 1  # 进行中不能改方向
        me = page.evaluate("window.__rtc.findIndex((r, i) => i > 0 && r.track && window.__mi.st.channels.find(c => c.side === 'me' && c.pc === r))")
        page.evaluate(f"window.__rtc[{me}].ev('session.input_transcript.delta', '我们下周三交付。')")
        page.evaluate(f"window.__rtc[{me}].ev('session.output_transcript.delta', '来週の水曜日に納品します。')")
        page.wait_for_selector(".bub.me")
        assert "来週" in page.inner_text(".bub.me .tr") and "下周三" in page.inner_text(".bub.me .orig")
        page.wait_for_function("window.__mi.st.gated === true", timeout=2000)
        assert page.evaluate("window.__mi.st.channels.every(c => c.track.enabled === false)")
        assert page.is_visible("#gate")
        page.wait_for_function("window.__mi.st.gated === false", timeout=3000)  # 播完恢复
        assert page.evaluate("window.__mi.st.channels.every(c => c.track.enabled === true)")
        # 两路都听同一个麦克风：模型会复述"已经是目标语言"的话。复述的那一路要静音、不显示
        them = page.evaluate("window.__rtc.findIndex((r, i) => i > 0 && window.__mi.st.channels.find(c => c.side === 'them' && c.pc === r))")
        ch = lambda side: f"window.__mi.st.channels.find(c => c.side === '{side}')"
        page.wait_for_timeout(1900)
        n_me, n_them = page.locator(".bub.me").count(), page.locator(".bub.them").count()
        # 我说中文：→中文 那路复述中文 —— 不显示、静音、也不暂停收音
        page.evaluate(f"window.__rtc[{them}].ev('session.input_transcript.delta', '价格下个月调整。')")
        page.evaluate(f"window.__rtc[{them}].ev('session.output_transcript.delta', '价格下个月调整。')")
        page.wait_for_timeout(300)
        assert page.locator(".bub.them").count() == n_them, "我说的中文不应被→中文那路复述"
        assert page.evaluate(f"{ch('them')}.audio.muted") is True
        assert page.evaluate("window.__mi.st.gated") is False, "静音的复述不应暂停收音"
        # 对方说英文：→日语 那路（翻给对方的）复述/翻译英文 —— 不显示、静音
        page.wait_for_timeout(1900)
        page.evaluate(f"window.__rtc[{me}].ev('session.input_transcript.delta', 'When will the price change?')")
        page.evaluate(f"window.__rtc[{me}].ev('session.output_transcript.delta', '価格はいつ変わりますか？')")
        page.wait_for_timeout(1500)
        assert page.locator(".bub.me").count() == n_me, "对方的话不应由翻给对方的那一路播放"
        assert page.evaluate(f"{ch('me')}.audio.muted") is True
        # 同一句英文，→中文 那路正常翻译、放出声音
        page.evaluate(f"window.__rtc[{them}].ev('session.input_transcript.delta', 'When will the price change?')")
        page.evaluate(f"window.__rtc[{them}].ev('session.output_transcript.delta', '价格什么时候调整？')")
        page.wait_for_function(f"document.querySelectorAll('.bub.them').length === {n_them + 1}", timeout=3000)
        assert page.evaluate(f"{ch('them')}.audio.muted") is False
        assert "价格什么时候调整" in page.locator(".bub.them").last.inner_text()
        page.screenshot(path=SHOTS / "i2-双向.png")
        page.click("#goBtn")
        page.wait_for_function("!window.__mi.st.on", timeout=5000)

        # 3) 导出、刷新后记录还在
        with page.expect_download() as dl:
            page.click("#exportBtn")
        txt = Path(dl.value.path()).read_text(encoding="utf-8")
        assert "对方 → 中文" in txt and "我 → 日本語" in txt and "来週の水曜日" in txt, txt
        page.reload()
        page.wait_for_selector(".bub.me")
        assert page.locator(".bub").count() == 3  # 结束后马上刷新，最后一句也要保存

        # 4) Key 错误：给出明确提示
        page.click("#settingsBtn")
        page.fill("#settingsForm input[name=openaiKey]", "bad-key")
        page.click("#settingsForm .sheet-foot button")
        page.click("#goBtn")
        page.wait_for_function("document.querySelector('#toast') && !document.querySelector('#toast').hidden && document.querySelector('#toast').textContent.includes('Key 无效')", timeout=5000)
        assert page.evaluate("!window.__mi.st.on")

        # 5) 深色模式截图
        page.emulate_media(color_scheme="dark")
        page.screenshot(path=SHOTS / "i3-深色.png")
        b.close()
    srv.shutdown()
    bad = [e for e in errors if "favicon" not in e and "401" not in e]
    assert not bad, bad
    print(f"interpret e2e ok | 同传会话 {len(LOG['secrets'])} 次 | 截图 {SHOTS}")


if __name__ == "__main__":
    main()
