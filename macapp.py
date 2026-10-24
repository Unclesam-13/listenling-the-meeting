"""Mac 应用入口（打包成 会议助手.app 时使用）。

启动后：后台运行服务 -> 自动打开电脑页面；菜单栏出现「会」图标，可以重新打开页面、打开资料库、退出。
所有数据在 ~/会议助手（配置、资料库、API Key、日志）。
"""
import logging
import os
import socket
import subprocess
import sys
import threading
import time
import webbrowser

# PyInstaller 打包后的 SSL 证书：让 https / wss 连接能验证证书
try:
    import certifi
    os.environ.setdefault("SSL_CERT_FILE", certifi.where())
except Exception:
    pass

import rumps
import uvicorn

from app.config import ROOT, ensure_data_dir, load_config, load_env

PORT_START = 8765


def free_port(start: int) -> int:
    for p in range(start, start + 20):
        with socket.socket() as s:
            try:
                s.bind(("0.0.0.0", p))
                return p
            except OSError:
                continue
    return start


class CopilotApp(rumps.App):
    def __init__(self):
        super().__init__("会议助手", title="会", quit_button=None)
        ensure_data_dir()
        (ROOT / "logs").mkdir(exist_ok=True)
        logging.basicConfig(level=logging.INFO, filename=ROOT / "logs" / "app.log",
                            format="%(asctime)s %(name)s: %(message)s")
        load_env()
        cfg = load_config()
        cfg["server"]["port"] = free_port(cfg["server"].get("port", PORT_START))
        self.url = f"http://127.0.0.1:{cfg['server']['port']}/"

        from app.server import create_app
        app = create_app(cfg)
        self.copilot = app.state.copilot
        self.server = uvicorn.Server(uvicorn.Config(app, host=cfg["server"]["host"], port=cfg["server"]["port"],
                                                    log_level="warning", log_config=None))
        threading.Thread(target=self.server.run, daemon=True).start()

        self.menu = [
            rumps.MenuItem("打开会议助手", callback=self.open_page),
            rumps.MenuItem("打开资料库文件夹", callback=self.open_kb),
            None,
            rumps.MenuItem("打开数据文件夹（配置、日志）", callback=self.open_data),
            rumps.MenuItem("使用说明", callback=self.open_help),
            None,
            rumps.MenuItem("退出会议助手", callback=self.quit),
        ]
        threading.Thread(target=self._open_when_ready, daemon=True).start()

    def _open_when_ready(self):
        for _ in range(100):
            if self.server.started:
                webbrowser.open(self.url)
                return
            time.sleep(0.1)

    def open_page(self, _=None):
        webbrowser.open(self.url)

    def open_kb(self, _=None):
        subprocess.Popen(["open", str(ROOT / "knowledge")])

    def open_data(self, _=None):
        subprocess.Popen(["open", str(ROOT)])

    def open_help(self, _=None):
        webbrowser.open("https://github.com/Unclesam-13/listenling-the-meeting#readme")

    def quit(self, _=None):
        self.server.should_exit = True
        try:
            self.copilot.stop()
        except Exception:
            pass
        rumps.quit_application()


def selftest():
    """打包后检查：所有依赖能导入、资料库能加载、页面文件在。"""
    import asyncio
    import anthropic, httpx, jieba, pypdf, docx, qrcode, qrcode.image.svg, sounddevice, websockets  # noqa
    from app.config import BUNDLE
    from app.kb import KnowledgeBase
    from app.server import WEB, create_app
    assert (WEB / "desktop.html").exists() and (WEB / "phone.html").exists(), "缺少页面文件"
    kb = KnowledgeBase({"dir": str(BUNDLE / "knowledge")})
    info = kb.build()
    assert info["files"] >= 1 and kb.search("数据存储 data security"), "资料库检索失败"
    create_app(load_config(str(BUNDLE / "config.yaml")), audio_enabled=False)
    print("selftest ok:", info, "portaudio", sounddevice.get_portaudio_version()[1])


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
        sys.exit(0)
    CopilotApp().run()
