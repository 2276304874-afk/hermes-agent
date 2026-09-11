#!/bin/bash
# =============================================================================
# 赫尔墨斯特工 UI 启动器
# 为什么需要这个文件：launchd plist 若直接写 node 的绝对路径，WorkBuddy 一升级
# 托管 node（如 22.22.2-2 → 22.22.2-3）路径就失效，服务直接起不来（2026-09-11 踩坑）。
# plist 改为指向本脚本，node 换版本无需再动 plist。
# =============================================================================
set -euo pipefail

WS="$(cd "$(dirname "$0")" && pwd)"

# 解析可用的 node：显式指定 > WorkBuddy 托管（取版本号最大）> PATH > 常见位置
NODE="${HERMES_NODE:-}"
if [ -z "$NODE" ]; then
  for c in "$HOME"/.workbuddy/binaries/node/versions/*/bin/node; do
    [ -x "$c" ] && NODE="$c"        # 循环到最后一个 = 版本最高的
  done
fi
if [ -z "$NODE" ]; then
  NODE="$(command -v node 2>/dev/null || true)"
fi
if [ -z "$NODE" ]; then
  for c in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.local/bin/node"; do
    if [ -x "$c" ]; then NODE="$c"; break; fi
  done
fi

if [ -z "$NODE" ]; then
  echo "✗ 找不到可用的 node。设环境变量 HERMES_NODE=<node路径> 后重试。" >&2
  exit 1
fi

cd "$WS"
exec "$NODE" server.js
