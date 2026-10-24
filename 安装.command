#!/bin/bash
# 会议助手 一键安装（双击运行）
# 会安装：Homebrew（如未安装）、Python 3.11、BlackHole 虚拟声卡、所有 Python 依赖，并预先下载识别模型。

cd "$(dirname "$0")" || exit 1
set -o pipefail

green() { printf "\033[32m%s\033[0m\n" "$1"; }
yellow() { printf "\033[33m%s\033[0m\n" "$1"; }
red() { printf "\033[31m%s\033[0m\n" "$1"; }
step() { echo; green "▶ $1"; }
fail() { red "✗ $1"; echo; read -r -p "按回车键关闭窗口…" _; exit 1; }

clear
echo "=============================================="
echo "        会议助手 Meeting Copilot 安装程序"
echo "=============================================="
echo "整个过程约 10–20 分钟（主要是下载模型），中途可能需要输入电脑开机密码。"

# ---------- 1. 芯片类型 ----------
ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ]; then
  green "检测到 Apple 芯片（$ARCH），使用 mlx-whisper"
else
  yellow "检测到 Intel 芯片（$ARCH），改用 faster-whisper（速度会慢一些）"
  sed -i '' 's/^  backend: mlx .*/  backend: faster-whisper/' config.yaml
  sed -i '' 's#^  model: mlx-community/whisper-large-v3-turbo#  model: large-v3-turbo#' config.yaml
fi

# ---------- 2. Xcode 命令行工具（编译部分依赖需要）----------
step "检查 Xcode 命令行工具"
if ! xcode-select -p >/dev/null 2>&1; then
  xcode-select --install >/dev/null 2>&1
  fail "已弹出安装窗口，请先点「安装」完成 Xcode 命令行工具，然后重新双击「安装.command」。"
fi
green "已安装"

# ---------- 3. Homebrew ----------
step "检查 Homebrew"
if ! command -v brew >/dev/null 2>&1; then
  for p in /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -x "$p" ] && eval "$("$p" shellenv)"; done
fi
if ! command -v brew >/dev/null 2>&1; then
  yellow "没有找到 Homebrew（Mac 上的软件安装工具）。"
  read -r -p "是否现在从官方网站 brew.sh 安装？[Y/n] " ans
  [[ "$ans" =~ ^[Nn] ]] && fail "需要 Homebrew 才能继续。也可以按 https://brew.sh 手动安装后再运行本程序。"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" || fail "Homebrew 安装失败"
  for p in /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -x "$p" ] && eval "$("$p" shellenv)"; done
fi
green "Homebrew 就绪"

# ---------- 4. Python 与 BlackHole ----------
step "安装 Python 3.11 和 BlackHole 虚拟声卡（如已安装会跳过）"
brew list python@3.11 >/dev/null 2>&1 || brew install python@3.11 || fail "Python 安装失败"
NEED_RESTART_AUDIO=0
if ! brew list --cask blackhole-2ch >/dev/null 2>&1; then
  brew install --cask blackhole-2ch || fail "BlackHole 安装失败"
  NEED_RESTART_AUDIO=1
fi
PY="$(brew --prefix python@3.11)/bin/python3.11"
[ -x "$PY" ] || fail "找不到 Python 3.11"

# ---------- 5. 虚拟环境与依赖 ----------
step "安装 Python 依赖（约 5 分钟）"
[ -d .venv ] || "$PY" -m venv .venv || fail "创建虚拟环境失败"
# shellcheck disable=SC1091
source .venv/bin/activate
pip install -q --upgrade pip
REQ=requirements.txt
if [ "$ARCH" != "arm64" ]; then
  sed 's/^mlx-whisper.*/faster-whisper/' requirements.txt > .requirements-intel.txt
  REQ=.requirements-intel.txt
fi
pip install -r "$REQ" || fail "依赖安装失败，请把上面的报错截图发给开发者。"
green "依赖安装完成"

# ---------- 6. API Key ----------
step "设置 Claude API Key"
if [ -f .env ] && grep -q "^ANTHROPIC_API_KEY=." .env; then
  green "已经设置过（保存在 .env 文件中，如需更换可直接编辑该文件）"
else
  echo "用于判断对方是否在提问、生成回答。在 https://console.anthropic.com 获取。"
  echo "（直接回车跳过：将只用规则判断问题，并直接显示资料原文）"
  read -r -s -p "请粘贴 API Key: " KEY; echo
  if [ -n "$KEY" ]; then
    echo "ANTHROPIC_API_KEY=$KEY" > .env
    chmod 600 .env
    green "已保存"
  else
    yellow "已跳过，之后可在项目文件夹的 .env 文件里添加：ANTHROPIC_API_KEY=你的Key"
  fi
fi

# ---------- 7. 预下载模型 ----------
step "预先下载语音识别和资料检索模型（约 3.5GB，只需一次）"
python - <<'EOF' || yellow "模型预下载未完成，第一次启动时会自动继续下载。"
import yaml
cfg = yaml.safe_load(open("config.yaml", encoding="utf-8"))
print("· 下载语音识别模型…", flush=True)
if cfg["asr"]["backend"] == "mlx":
    from huggingface_hub import snapshot_download
    snapshot_download(cfg["asr"]["model"])
else:
    from faster_whisper import WhisperModel
    WhisperModel(cfg["asr"]["model"], device="auto", compute_type="int8")
print("· 下载资料检索模型…", flush=True)
from sentence_transformers import SentenceTransformer
SentenceTransformer(cfg["kb"]["embed_model"])
print("· 下载声纹模型…", flush=True)
from resemblyzer import VoiceEncoder
VoiceEncoder(verbose=False)
print("完成")
EOF

chmod +x 启动会议助手.command 2>/dev/null

# ---------- 8. 声音设置 ----------
echo
echo "=============================================="
green "安装完成！"
echo "=============================================="
echo
echo "最后一步：设置声音，让程序能录到会议里对方的声音（只需做一次）"
echo "  1. 即将打开「音频 MIDI 设置」"
echo "  2. 点左下角「+」→「创建多输出设备」"
echo "  3. 勾选你的耳机/扬声器 和 BlackHole 2ch；耳机/扬声器设为主设备，BlackHole 勾选「漂移校正」"
echo "  4. 在 Zoom / Teams / 腾讯会议 的扬声器设置里，选这个「多输出设备」"
[ "$NEED_RESTART_AUDIO" = "1" ] && yellow "  （刚装好 BlackHole，如果列表里看不到它，请重启电脑后再设置）"
echo
echo "以后每次开会，双击「启动会议助手.command」即可。"
echo
open -a "Audio MIDI Setup" 2>/dev/null
read -r -p "按回车键关闭窗口…" _
