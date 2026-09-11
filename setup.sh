#!/bin/bash
# =============================================================================
# 赫尔墨斯特工 · 一键部署 / 自检 (D3)
# 换机 / 重装后一条命令恢复: 装 launchd 守护 → 等健康 → 打印令牌 → 自检报告
# 用法:  bash setup.sh [--force]
#   --force  先 bootout 旧服务再全新 bootstrap
# =============================================================================
set -uo pipefail

WS="$(cd "$(dirname "$0")" && pwd)"
HOME_DIR="$HOME"
LABEL="com.hermes-agent.ui"
PLIST_SRC="$WS/launchd/$LABEL.plist"
PLIST_DST="$HOME_DIR/Library/LaunchAgents/$LABEL.plist"
PORT="${PORT:-4173}"
# Node 不再硬编码版本路径：WorkBuddy 升级托管 node 会改目录名（22.22.2-2 → 22.22.2-3），
# 硬编码会让本脚本和 launchd 一起失效。现在运行时自动挑可用的。
resolve_node() {
  [ -n "${HERMES_NODE:-}" ] && [ -x "${HERMES_NODE}" ] && { echo "$HERMES_NODE"; return; }
  local c last=""
  for c in "$HOME_DIR"/.workbuddy/binaries/node/versions/*/bin/node; do [ -x "$c" ] && last="$c"; done
  [ -n "$last" ] && { echo "$last"; return; }
  c="$(command -v node 2>/dev/null || true)"; [ -n "$c" ] && { echo "$c"; return; }
  for c in /opt/homebrew/bin/node /usr/local/bin/node "$HOME_DIR/.local/bin/node"; do
    [ -x "$c" ] && { echo "$c"; return; }
  done
  echo ""
}
NODE_BIN="$(resolve_node)"
UI_DOMAIN="gui/$(id -u)"
FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

echo "==> 赫尔墨斯特工 一键部署 / 自检"
echo "    工作区 : $WS"
echo "    端口   : $PORT"

# ---------- 0. 前置依赖 ----------
echo; echo "==> [1/6] 前置检查"
if [ ! -x "$NODE_BIN" ]; then echo "  ✗ node 不存在: $NODE_BIN（改 HERMES_NODE 或装 managed node）"; exit 1; fi
echo "  ✓ node: $($NODE_BIN --version 2>/dev/null)"
if ! NO_PROXY=127.0.0.1,localhost curl -s -m 3 http://127.0.0.1:11434/api/version >/dev/null 2>&1; then
  echo "  ⚠ Ollama 未在 11434 响应 —— 先启动 Ollama.app 再重跑"; exit 1
fi
echo "  ✓ ollama: $(NO_PROXY=127.0.0.1,localhost curl -s -m 3 http://127.0.0.1:11434/api/version 2>/dev/null | sed 's/.*"version":"\([^"]*\)".*/\1/')"
# 2026-09-11 更新：主模型已换装 gemma4:e4b（hermes-local-qwen35/qwen3.5:9b 已删除）
MODELS_OK=$(ollama list 2>/dev/null | grep -cE "hermes-local-gemma4|gemma4:e4b" || true)
echo "  $([ "$MODELS_OK" -ge 1 ] && echo '✓' || echo '⚠ 缺主模型(hermes-local-gemma4/gemma4:e4b)，先 ollama pull gemma4:e4b 再建 Modelfile') 主模型检查"

# ---------- 1. 安装 launchd plist ----------
echo; echo "==> [2/6] 安装 launchd 守护"
mkdir -p "$HOME_DIR/Library/LaunchAgents"
if [ -f "$PLIST_DST" ] && ! grep -q "$WS" "$PLIST_DST" 2>/dev/null; then
  echo "  已存在指向他处的同名 plist，先移除旧条目"
  launchctl bootout "$UI_DOMAIN/$LABEL" 2>/dev/null
  rm -f "$PLIST_DST"
fi
# 用 sed 把 plist 里硬编码的用户路径替换成当前 HOME（换机后用户名不同）
sed -e "s|/Users/zhaocaozheng|$HOME_DIR|g" "$PLIST_SRC" > "$PLIST_DST"
echo "  ✓ plist -> $PLIST_DST"

# ---------- 2. 启动 / 重启服务 ----------
echo; echo "==> [3/6] 启动服务"
if launchctl print "$UI_DOMAIN/$LABEL" >/dev/null 2>&1; then
  echo "  服务已在 launchd，kickstart 重启加载新配置…"
  launchctl kickstart -k "$UI_DOMAIN/$LABEL" 2>/dev/null && echo "  ✓ 已重启"
else
  echo "  尝试 bootstrap…"
  if ! launchctl bootstrap "$UI_DOMAIN" "$PLIST_DST" 2>/tmp/setup_boot.err; then
    echo "  ⚠ bootstrap 失败（本机若报 IO error，属 macOS launchd 域限制）："
    cat /tmp/setup_boot.err 2>/dev/null | head -2
    echo "    手动命令: launchctl bootstrap $UI_DOMAIN $PLIST_DST"
    echo "    或直接前台试跑: cd $WS && $NODE_BIN server.js"
  else
    echo "  ✓ bootstrap 成功"
  fi
fi

# ---------- 3. 健康检查 ----------
echo; echo "==> [4/6] 健康检查"
TOKEN=""
for i in $(seq 1 15); do
  TOKEN="$(cat "$HOME_DIR/.hermes/ui_token" 2>/dev/null || true)"
  BODY="$(NO_PROXY=127.0.0.1,localhost curl -s -m 3 -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/api/health" 2>/dev/null || true)"
  if echo "$BODY" | grep -q '"ok":true'; then
    echo "  ✓ 服务健康 (uptime $(echo "$BODY" | sed 's/.*"uptimeSec":\([0-9]*\).*/\1/')s)"
    break
  fi
  [ "$i" = 15 ] && { echo "  ✗ 15 次探测未就绪，服务可能没起来"; echo "    排障: launchctl print $UI_DOMAIN/$LABEL"; }
  sleep 1
done

# ---------- 4. 自检报告 ----------
echo; echo "==> [5/6] 自检报告"
echo "  UI        : http://127.0.0.1:$PORT"
echo "  令牌      : ${TOKEN:-（服务未起，稍后看 ~/.hermes/ui_token）}"
echo "  令牌文件  : $HOME_DIR/.hermes/ui_token (0600，重启不变)"
PORT_PID="$(lsof -ti :$PORT 2>/dev/null | head -1)"
echo "  端口占用  : $([ -n "$PORT_PID" ] && echo "PID $PORT_PID" || echo '无（服务未监听）')"
echo "  模型驻留  : $(ollama ps 2>/dev/null | tail -n +2 | awk '{print $1}' | tr '\n' ' ' || echo 无)"
echo "  技能数量  : $(find "$HOME_DIR/.hermes/skills" -maxdepth 2 -name SKILL.md 2>/dev/null | wc -l | tr -d ' ')"

# ---------- 5. 可选清理 ----------
echo; echo "==> [6/6] 日志健康"
for f in "$HOME_DIR/Library/Logs/hermes-ui.out.log" "$HOME_DIR/Library/Logs/hermes-ui.err.log"; do
  if [ -f "$f" ] && [ "$(wc -c < "$f" 2>/dev/null || echo 0)" -gt 10485760 ]; then
    tail -c 1048576 "$f" > "$f.tmp" && mv "$f.tmp" "$f"
    echo "  ✓ 截断超限日志: $(basename "$f")"
  fi
done
echo "  日志 : $(du -sh "$HOME_DIR/Library/Logs/hermes-ui.out.log" "$HOME_DIR/Library/Logs/hermes-ui.err.log" 2>/dev/null | awk '{printf "%s ", $1}' || echo 0)"

echo; echo "==> 完成。浏览器打开 http://127.0.0.1:$PORT ，令牌见上。"
