"""外观测试：深色模式、字幕大小、大字幕（横屏自动进入、竖屏手动进入）。

    python tests/view_e2e.py [站点目录，默认 mobile] [截图输出目录]
"""
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).parent))
import desktop_e2e as D  # noqa: E402  复用模拟的 Soniox / Claude

SITE, SHOTS = D.SITE, D.SHOTS
PORTRAIT = {"width": 390, "height": 844}
LANDSCAPE = {"width": 844, "height": 390}


def main():
    srv, base = D.serve(SITE)
    errors = []
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"])
        ctx = b.new_context(viewport=PORTRAIT, device_scale_factor=2, is_mobile=True, has_touch=True,
                            permissions=["microphone"], locale="zh-CN", color_scheme="light")
        ctx.route("https://api.anthropic.com/**", D.on_claude)
        ctx.route("https://api.soniox.com/**", lambda r: r.fulfill(status=404, headers=D.CORS))
        ctx.route_web_socket("wss://stt-rt.soniox.com/**", D.on_ws)
        ctx.add_init_script("""try { if (!localStorage.getItem('mc.settings.v1')) localStorage.setItem('mc.settings.v1', JSON.stringify({
            sonioxKey: 'sx-test', claudeKey: 'sk-ant-test', intentProvider: 'rules', autoIndex: false, settleMs: 300 })); } catch (e) {}""")
        page = ctx.new_page()
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(base)
        page.wait_for_selector("#recBtn")
        bg = lambda: page.evaluate("getComputedStyle(document.body).backgroundColor")
        light_bg = bg()

        # 录一段，产生字幕
        page.click("#recBtn")
        page.wait_for_function("window.__mc.M.lines.length >= 1", timeout=8000)
        page.click(".tabs button[data-tab=captions]")
        tx = lambda: page.evaluate("parseFloat(getComputedStyle(document.querySelector('#lines .line .tx')).fontSize)")

        # 1) 字幕大小（默认"大"），A+ / A−，记住设置
        s0 = tx()
        page.click("#capBigger")
        assert tx() > s0, (s0, tx())
        page.click("#capSmaller"); page.click("#capSmaller")
        assert tx() < s0
        page.click("#capBigger")
        assert abs(tx() - s0) < 0.1

        # 2) 深色：一键切换，记住设置
        page.click("#darkBtn")
        assert page.evaluate("document.documentElement.dataset.theme") == "dark"
        assert bg() != light_bg
        page.screenshot(path=SHOTS / "v1-深色字幕.png")

        # 3) 竖屏手动进入大字幕
        page.click("#stageBtn")
        assert page.evaluate("document.body.classList.contains('stage')")
        assert page.is_hidden("header.top") and page.is_visible("#stageBar")
        assert bg() == "rgb(0, 0, 0)"
        big = tx()
        assert big > s0 * 1.4, (big, s0)
        assert "录音中" in page.inner_text("#stageStatus")
        page.click("#stageBar [data-a=bigger]")
        assert tx() > big
        page.click("#stageBar [data-a=smaller]")
        page.screenshot(path=SHOTS / "v2-竖屏大字幕.png")
        page.click("#stageBar [data-a=exit]")
        assert not page.evaluate("document.body.classList.contains('stage')")
        assert page.is_visible("header.top")

        # 4) 横屏：在字幕页自动进入大字幕；回到竖屏自动退出
        page.set_viewport_size(LANDSCAPE)
        page.wait_for_function("document.body.classList.contains('stage')", timeout=3000)
        page.screenshot(path=SHOTS / "v3-横屏大字幕.png")
        # 横屏时点退出：这次横屏不再自动进入
        page.click("#stageBar [data-a=exit]")
        page.wait_for_timeout(200)
        assert not page.evaluate("document.body.classList.contains('stage')")
        page.set_viewport_size(PORTRAIT)
        page.wait_for_timeout(200)
        assert not page.evaluate("document.body.classList.contains('stage')")
        # 在回答页横屏：不进入
        page.click(".tabs button[data-tab=answers]")
        page.set_viewport_size(LANDSCAPE)
        page.wait_for_timeout(300)
        assert not page.evaluate("document.body.classList.contains('stage')")
        page.set_viewport_size(PORTRAIT)
        page.wait_for_timeout(200)
        page.click(".tabs button[data-tab=captions]")
        page.set_viewport_size(LANDSCAPE)
        page.wait_for_function("document.body.classList.contains('stage')", timeout=3000)
        page.set_viewport_size(PORTRAIT)
        page.wait_for_function("!document.body.classList.contains('stage')", timeout=3000)

        # 5) 刷新后深色和字号还在；设置里也能改
        page.click("#recBtn")
        page.wait_for_function("!window.__mc.rec.on", timeout=8000)
        page.reload()
        page.wait_for_selector("#recBtn")
        assert page.evaluate("document.documentElement.dataset.theme") == "dark"
        page.click("#settingsBtn")
        assert page.input_value("#themeSel") == "dark"
        page.select_option("#themeSel", "light")
        assert page.evaluate("document.documentElement.dataset.theme") == "light"
        page.select_option("#themeSel", "auto")
        assert page.evaluate("document.documentElement.dataset.theme") is None
        page.emulate_media(color_scheme="dark")
        assert bg() != light_bg  # 跟随系统
        b.close()
    srv.shutdown()
    bad = [e for e in errors]
    assert not bad, bad
    print(f"view e2e ok | 截图 {SHOTS}")


if __name__ == "__main__":
    main()
