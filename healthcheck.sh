#!/bin/bash
# =============================================================================
# 赫尔墨斯特工 · 健康自检（一条命令替代"手工点 UI 验回归"）
#
# 用法:  bash healthcheck.sh          # 完整检查
#        bash healthcheck.sh --quick  # 只查端口+健康（跳过 CLI 类接口）
#
# 退出码: 0 = 全部通过; 1 = 有失败项
#
# 为什么要有这个：项目没有测试框架时，改完代码只能靠手工点 UI 才发现问题。
# 本脚本把「守护在跑 / 端口在听 / 健康接口活 / 各 API 通 / 无崩溃 / 非崩溃循环」
# 固化成可重复执行的判据。与 `npm test`（纯函数单测）互补。
#
# ⚠️ 编写注意：变量引用一律写 ${VAR}。若写成 $VAR 且后面紧跟全角字符（如 ）或 ，），
#    bash 会把那些字节并进变量名，set -u 下直接报 "unbound variable"。
# =============================================================================
set -uo pipefail

WS="$(cd "$(dirname "$0")" && pwd)"
LABEL="com.hermes-agent.ui"
PORT="${PORT:-4173}"
HOST_="127.0.0.1"
LOG_DIR="$HOME/Library/Logs"
TOKEN_FILE="$HOME/.hermes/ui_token"
QUICK=0
[ "${1:-}" = "--quick" ] && QUICK=1

PASS=0; FAIL=0
ok()   { echo "  ✅ $1"; PASS=$((PASS+1)); }
bad()  { echo "  ❌ $1"; FAIL=$((FAIL+1)); }
warn() { echo "  ⚠️  $1"; }

MODE="完整"; [ "${QUICK}" = "1" ] && MODE="快速"

echo "=============================================="
echo " 赫尔墨斯特工 健康自检"
echo " 工作区: ${WS}"
echo " 端口  : ${HOST_}:${PORT}   模式: ${MODE}"
echo "=============================================="

# ---------- 1. launchd 守护 ----------
echo
echo "[1] launchd 守护 (${LABEL})"
# ⚠️ 不要用 `launchctl list`：在非 GUI 会话的 shell 里它恒返回 0 行，会误报"未注册"。
PRINT="$(launchctl print "gui/$(id -u)/${LABEL}" 2>&1 || true)"
if echo "${PRINT}" | grep -q "state = running"; then
  PID_="$(echo "${PRINT}" | sed -n 's/.*pid = \([0-9]*\).*/\1/p' | head -1)"
  RUNS="$(echo "${PRINT}" | sed -n 's/.*runs = \([0-9]*\).*/\1/p' | head -1)"
  ok "守护 running (pid=${PID_}, runs=${RUNS:-?})"
  if [ "${RUNS:-0}" -gt 50 ]; then warn "runs=${RUNS} 偏大，可能存在崩溃循环"; fi
else
  bad "守护未注册或未运行 —— 在 Terminal.app 跑: bash ${WS}/setup.sh"
fi

# ---------- 2. 端口监听 ----------
echo
echo "[2] 端口监听"
# ⚠️ 不要用 `ps -p`：此 shell 可能报 operation not permitted。
if lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  ok "TCP ${PORT} 有监听"
else
  bad "TCP ${PORT} 无监听"
fi

# ---------- 3. 健康接口 + 稳定性 ----------
echo
echo "[3] 健康接口 / 稳定性"
TOKEN="$(cat "${TOKEN_FILE}" 2>/dev/null || true)"
if [ -z "${TOKEN}" ]; then
  warn "读不到 token (${TOKEN_FILE})，跳过认证类检查"
else
  U1="$(curl -s -m 5 -H "Authorization: Bearer ${TOKEN}" "http://${HOST_}:${PORT}/api/health" 2>/dev/null \
        | sed -n 's/.*"uptimeSec":\([0-9]*\).*/\1/p')"
  if echo "${U1}" | grep -qE '^[0-9]+$'; then
    ok "/api/health 正常 (uptime=${U1}s)"
    sleep 3
    U2="$(curl -s -m 5 -H "Authorization: Bearer ${TOKEN}" "http://${HOST_}:${PORT}/api/health" 2>/dev/null \
          | sed -n 's/.*"uptimeSec":\([0-9]*\).*/\1/p')"
    if [ -n "${U2}" ] && [ "${U2}" -gt "${U1}" ]; then
      ok "uptime 递增 (${U1} -> ${U2})，非崩溃循环"
    else
      bad "uptime 未递增 (${U1} -> ${U2})，疑似崩溃重启"
    fi
  else
    bad "/api/health 无响应或 token 无效"
  fi
fi

# ---------- 4. API 接口 ----------
echo
echo "[4] API 接口"
if [ -z "${TOKEN}" ]; then
  warn "无 token，跳过"
else
  for ep in /api/status /api/models /api/skills /api/memory; do
    CODE="$(curl -s -m 8 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer ${TOKEN}" "http://${HOST_}:${PORT}${ep}")"
    if [ "${CODE}" = "200" ]; then ok "${ep} -> 200"; else bad "${ep} -> HTTP ${CODE}"; fi
  done
fi

# ---------- 5. KB 接口（公开只读）----------
echo
echo "[5] 知识库接口"
KB_STATUS="$(curl -s -m 5 "http://${HOST_}:${PORT}/api/kb/status" 2>/dev/null)"
if echo "${KB_STATUS}" | grep -q '"total"'; then
  TOTAL="$(echo "${KB_STATUS}" | sed -n 's/.*"total":\([0-9]*\).*/\1/p')"
  ok "/api/kb/status 可用 (total=${TOTAL})"
else
  bad "/api/kb/status 无响应"
fi
for cat in inbox distilled memory all; do
  N="$(curl -s -m 5 "http://${HOST_}:${PORT}/api/kb/list?cat=${cat}" 2>/dev/null \
       | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))' 2>/dev/null || echo err)"
  if [ "${N}" = "err" ]; then bad "/api/kb/list?cat=${cat} 解析失败"; else ok "/api/kb/list?cat=${cat} -> ${N} 条"; fi
done
CODE="$(curl -s -m 5 -o /dev/null -w '%{http_code}' "http://${HOST_}:${PORT}/kb")"
if [ "${CODE}" = "200" ]; then ok "/kb 页面 -> 200"; else bad "/kb 页面 -> HTTP ${CODE}"; fi
CODE="$(curl -s -m 5 -o /dev/null -w '%{http_code}' "http://${HOST_}:${PORT}/")"
if [ "${CODE}" = "200" ]; then ok "/ 主界面 -> 200"; else bad "/ 主界面 -> HTTP ${CODE}"; fi

# ---------- 6. 日志健康 ----------
echo
echo "[6] 日志健康"
ERR="${LOG_DIR}/hermes-ui.err.log"
OUT="${LOG_DIR}/hermes-ui.out.log"
if [ -f "${ERR}" ]; then
  # 注意：grep -c 无匹配时输出 0 但退出码为 1，故**不能**写 `|| echo 0`（会变成 "0\n0"）。
  F="$(grep -c '\[FATAL' "${ERR}" 2>/dev/null)"; F="${F:-0}"
  if [ "${F}" = "0" ]; then ok "无 [FATAL] 崩溃记录"; else bad "err.log 有 ${F} 条 [FATAL]，见 ${ERR}"; fi
  PARSEN="$(grep -c '\[parse\]' "${ERR}" 2>/dev/null)"; PARSEN="${PARSEN:-0}"
  if [ "${PARSEN}" = "0" ]; then ok "无 [parse] 解析告警"; else warn "[parse] 告警 ${PARSEN} 条 — CLI 输出格式可能已变 (见 ${ERR})"; fi
else
  warn "找不到 ${ERR}"
fi
# 启动自印的关键行，用于发现"路径腐烂"
if [ -f "${OUT}" ]; then
  grep -E "KB 解释器" "${OUT}" 2>/dev/null | tail -1 | sed 's/^/     /'
fi

# ---------- 7. 依赖探测 ----------
echo
echo "[7] 依赖"
if curl -s -m 3 "http://127.0.0.1:11434/api/version" >/dev/null 2>&1; then
  ok "Ollama 在线 (11434)"
else
  bad "Ollama 无响应 —— 先启动 Ollama.app"
fi
HERMES_BIN="$HOME/.hermes/venvs/hermes/bin/hermes"
if [ -x "${HERMES_BIN}" ]; then ok "Hermes CLI 在位"; else bad "Hermes CLI 缺失: ${HERMES_BIN}"; fi

# ---------- 汇总 ----------
echo
echo "=============================================="
echo " 通过 ${PASS} 项 / 失败 ${FAIL} 项"
echo "=============================================="
if [ "${FAIL}" = "0" ]; then echo "✅ 全部通过"; exit 0; else echo "❌ 存在失败项，见上"; exit 1; fi
