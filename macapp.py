"""Mac 应用入口（打包成 会议助手.app 时使用）。

双击打开后：后台启动服务，并在「会议助手」原生窗口里显示界面（使用 macOS 自带的 WebKit，不经过浏览器）。
- Dock 栏有图标；顶部菜单栏「会议助手」菜单里可以打开资料库、数据文件夹、在浏览器中打开等
- 关闭窗口即退出程序
所有数据在 ~/会议助手（配置、资料库、API Key、日志）。
"""
import inspect
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

import uvicorn

from app.config import ROOT, ensure_data_dir, load_config, load_env

PORT_START = 8765
log = logging.getLogger("macapp")


def free_port(start: int) -> int:
    for p in range(start, start + 20):
        with socket.socket() as s:
            try:
                s.bind(("0.0.0.0", p))
                return p
            except OSError:
                continue
    return start


class Backend:
    """在后台线程运行服务。"""

    def __init__(self):
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

    def wait_ready(self, timeout=15) -> bool:
        end = time.time() + timeout
        while time.time() < end:
            if self.server.started:
                return True
            time.sleep(0.05)
        return False

    def shutdown(self):
        try:
            self.copilot.stop()
        except Exception:
            pass
        self.server.should_exit = True


def open_path(p):
    subprocess.Popen(["open", str(p)])


def build_menu(be: Backend):
    from webview.menu import Menu, MenuAction, MenuSeparator
    return [
        Menu("会议助手", [
            MenuAction("打开资料库文件夹", lambda: open_path(ROOT / "knowledge")),
            MenuAction("打开数据文件夹（配置、日志）", lambda: open_path(ROOT)),
            MenuSeparator(),
            MenuAction("在浏览器中打开", lambda: webbrowser.open(be.url)),
            MenuAction("使用说明", lambda: webbrowser.open("https://github.com/Unclesam-13/listenling-the-meeting#readme")),
        ]),
    ]


def main():
    import webview

    be = Backend()
    be.wait_ready()

    # 链接（如获取 API Key）在系统浏览器中打开，而不是在应用窗口里跳转
    try:
        webview.settings["OPEN_EXTERNAL_LINKS_IN_BROWSER"] = True
    except Exception:
        pass

    menu = build_menu(be)
    win_kwargs = dict(title="会议助手", url=be.url, width=1320, height=840, min_size=(900, 600),
                      text_select=True)
    start_kwargs = {}
    # pywebview 不同版本把菜单放在不同参数上，两种都兼容
    if "menu" in inspect.signature(webview.create_window).parameters:
        win_kwargs["menu"] = menu
    elif "menu" in inspect.signature(webview.start).parameters:
        start_kwargs["menu"] = menu

    webview.create_window(**win_kwargs)
    try:
        webview.start(**start_kwargs)   # 阻塞，直到窗口关闭
    finally:
        be.shutdown()
        time.sleep(0.3)


def selftest():
    """打包后检查：所有依赖能导入、资料库能加载、页面文件在。"""
    import anthropic, httpx, jieba, pypdf, docx, qrcode, qrcode.image.svg, sounddevice, websockets  # noqa
    import webview  # noqa
    from webview.menu import Menu, MenuAction  # noqa
    from app.config import BUNDLE
    from app.kb import KnowledgeBase
    from app.server import WEB, create_app
    assert (WEB / "desktop.html").exists() and (WEB / "phone.html").exists(), "缺少页面文件"
    kb = KnowledgeBase({"dir": str(BUNDLE / "knowledge")})
    info = kb.build()
    assert info["files"] >= 1 and kb.search("数据存储 data security"), "资料库检索失败"
    create_app(load_config(str(BUNDLE / "config.yaml")), audio_enabled=False)
    print("selftest ok:", info, "portaudio", sounddevice.get_portaudio_version()[1], "pywebview", webview.__version__ if hasattr(webview, "__version__") else "")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
        sys.exit(0)
    main()
