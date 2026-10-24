"""配置、数据目录和 API Key。

- 开发/终端运行：数据目录 = 项目文件夹
- 打包成 Mac 应用（PyInstaller）：数据目录 = ~/会议助手（首次运行时从应用内复制默认配置和示例资料）
数据目录里：
  config.yaml     配置
  settings.json   页面「设置」里保存的选项（覆盖 config.yaml）
  .env            API Key
  knowledge/      资料库
  logs/           日志
"""
from __future__ import annotations

import json
import os
import shutil
import sys
from pathlib import Path

FROZEN = getattr(sys, "frozen", False)
BUNDLE = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent))  # 程序自带的文件
ROOT = Path.home() / "会议助手" if FROZEN else Path(__file__).resolve().parent.parent  # 用户数据

KEY_NAMES = ("SONIOX_API_KEY", "ANTHROPIC_API_KEY", "JEV_API_KEY")


def ensure_data_dir():
    ROOT.mkdir(parents=True, exist_ok=True)
    if not (ROOT / "config.yaml").exists():
        shutil.copy(BUNDLE / "config.yaml", ROOT / "config.yaml")
    kb = ROOT / "knowledge"
    if not kb.exists():
        shutil.copytree(BUNDLE / "knowledge", kb)


def _env_path() -> Path:
    return ROOT / ".env"


def load_env():
    """读取 .env；已在系统环境变量里设置的优先。"""
    p = _env_path()
    if not p.exists():
        return
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def save_env(updates: dict[str, str]):
    """更新 .env 里的 Key（空字符串表示不修改），并立即生效。"""
    p = _env_path()
    cur: dict[str, str] = {}
    if p.exists():
        for line in p.read_text(encoding="utf-8").splitlines():
            if "=" in line and not line.strip().startswith("#"):
                k, v = line.split("=", 1)
                cur[k.strip()] = v.strip()
    for k, v in updates.items():
        if v:
            cur[k] = v.strip()
            os.environ[k] = v.strip()
    p.write_text("".join(f"{k}={v}\n" for k, v in cur.items()), encoding="utf-8")
    os.chmod(p, 0o600)


def _settings_path() -> Path:
    return ROOT / "settings.json"


def load_settings() -> dict:
    try:
        return json.loads(_settings_path().read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_settings(updates: dict):
    s = load_settings()
    s.update(updates)
    _settings_path().write_text(json.dumps(s, ensure_ascii=False, indent=2), encoding="utf-8")


def load_config(path: str | None = None) -> dict:
    import yaml
    if FROZEN:
        ensure_data_dir()
    p = Path(path) if path else ROOT / "config.yaml"
    with open(p, "r", encoding="utf-8") as f:
        cfg = yaml.safe_load(f) or {}
    # 页面「设置」里保存的选项覆盖 config.yaml
    s = load_settings()
    audio = cfg.setdefault("audio", {})
    if "mic_device" in s:
        audio["mic_device"] = s["mic_device"] or None
    if "system_device" in s:
        audio["system_device"] = s["system_device"] or None
    if s.get("jev_url"):
        cfg.setdefault("intent", {}).setdefault("jev", {})["url"] = s["jev_url"]
    if s.get("intent_provider"):
        cfg.setdefault("intent", {})["provider"] = s["intent_provider"]

    cfg["_root"] = str(ROOT)
    kb_dir = Path(cfg.get("kb", {}).get("dir", "knowledge"))
    if not kb_dir.is_absolute():
        cfg.setdefault("kb", {})["dir"] = str(ROOT / kb_dir)
    return cfg
