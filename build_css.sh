#!/bin/sh
# 中文：构建期编译 Tailwind 静态 CSS（取代 https://cdn.tailwindcss.com 运行时脚本）。
#       用法：./build_css.sh   （需要 node/npx；产物 page/css/tailwind.css）
#       index.html / page/js 的类名有变更后必须重新执行，否则新样式不生效。
set -e
cd "$(dirname "$0")"
npx -y tailwindcss@3.4.17 -c tailwind.config.js -i tailwind.input.css -o page/css/tailwind.css --minify
echo "OK: page/css/tailwind.css"
