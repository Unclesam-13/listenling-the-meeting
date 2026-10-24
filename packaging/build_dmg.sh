#!/bin/bash
# 在 Mac 上打包 会议助手.app 和 DMG。GitHub Actions 会自动运行它，也可以在自己的 Mac 上手动运行：
#   python3 -m venv .venv && source .venv/bin/activate
#   pip install -r requirements.txt -r packaging/requirements-mac.txt
#   VERSION=0.4.0 ./packaging/build_dmg.sh
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${VERSION:-0.0.0}"
ARCH="$(uname -m)"
[ "$ARCH" = "arm64" ] && LABEL="AppleSilicon" || LABEL="Intel"
DMG="dist/MeetingCopilot-v${VERSION}-${LABEL}.dmg"

rm -rf build dist
APP_VERSION="$VERSION" pyinstaller packaging/MeetingCopilot.spec --noconfirm --clean

APP="dist/会议助手.app"
[ -d "$APP" ] || { echo "打包失败：没有生成 $APP"; exit 1; }

# 自签名（ad-hoc）。没有 Apple 开发者证书时，用户首次打开需在「系统设置 > 隐私与安全性」里点「仍要打开」
codesign --force --deep --sign - "$APP"

# 冒烟测试：确认依赖都打包进去了
"$APP/Contents/MacOS/MeetingCopilot" --selftest

# 组装 DMG 内容：应用 + 「应用程序」快捷方式 + 说明
STAGE="dist/dmg"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
cp packaging/DMG使用说明.txt "$STAGE/使用说明.txt"

hdiutil create -volname "会议助手" -srcfolder "$STAGE" -ov -format UDZO "$DMG"
echo "完成：$DMG"
