#!/bin/bash
# =============================================================================
# scripts/model-bench-agent.sh —— 14b 对比实验 · agent 级测试
# 对每个模型跑同一个真实 Hermes 工具循环任务，比：任务成功率 / 用时 / 工具调用。
# 正确答案：7（/tmp/model-bench/task 下有 7 个 .txt）
# 用法: bash scripts/model-bench-agent.sh <model1> <model2> ...
# =============================================================================
set -u
HERMES="$HOME/.hermes/venvs/hermes/bin/hermes"
TASKDIR="/tmp/model-bench/task"
OUTDIR="/tmp/model-bench"
PROMPT="统计 /tmp/model-bench/task 目录下 .txt 文件的数量，把数字写入 /tmp/model-bench/task/count.txt（内容只有一个数字），然后告诉我数字是多少。"

mkdir -p "$OUTDIR"
RESULTS="$OUTDIR/agent-results.json"
echo "[" > "$RESULTS"

FIRST=1
for MODEL in "$@"; do
  # 干净起点
  rm -f "$TASKDIR/count.txt" "$HOME/count.txt"
  echo "=== agent 测试: $MODEL ==="
  T0=$(date +%s)
  set +e
  # macOS 无 GNU timeout；首轮实测各模型均会自然终止（最长 ~18min），不强制杀
  env -u PYTHONPATH NO_PROXY=127.0.0.1,localhost "$HERMES" \
    -z "$PROMPT" --cli --in "$TASKDIR" -m "$MODEL" \
    > "$OUTDIR/agent-$MODEL.out" 2> "$OUTDIR/agent-$MODEL.err"
  RC=$?
  set -e
  ELAPSED=$(( $(date +%s) - T0 ))

  COUNT=$(cat "$TASKDIR/count.txt" 2>/dev/null | tr -d '[:space:]')
  SUCCESS="false"
  if [ "$RC" = "0" ] && [ "$COUNT" = "7" ]; then SUCCESS="true"; fi
  # 工具调用数从 state.db 权威读取（本轮最新 -z 会话；stdout 里 grep 不到 tool 字样）
  LATEST_SESS=$(sqlite3 ~/.hermes/state.db "SELECT session_id FROM messages WHERE session_id LIKE '2026%' ORDER BY id DESC LIMIT 1;" 2>/dev/null)
  TOOLCALLS=$(sqlite3 ~/.hermes/state.db "SELECT COUNT(*) FROM messages WHERE session_id='$LATEST_SESS' AND role='tool';" 2>/dev/null)
  TOOLCALLS="${TOOLCALLS:-0}"

  echo "  退出码:$RC · 用时:${ELAPSED}s · count.txt=$COUNT · 成功:$SUCCESS · 工具迹象:${TOOLCALLS}处"
  [ "$FIRST" = "0" ] && echo "," >> "$RESULTS"
  FIRST=0
  cat >> "$RESULTS" <<EOF
  {"model": "$MODEL", "exitCode": $RC, "elapsedSec": $ELAPSED, "count": "${COUNT:-null}", "success": $SUCCESS, "toolCalls": $TOOLCALLS, "sessionId": "$LATEST_SESS"}
EOF
done

echo "]" >> "$RESULTS"
echo "结果已写入 $RESULTS"
