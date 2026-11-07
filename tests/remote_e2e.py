"""手机同步端到端测试：Mac 软件里的会议助手页面 ←→ 局域网同步服务（desktop/remote-server.js）←→ 手机查看页面。

用 Node 运行同步服务（tests/remote_harness.js 代替 Electron 主进程），两个浏览器页面分别扮演电脑和手机：
手机扫码连上 → 手机点开始 → 电脑开始录音 → 字幕、回答实时出现在手机上 → 手机提问由电脑回答 →
手机点结束 → 会议总结出现在手机上；错误的令牌连不上。

    python tests/remote_e2e.py [站点目录，默认 mobile] [截图输出目录]
"""
import subprocess
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).parent))
import desktop_e2e as D  # noqa: E402  复用模拟的 Soniox / Claude

SITE, SHOTS = D.SITE, D.SHOTS

SHIM = """
window.mcDesktop = (() => {
  const B = "%s";
  let q = Promise.resolve();
  const cbs = [], ccbs = [];
  const es = new EventSource(B + "/cmds");
  es.onmessage = (e) => cbs.forEach(f => f(JSON.parse(e.data)));
  es.addEventListener("clients", (e) => ccbs.forEach(f => f(Number(e.data))));
  return Object.freeze({
    platform: "darwin", version: "test",
    remote: async () => (await fetch(B + "/info")).json(),
    sync: (type, data) => { const body = JSON.stringify({ type, data }); q = q.then(() => fetch(B + "/sync", { method: "POST", body }).catch(() => {})); },
    onRemote: (f) => cbs.push(f), onRemoteClients: (f) => ccbs.push(f),
  });
})();
"""


def main():
    harness = subprocess.Popen(["node", str(Path(__file__).parent / "remote_harness.js"), str(SITE)], stdout=subprocess.PIPE, text=True)
    control = f"http://127.0.0.1:{harness.stdout.readline().strip()}"
    srv, base = D.serve(SITE)
    errors = []
    try:
        with sync_playwright() as p:
            b = p.chromium.launch(args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"])
            # 电脑
            dctx = b.new_context(viewport={"width": 1000, "height": 800}, permissions=["microphone"], locale="zh-CN")
            dctx.route("https://api.anthropic.com/**", D.on_claude)
            dctx.route("https://api.soniox.com/**", lambda r: r.fulfill(status=404, headers=D.CORS))
            dctx.route_web_socket("wss://stt-rt.soniox.com/**", D.on_ws)
            dctx.add_init_script(SHIM % control)
            dctx.add_init_script("""try { if (!localStorage.getItem('mc.settings.v1')) localStorage.setItem('mc.settings.v1', JSON.stringify({
                sonioxKey: 'sx-test', claudeKey: 'sk-ant-test', intentProvider: 'rules', autoIndex: false, settleMs: 300 })); } catch (e) {}""")
            desk = dctx.new_page()
            desk.on("pageerror", lambda e: errors.append("电脑: " + str(e)))
            desk.goto(base)
            desk.wait_for_selector("#phoneBtn:not([hidden])")
            desk.click("#phoneBtn")
            desk.wait_for_function("document.getElementById('phoneUrl').textContent.includes('/remote.html?t=')", timeout=5000)
            url = desk.inner_text("#phoneUrl")
            if (SITE / "vendor" / "qrcode.js").exists():
                desk.wait_for_selector("#qrBox svg", timeout=5000)  # 二维码
            desk.screenshot(path=SHOTS / "r1-电脑二维码.png")
            desk.click("#phoneSheet [data-close]")

            # 手机
            pctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True, locale="zh-CN")
            phone = pctx.new_page()
            phone.on("pageerror", lambda e: errors.append("手机: " + str(e)))
            phone.goto(url)
            phone.wait_for_function("window.__mr.connected && window.__mr.st", timeout=5000)
            desk.wait_for_function("document.getElementById('phoneBtnLabel').textContent === '手机 1'", timeout=5000)
            assert "已连接电脑" in phone.inner_text("#tab-answers")
            phone.screenshot(path=SHOTS / "r2-手机已连接.png")

            # 手机点开始 -> 电脑开始录音
            phone.click("#recBtn")
            desk.wait_for_function("window.__mc.rec.on", timeout=8000)
            phone.wait_for_function("document.getElementById('recLabel').textContent === '结束'", timeout=5000)
            # 字幕和回答实时到手机
            phone.wait_for_function("window.__mr.st.M.lines.some(l => l.text.includes('implementation'))", timeout=8000)
            phone.wait_for_selector("#tab-answers .card .body:has-text('4 到 6 周')", timeout=8000)
            assert "How long does implementation take?" in phone.inner_text("#tab-answers .card.latest .q")
            phone.click(".tabs button[data-tab=captions]")
            assert "实施需要多长时间" in phone.inner_text("#lines")
            phone.screenshot(path=SHOTS / "r3-手机字幕.png")

            # 手机提问 -> 电脑回答
            phone.fill("#askText", "企业版多少钱？")
            phone.click("#askForm button")
            desk.wait_for_function("window.__mc.M.answers.some(a => a.question === '企业版多少钱？' && a.asker === '手机提问')", timeout=5000)
            phone.wait_for_function("window.__mr.st.M.answers.some(a => a.question === '企业版多少钱？' && a.done)", timeout=8000)
            assert "手机提问" in phone.inner_text("#tab-answers .card.latest .q")
            phone.screenshot(path=SHOTS / "r4-手机回答.png")

            # 电脑上改名，手机同步
            desk.evaluate("window.__mc.M.names.spk1 = '王总'")
            desk.click(".tabs button[data-tab=captions]")
            desk.click("#lines .who[data-sid=spk1]")
            desk.click("#speakerForm .sheet-foot button")
            phone.click(".tabs button[data-tab=captions]")
            phone.wait_for_function("document.getElementById('lines').textContent.includes('王总')", timeout=5000)

            # 手机点结束 -> 电脑结束 -> 生成总结 -> 手机看到总结
            phone.click("#recBtn")
            desk.wait_for_function("!window.__mc.rec.on", timeout=8000)
            desk.click(".tabs button[data-tab=summary]")
            desk.click("#sumGen")  # 只说了一句，不会自动生成，手动生成一次
            phone.wait_for_function("window.__mr.st.M.summary && !window.__mr.st.summarizing", timeout=10000)
            phone.click(".tabs button[data-tab=summary]")
            assert phone.inner_text("#sumBody").strip(), "手机上应显示会议总结"
            phone.screenshot(path=SHOTS / "r5-手机总结.png")

            # 新连上的手机拿到完整记录
            p2 = pctx.new_page()
            p2.goto(url)
            p2.wait_for_function("window.__mr.st && window.__mr.st.M.answers.length === 2 && window.__mr.st.M.summary", timeout=5000)
            p2.close()

            # 错误的令牌：连不上
            bad = pctx.new_page()
            bad.goto(url.split("?t=")[0] + "?t=wrong")
            bad.wait_for_function("!document.getElementById('banner').hidden && document.getElementById('banner').textContent.includes('连不上')", timeout=8000)
            assert bad.evaluate("window.__mr.st") is None
            bad.close()
            b.close()
    finally:
        harness.terminate()
        srv.shutdown()
    cmds = [l for l in (harness.stdout.read() or "").splitlines() if l.startswith("CMD")]
    bad = [e for e in errors]
    assert not bad, bad
    print(f"remote e2e ok | 手机发来的操作 {len(cmds)} 个 | 截图 {SHOTS}")


if __name__ == "__main__":
    main()
