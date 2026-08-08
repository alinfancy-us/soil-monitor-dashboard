#!/bin/bash

PORT=8000
NGROK_LOG="/tmp/ngrok.log"

# 1. 退出时清理后台进程
cleanup() {
    echo -e "\n[*] 正在关闭服务和 ngrok 隧道..."
    kill $HTTP_PID $NGROK_PID 2>/dev/null
    rm -f $NGROK_LOG
    echo "[✓] 已安全退出"
    exit 0
}
trap cleanup SIGINT SIGTERM

# 2. 启动本地网页服务 (监听 8000 端口)
echo "[*] 启动本地 HTTP 服务 (端口: $PORT)..."
python3 -m http.server $PORT > /dev/null 2>&1 &
HTTP_PID=$!

sleep 1

# 3. 后台运行 ngrok 并将日志输出到临时文件
echo "[*] 正在通过 ngrok 建立 HTTPS 隧道..."
ngrok http $PORT --log=stdout > $NGROK_LOG 2>&1 &
NGROK_PID=$!

# 4. 等待并提取 ngrok 生成的 HTTPS 访问链接
echo -n "[*] 等待公网地址生成"
HTTPS_URL=""
for i in {1..10}; do
    HTTPS_URL=$(grep -o 'https://[^"]*' $NGROK_LOG | head -n 1)
    if [ -n "$HTTPS_URL" ]; then
        break
    fi
    echo -n "."
    sleep 1
done

echo -e "\n"
if [ -n "$HTTPS_URL" ]; then
    echo "=================================================="
    echo " [✓] 本地服务地址: http://localhost:$PORT"
    echo " [✓] 外网 HTTPS 地址: $HTTPS_URL"
    echo "=================================================="
    echo "按 Ctrl+C 停止服务并关闭隧道..."
else
    echo "[!] 建立 ngrok 隧道失败，请检查 ngrok 是否配置了 authtoken。"
    cleanup
fi

# 5. 保持主进程运行
while true; do
    sleep 1
done