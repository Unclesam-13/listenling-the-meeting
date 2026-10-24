#!/usr/bin/env python3
"""启动会议助手。

    python run.py              正常启动（录音 + 识别）
    python run.py --no-audio   测试模式：不录音，可在电脑页面手动输入"模拟发言"测试问答
"""
import argparse
import logging
import os
import threading
import time
import webbrowser

import uvicorn

from app.config import load_config
from app.server import create_app


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=None)
    ap.add_argument("--no-audio", action="store_true", help="不录音，只测试问答流程")
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--port", type=int, default=None)
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s: %(message)s", datefmt="%H:%M:%S")
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    cfg = load_config(args.config)
    if args.port:
        cfg["server"]["port"] = args.port

    app = create_app(cfg, audio_enabled=not args.no_audio)
    cp = app.state.copilot
    local = f"http://127.0.0.1:{cfg['server']['port']}/"

    print("\n" + "=" * 60)
    print(f" 电脑端：{local}")
    print(f" 手机端：{cp.phone_url}")
    try:
        import qrcode
        q = qrcode.QRCode(border=1); q.add_data(cp.phone_url); q.print_ascii(invert=True)
    except Exception:
        pass
    print(" 手机需与电脑连接同一个 Wi-Fi。按 Ctrl+C 退出。")
    print("=" * 60 + "\n")

    if not args.no_browser:
        threading.Thread(target=lambda: (time.sleep(1.5), webbrowser.open(local)), daemon=True).start()
    uvicorn.run(app, host=cfg["server"]["host"], port=cfg["server"]["port"], log_level="warning")


if __name__ == "__main__":
    main()
