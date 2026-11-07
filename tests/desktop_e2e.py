"""Mac 软件模式的端到端测试：页面里有 window.mcDesktop 时（由 Electron 外壳提供），
设置里出现「录音（Mac）」，选了会议软件的声音后分两路识别：
  - 麦克风那一路：关闭说话人区分，全部标成"我"，不触发自动回答
  - 会议声音那一路：照常区分说话人，对方提问时自动回答

    python tests/desktop_e2e.py [站点目录，默认 mobile] [截图输出目录]
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
HAS_RICH = (SITE / "vendor" / "marked.umd.js").exists()
CORS = {"access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST, OPTIONS"}
LOG = {"configs": [], "frames": {}, "ends": 0, "answers": 0}


def serve(directory):
    class Quiet(SimpleHTTPRequestHandler):
        def log_message(self, *a):
            pass
    srv = ThreadingHTTPServer(("127.0.0.1", 0), partial(Quiet, directory=str(directory)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://localhost:{srv.server_address[1]}/"


def T(text, **kw):
    return {"text": text, "is_final": True, **kw}


def on_ws(ws):
    state = {"ch": None}

    def handle(msg):
        if isinstance(msg, (bytes, bytearray)):
            LOG["frames"][state["ch"]] = LOG["frames"].get(state["ch"], 0) + 1
            return
        if msg == "":
            LOG["ends"] += 1
            ws.send(json.dumps({"tokens": [], "finished": True}))
            ws.close()
            return
        cfg = json.loads(msg)
        LOG["configs"].append(cfg)
        me = cfg["enable_speaker_diarization"] is False
        state["ch"] = "me" if me else "main"
        if me:  # 我的麦克风：没有说话人编号；这句话带问号，但不应触发回答
            ws.send(json.dumps({"tokens": [{"text": "我们下周", "is_final": False}]}))
            ws.send(json.dumps({"tokens": [T("我们下周三交付，", language="zh"), T("可以吗？", language="zh"),
                                           T("We will deliver next Wednesday, OK?", translation_status="translation"), T("<end>")]}))
        else:   # 会议软件里的对方
            ws.send(json.dumps({"tokens": [{"text": "How long", "is_final": False, "speaker": "1"}]}))
            ws.send(json.dumps({"tokens": [T("How long does implementation take?", speaker="1", language="en"),
                                           T("实施需要多长时间？", translation_status="translation", speaker="1"), T("<end>")]}))
    ws.on_message(handle)


def on_claude(route):
    req = route.request
    if req.method == "OPTIONS":
        return route.fulfill(status=204, headers=CORS)
    body = json.loads(req.post_data or "{}")
    if not body.get("stream"):
        return route.fulfill(status=200, headers={**CORS, "content-type": "application/json"},
                             body=json.dumps({"content": [{"type": "text", "text": "实施, implementation"}]}))
    LOG["answers"] += 1
    ev = [{"type": "message_start", "message": {"id": "m"}},
          {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "**结论**：标准实施周期 4 到 6 周。"}},
          {"type": "message_stop"}]
    route.fulfill(status=200, headers={**CORS, "content-type": "text/event-stream"},
                  body="".join(f"event: {e['type']}\ndata: {json.dumps(e, ensure_ascii=False)}\n\n" for e in ev))


def main():
    srv, base = serve(SITE)
    errors = []
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"])
        ctx = b.new_context(viewport={"width": 900, "height": 900}, permissions=["microphone"], locale="zh-CN")
        ctx.route("https://api.anthropic.com/**", on_claude)
        ctx.route("https://api.soniox.com/**", lambda r: r.fulfill(status=404, headers=CORS))
        ctx.route_web_socket("wss://stt-rt.soniox.com/**", on_ws)
        ctx.add_init_script("window.mcDesktop = Object.freeze({ platform: 'darwin', version: 'test' });")
        ctx.add_init_script("""try { if (!localStorage.getItem('mc.settings.v1')) localStorage.setItem('mc.settings.v1', JSON.stringify({
            sonioxKey: 'sx-test', claudeKey: 'sk-ant-test', intentProvider: 'rules', autoIndex: false, settleMs: 300 })); } catch (e) {}""")
        page = ctx.new_page()
        page.on("console", lambda m: m.type == "error" and errors.append(m.text))
        page.on("pageerror", lambda e: errors.append(str(e)))

        page.goto(base)
        page.wait_for_selector("body.desktop")

        # 1) 设置：出现「录音（Mac）」，列出录音设备
        page.click("#settingsBtn")
        assert page.is_visible("#desktopAudio")
        assert "这台电脑" in page.inner_text("#settingsForm .note")
        page.wait_for_function("document.querySelector('#settingsForm [name=sysDevice]').options.length > 1", timeout=5000)
        opts = page.evaluate("[...document.querySelector('#settingsForm [name=sysDevice]').options].map(o => [o.value, o.text])")
        assert opts[0][0] == "" and "不录" in opts[0][1], opts
        assert page.is_visible("#bhHint"), "没有 BlackHole 时应提示安装"
        dev = opts[1][0]
        page.select_option("#settingsForm [name=sysDevice]", dev)
        page.screenshot(path=SHOTS / "d1-设置.png")
        page.click("#settingsForm .sheet-foot button")
        assert page.evaluate("window.__mc.S.sysDevice") == dev

        # 2) 开始：两路识别
        page.click("#recBtn")
        page.wait_for_function("window.__mc.rec.on && window.__mc.rec.chans.length === 2", timeout=8000)
        assert len(LOG["configs"]) == 2
        refs = sorted(c["client_reference_id"] for c in LOG["configs"])
        assert refs == ["meeting-copilot-mac-main", "meeting-copilot-mac-me"], refs
        page.click(".tabs button[data-tab=captions]")
        page.wait_for_function("window.__mc.M.lines.length >= 2", timeout=8000)
        lines = page.evaluate("window.__mc.M.lines.map(l => [l.sid, l.text])")
        assert ["me", "我们下周三交付，可以吗？"] in lines, lines
        assert ["spk1", "How long does implementation take?"] in lines, lines
        assert page.evaluate("window.__mc.M.me") == ["me"]
        assert page.evaluate("window.__mc.M.names.me") == "我"
        assert "我" in page.inner_text("#lines")

        # 3) 只回答对方的问题
        page.wait_for_function("window.__mc.M.answers.length >= 1 && window.__mc.M.answers[0].text.includes('4 到 6 周')", timeout=8000)
        page.wait_for_timeout(800)
        qs = page.evaluate("window.__mc.M.answers.map(a => a.question)")
        assert qs == ["How long does implementation take?"], qs
        page.wait_for_timeout(500)  # 让两路都送几帧音频
        assert LOG["frames"].get("me", 0) > 0 and LOG["frames"].get("main", 0) > 0, LOG["frames"]
        page.screenshot(path=SHOTS / "d2-两路字幕.png")

        # 4) 结束：两路都断开
        page.click("#recBtn")
        page.wait_for_function("!window.__mc.rec.on", timeout=8000)
        assert LOG["ends"] == 2, LOG["ends"]
        assert page.evaluate("window.__mc.rec.chans.length") == 0

        # 5) 选回「不录」：只开一路，照常区分说话人
        page.click("#settingsBtn")
        page.select_option("#settingsForm [name=sysDevice]", "")
        page.click("#settingsForm .sheet-foot button")
        n = len(LOG["configs"])
        page.click("#recBtn")
        if page.is_visible("#continueSheet"):
            page.click("#continueSheet [data-choice=new]")
        page.wait_for_function("window.__mc.rec.on", timeout=8000)
        assert len(LOG["configs"]) == n + 1 and LOG["configs"][-1]["enable_speaker_diarization"] is True
        page.click("#recBtn")
        page.wait_for_function("!window.__mc.rec.on", timeout=8000)
        b.close()
    srv.shutdown()
    bad = [e for e in errors if "favicon" not in e and "404" not in e and (HAS_RICH or "Failed to load resource" not in e)]
    assert not bad, bad
    print(f"desktop e2e ok | 两路配置 {len(LOG['configs'])} 次 | 音频帧 {LOG['frames']} | 回答 {LOG['answers']} 次 | 截图 {SHOTS}")


if __name__ == "__main__":
    main()
