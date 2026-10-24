#!/bin/bash
# 双击启动会议助手。关闭这个终端窗口即退出。
cd "$(dirname "$0")" || exit 1

if [ ! -d .venv ]; then
  echo "还没有安装，请先双击「安装.command」。"
  read -r -p "按回车键关闭窗口…" _
  exit 1
fi

# shellcheck disable=SC1091
source .venv/bin/activate
clear
echo "会议助手启动中…（第一次启动加载模型需要 1–2 分钟）"
echo "测试模式（不录音）：在终端运行  ./启动会议助手.command --no-audio"
echo
python run.py "$@"
echo
read -r -p "已退出，按回车键关闭窗口…" _
