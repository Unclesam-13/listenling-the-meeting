#!/bin/bash
# 在 Mac 上打包「会议助手.app」和 DMG（GitHub Actions 会自动运行；也可以在自己的 Mac 上运行）：
#   ./tools/vendor_web.sh && VERSION=1.0.0 ./desktop/build_dmg.sh
set -euo pipefail
cd "$(dirname "$0")"

VERSION="${VERSION:-1.0.0}"
ARCH="$(uname -m)"
if [ "$ARCH" = "arm64" ]; then LABEL="AppleSilicon"; EB_ARCH="--arm64"; else LABEL="Intel"; EB_ARCH="--x64"; fi
DMG="dist/MeetingCopilot-v${VERSION}-${LABEL}.dmg"

[ -f ../mobile/vendor/marked.umd.js ] || { echo "缺少 mobile/vendor，请先运行 tools/vendor_web.sh"; exit 1; }
mkdir -p build && cp ../mobile/icons/icon-512.png build/icon.png
npm install --no-audit --no-fund
npm pkg set version="$VERSION"
rm -rf dist
npx electron-builder --mac dir "$EB_ARCH" --publish never

APP="$(find dist -maxdepth 2 -name '*.app' -type d | head -1)"
[ -d "$APP" ] || { echo "打包失败：没有生成 .app"; exit 1; }

# 自签名（ad-hoc）。没有 Apple 开发者证书时，用户第一次打开需在「系统设置 > 隐私与安全性」里点「仍要打开」
codesign --force --deep --sign - "$APP"
codesign --verify --deep "$APP"
/usr/libexec/PlistBuddy -c "Print :NSMicrophoneUsageDescription" "$APP/Contents/Info.plist"

# 自检：打开软件里的页面，确认页面、第三方库、同传页面都在，接口跨域已放开
"$APP/Contents/MacOS/MeetingCopilot" --selftest

# DMG：应用 + 「应用程序」快捷方式 + 说明
STAGE="dist/dmg"
rm -rf "$STAGE" && mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
cp DMG使用说明.txt "$STAGE/使用说明.txt"
hdiutil create -volname "会议助手" -srcfolder "$STAGE" -ov -format UDZO "$DMG"
echo "完成：$DMG"
