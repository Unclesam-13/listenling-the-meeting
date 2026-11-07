#!/bin/bash
# 下载网页版用到的第三方库，放进 mobile/vendor/（同源加载，可离线使用）：
# PDF / Word 解析、Markdown 渲染、HTML 清理、公式渲染。手机版发布和 Mac 软件打包都会运行它。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
V="$ROOT/mobile/vendor"
TMP="$(mktemp -d)"
cd "$TMP"
npm init -y >/dev/null
npm install --no-audit --no-fund pdfjs-dist@3.11.174 mammoth@1.8.0 marked@12.0.2 dompurify@3.1.6 katex@0.16.11
mkdir -p "$V/katex"
cp node_modules/pdfjs-dist/build/pdf.min.js node_modules/pdfjs-dist/build/pdf.worker.min.js \
   node_modules/mammoth/mammoth.browser.min.js node_modules/marked/lib/marked.umd.js \
   node_modules/dompurify/dist/purify.min.js "$V/"
cp node_modules/katex/dist/katex.min.js node_modules/katex/dist/katex.min.css "$V/katex/"
rm -rf "$V/katex/fonts" && cp -r node_modules/katex/dist/fonts "$V/katex/fonts"
rm -rf "$TMP"
ls -la "$V" "$V/katex"
