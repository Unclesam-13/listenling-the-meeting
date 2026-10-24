from pathlib import Path
import yaml

ROOT = Path(__file__).resolve().parent.parent


def load_config(path: str | None = None) -> dict:
    p = Path(path) if path else ROOT / "config.yaml"
    with open(p, "r", encoding="utf-8") as f:
        cfg = yaml.safe_load(f) or {}
    cfg["_root"] = str(ROOT)
    kb_dir = Path(cfg.get("kb", {}).get("dir", "knowledge"))
    if not kb_dir.is_absolute():
        cfg.setdefault("kb", {})["dir"] = str(ROOT / kb_dir)
    return cfg
