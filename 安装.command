#!/bin/bash
# 会议助手 一键安装（双击运行）
# 全部使用云端 API，不下载任何模型。会安装：Homebrew（如未安装）、Python、BlackHole 虚拟声卡、Python 依赖，
# 并让你填写 Soniox（语音识别）和至少一个大模型（Claude / ChatGPT / DeepSeek）的 API Key。

cd "$(dirname "$0")" || exit 1

green() { printf "\033[32m%s\033[0m\n" "$1"; }
yellow() { printf "\033[33m%s\033[0m\n" "$1"; }
red() { printf "\033[31m%s\033[0m\n" "$1"; }
step() { echo; green "▶ $1"; }
fail() { red "✗ $1"; echo; read -r -p "按回车键关闭窗口…" _; exit 1; }

clear
echo "=============================================="
echo "        会议助手 Meeting Copilot 安装程序"
echo "=============================================="
echo "大约需要 3–5 分钟，中途可能需要输入电脑开机密码。"

# ---------- 1. Homebrew ----------
step "检查 Homebrew"
for p in /opt/homebrew/bin/brew /usr/local/bin/brew; do
  [ -x "$p" ] && eval "$("$p" shellenv)"
done
if ! command -v brew >/dev/null 2>&1; then
  yellow "没有找到 Homebrew（Mac 上的软件安装工具）。"
  read -r -p "是否现在从官方网站 brew.sh 安装？[Y/n] " ans
  [[ "$ans" =~ ^[Nn] ]] && fail "需要 Homebrew 才能继续。也可以按 https://brew.sh 手动安装后再运行本程序。"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  for p in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    [ -x "$p" ] && eval "$("$p" shellenv)"
  done
  command -v brew >/dev/null 2>&1 || fail "Homebrew 安装失败"
fi
green "Homebrew 就绪"

# ---------- 2. Python（3.10 及以上即可）----------
step "检查 Python"
PY=""
for c in python3.12 python3.11 python3.10 python3.13; do
  for d in "$(brew --prefix)/bin" /usr/local/bin /opt/homebrew/bin; do
    if [ -x "$d/$c" ]; then PY="$d/$c"; break 2; fi
  done
done
if [ -z "$PY" ]; then
  # 注意：brew 安装 Python 时常常因为链接警告返回非 0，但其实已经装好，所以这里不看返回值，只看文件在不在
  brew install python@3.11
  PY="$(brew --prefix python@3.11 2>/dev/null)/bin/python3.11"
fi
[ -x "$PY" ] || fail "找不到 Python（3.10 或以上）。可以在终端运行 brew install python@3.11 后重试。"
green "使用 $PY（$("$PY" --version 2>&1)）"

# ---------- 3. BlackHole ----------
step "检查 BlackHole 虚拟声卡（用于录到会议里对方的声音）"
NEED_RESTART_AUDIO=0
if brew list --cask blackhole-2ch >/dev/null 2>&1 || [ -d "/Library/Audio/Plug-Ins/HAL/BlackHole2ch.driver" ]; then
  green "已安装"
else
  brew install --cask blackhole-2ch
  if [ -d "/Library/Audio/Plug-Ins/HAL/BlackHole2ch.driver" ]; then
    green "已安装"; NEED_RESTART_AUDIO=1
  else
    yellow "BlackHole 安装可能未完成。只开线下会议（不录会议软件的声音）可以忽略；否则请稍后在终端运行：brew install --cask blackhole-2ch"
  fi
fi

# ---------- 4. 虚拟环境与依赖 ----------
step "安装 Python 依赖（约 1–2 分钟）"
if [ -d .venv ] && ! .venv/bin/python -c "import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)" 2>/dev/null; then
  rm -rf .venv
fi
[ -d .venv ] || "$PY" -m venv .venv || fail "创建虚拟环境失败"
.venv/bin/python -m pip install -q --upgrade pip
.venv/bin/python -m pip install -q -r requirements.txt || fail "依赖安装失败，请把上面的报错截图发给开发者。"
green "依赖安装完成"

# ---------- 5. API Key ----------
touch .env && chmod 600 .env
set_key() {  # set_key 名称 说明 获取地址 是否必填
  local name="$1" desc="$2" url="$3" required="$4" val
  if grep -q "^$name=." .env; then
    green "$name 已设置（保存在 .env 文件中，如需更换可直接编辑该文件）"
    return
  fi
  echo
  echo "$desc"
  echo "获取地址：$url"
  [ "$required" = "1" ] || echo "（直接回车跳过）"
  read -r -s -p "请粘贴 $name: " val; echo
  if [ -n "$val" ]; then
    grep -v "^$name=" .env > .env.tmp; mv .env.tmp .env; chmod 600 .env
    echo "$name=$val" >> .env
    green "已保存"
  else
    yellow "已跳过，之后可在项目文件夹的 .env 文件里添加一行：$name=你的Key"
  fi
}
step "设置 API Key（只保存在本机的 .env 文件里）"
set_key SONIOX_API_KEY "① Soniox：实时语音识别（中英混说、区分说话人），约 0.12 美元/小时" "https://console.soniox.com" 1
echo; echo "② 回答问题用的大模型：Claude / ChatGPT / DeepSeek 至少填一个（之后也可以在页面「设置」里改）"
set_key ANTHROPIC_API_KEY "Claude" "https://console.anthropic.com" 0
set_key OPENAI_API_KEY "ChatGPT（OpenAI）" "https://platform.openai.com/api-keys" 0
set_key DEEPSEEK_API_KEY "DeepSeek" "https://platform.deepseek.com/api_keys" 0

chmod +x 启动会议助手.command 2>/dev/null

# ---------- 6. 声音设置 ----------
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
