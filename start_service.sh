#!/bin/bash
# 用法: ./start_service.sh [固件tag] [升级说明]
#   固件tag 可选，如 v1.2.1 或 1.2.1；提供时从固件仓库 alinfancy-us/bth_soil_sensor 的
#   Release 下载 SoilPulse_v<tag>.bin 到 page/firmware/ 并同步生成 firmware.json（参考 CI dev.yml 逻辑）。
#   私有仓库需通过环境变量 FW_REPO_TOKEN（或 GH_TOKEN）提供 GitHub Token，
#   或写入本目录 .fw_token / 家目录 ~/.fw_repo_token 文件（仅本地保存，勿提交）。
#   升级说明 可选，写入 firmware.json 的 notes 字段，默认 "test firmware"。
#   不带参数时行为与原脚本一致，仅启动本地服务与 ngrok 隧道。

# 获取脚本所在的绝对路径，确保无论在哪执行，都以脚本所在目录为准
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

PORT=8000
NGROK_LOG="/tmp/ngrok.log"

# 固件仓库路径与认证 Token（可用环境变量覆盖）
FW_REPO_PATH="${FW_REPO_PATH:-alinfancy-us/bth_soil_sensor}"
FW_TOKEN="${FW_REPO_TOKEN:-${GH_TOKEN:-}}"

# Token 兜底：环境变量未设置时，依次尝试从本地 token 文件读取（勿提交到仓库）
#   1) 脚本同目录 .fw_token     2) 家目录 ~/.fw_repo_token
if [ -z "$FW_TOKEN" ] && [ -f "$SCRIPT_DIR/.fw_token" ]; then
    FW_TOKEN=$(tr -d ' 	
' < "$SCRIPT_DIR/.fw_token")
fi
if [ -z "$FW_TOKEN" ] && [ -f "$HOME/.fw_repo_token" ]; then
    FW_TOKEN=$(tr -d ' 	
' < "$HOME/.fw_repo_token")
fi

# ===== 固件拉取与 firmware.json 同步（参考 .github/workflows/dev.yml 的 Release 回退逻辑） =====
# $1: release tag（v1.2.1 / 1.2.1 均可），$2: 升级说明（可选）
sync_firmware() {
    local FW_RAW_TAG="$1"
    local FW_RAW_NOTES="$2"

    # 规范化 release tag：去掉可能输入的 v 前缀后统一补回，得到 v2.1.1 形式
    local FW_NUM="${FW_RAW_TAG#[vV]}"
    if [ -z "$FW_NUM" ]; then
        echo "[!] 无效的固件 tag: '$FW_RAW_TAG'，示例: ./start_service.sh v1.2.1"
        exit 1
    fi
    local FW_TAG="v${FW_NUM}"
    local FW_BIN="SoilPulse_${FW_TAG}.bin"

    mkdir -p page/firmware

    # 通过 GitHub API 定位 Release 中名为 SoilPulse_v<tag>.bin 的资产下载地址
    # （用 API 而非直链，私有仓库带 Token 也能下载；gh cli 本机未必安装，故用 curl）
    echo "[*] 正在从 ${FW_REPO_PATH} Release ${FW_TAG} 拉取固件 ${FW_BIN} ..."
    local API_URL="https://api.github.com/repos/${FW_REPO_PATH}/releases/tags/${FW_TAG}"
    local AUTH_HEADER=()
    if [ -n "$FW_TOKEN" ]; then
        AUTH_HEADER=(-H "Authorization: Bearer $FW_TOKEN")
    fi

    local RELEASE_JSON="/tmp/soil_release_${FW_TAG}.json"
    if ! curl --fail --location --silent --show-error --retry 3 \
        "${AUTH_HEADER[@]}" --output "$RELEASE_JSON" "$API_URL"; then
        rm -f "$RELEASE_JSON"
        echo "[!] 获取 Release ${FW_TAG} 失败：网络不通（超时/需代理）、tag 不存在，或私有仓库未提供有效 Token。"
        echo "    Token 配置（任选其一）：export FW_REPO_TOKEN=<ghp_开头Token>；或写入 $SCRIPT_DIR/.fw_token / ~/.fw_repo_token"
        echo "    网络配置：如需代理可 export https_proxy=http://127.0.0.1:<代理端口> 后重试"
        exit 1
    fi

    # 从 Release JSON 中解析目标资产的 id 与 browser_download_url（用 python3 解析，避免依赖 jq）
    local ASSET_ID DOWNLOAD_URL
    eval $(FW_BIN="$FW_BIN" python3 -c '
import json, os, sys
try:
    release = json.load(open(os.environ.get("RELEASE_JSON", sys.argv[1])))
except Exception:
    sys.exit(1)
for asset in release.get("assets", []):
    if asset.get("name") == os.environ["FW_BIN"]:
        print("ASSET_ID=%d; DOWNLOAD_URL=%s" % (asset["id"], asset["browser_download_url"]))
        break
' "$RELEASE_JSON")
    rm -f "$RELEASE_JSON"

    if [ -z "$ASSET_ID" ]; then
        echo "[!] Release ${FW_TAG} 中未找到资产 ${FW_BIN}，请确认资产命名符合 SoilPulse_v<版本>.bin"
        exit 1
    fi

    # 私有仓库的 browser_download_url（github.com 直链）不认 Bearer Token 会返回 404，
    # 必须走 API 资产端点（Accept: application/octet-stream）由 api.github.com 302 到签名下载地址，
    # 公有/私有仓库均适用；直链仅作 API 通道失败时的回退（公有仓库场景）
    echo "[*] 通过 API 资产端点下载 ${FW_BIN} (asset id: ${ASSET_ID}) ..."
    if ! curl --fail --location --show-error --retry 3 --progress-bar \
        "${AUTH_HEADER[@]}" -H "Accept: application/octet-stream" \
        --output "page/firmware/${FW_BIN}" \
        "https://api.github.com/repos/${FW_REPO_PATH}/releases/assets/${ASSET_ID}"; then
        echo "[!] API 资产通道失败，回退直链重试: ${DOWNLOAD_URL}"
        if ! curl --fail --location --show-error --retry 3 --progress-bar \
            "${AUTH_HEADER[@]}" --output "page/firmware/${FW_BIN}" "$DOWNLOAD_URL"; then
            echo "[!] 固件下载失败: ${DOWNLOAD_URL}"
            exit 1
        fi
    fi
    local FW_DL_SIZE
    FW_DL_SIZE=$(wc -c < "page/firmware/${FW_BIN}" | tr -d ' ')
    local FW_DL_KB
    FW_DL_KB=$(awk -v s="${FW_DL_SIZE}" 'BEGIN{printf "%.1f", s/1024}')
    echo "[✓] 下载完成 (${FW_DL_KB} KB)，正在校验文件..."

    # ===== 校验下载产物（非空、二进制固件，拒绝 HTML 错误页），与 dev.yml 校验规则一致 =====
    if [ ! -s "page/firmware/${FW_BIN}" ]; then
        echo "[!] 固件下载失败或文件为空: ${FW_BIN}"
        exit 1
    fi
    if head -c 512 "page/firmware/${FW_BIN}" | grep -qiE '<!doctype html|<html'; then
        echo "[!] 下载产物是 HTML 页面而非固件二进制（私有仓库请配置 FW_REPO_TOKEN/GH_TOKEN 或 .fw_token）"
        exit 1
    fi
    if ! LC_ALL=C grep -q $'\x00' "page/firmware/${FW_BIN}"; then
        echo "[!] 下载产物不是二进制固件（未检测到二进制特征）: ${FW_BIN}"
        exit 1
    fi

    # 清理旧版本固件 bin，只保留本次清单指向的固件
    find page/firmware -maxdepth 1 -type f -name '*.bin' ! -name "${FW_BIN}" -delete

    # 从文件名解析清单版本号（SoilPulse_v1.2.1.bin -> 1.2.1），与 dev.yml 命名约定一致
    local FW_VERSION
    if [[ "$FW_BIN" =~ ^(SoilPulse_)?[vV]([0-9]+(\.[0-9]+)+)\.bin$ ]]; then
        FW_VERSION="${BASH_REMATCH[2]}"
    elif [[ "$FW_BIN" =~ ^(SoilPulse_)?([0-9a-fA-F]{6,40})\.bin$ ]]; then
        FW_VERSION="${BASH_REMATCH[2]}"
    else
        echo "[!] 固件文件名 ${FW_BIN} 不符合命名约定，无法解析版本号"
        exit 1
    fi

    local FW_SIZE
    FW_SIZE=$(wc -c < "page/firmware/${FW_BIN}" | tr -d ' ')
    local FW_NOTES="${FW_RAW_NOTES:-test firmware}"

    echo "[*] 同步 firmware.json -> version=${FW_VERSION}, bin=${FW_BIN}, size=${FW_SIZE}, isforce=true ..."

    # 用 node 原子更新 JSON 字段（与 dev.yml 一致）；node 不可用时回退 python3
    if command -v node >/dev/null 2>&1; then
        node -e '
            const fs = require("fs");
            const manifestPath = "page/firmware/firmware.json";
            let manifest = {};
            try { manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")); } catch (_) {}
            const [, version, bin, size, notes] = process.argv;
            manifest.version = version;
            manifest.bin = bin;
            manifest.size = Number(size);
            manifest.isforce = true;
            manifest.notes = notes;
            fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
        ' "$FW_VERSION" "$FW_BIN" "$FW_SIZE" "$FW_NOTES"
    else
        python3 - "$FW_VERSION" "$FW_BIN" "$FW_SIZE" "$FW_NOTES" << 'PYINNER'
import json, sys
path = "page/firmware/firmware.json"
try:
    with open(path) as f:
        manifest = json.load(f)
except Exception:
    manifest = {}
_, version, bin_name, size, notes = sys.argv
manifest.update(version=version, bin=bin_name, size=int(size), isforce=True, notes=notes)
with open(path, "w") as f:
    json.dump(manifest, f, indent=2, ensure_ascii=False)
    f.write("\n")
PYINNER
    fi

    echo "[✓] 固件已就绪:"
    cat page/firmware/firmware.json
    ls -la page/firmware
}

# ===== 可选参数处理 =====
FW_TAG_ARG="${1:-}"
FW_NOTES_ARG="${2:-}"

case "$FW_TAG_ARG" in
    "")
        echo "[*] 未指定固件 tag，跳过固件拉取，使用 page/firmware/ 现有固件" ;;
    -h|--help)
        sed -n '2,9p' "$0" | sed 's/^#//' ; exit 0 ;;
    -*)
        echo "[!] 未知参数: $FW_TAG_ARG"; echo "用法: ./start_service.sh [固件tag] [升级说明]"; exit 1 ;;
    *)
        sync_firmware "$FW_TAG_ARG" "$FW_NOTES_ARG" ;;
esac

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