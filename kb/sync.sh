#!/bin/bash
# 赫尔墨斯特工 · 知识库自动同步
# 由 launchd/cron 定时调用：捕获新会话 → 蒸馏成技能 → 重建索引
# 日志：~/.hermes/kb-sync.log
set -u
WS="$HOME/WorkBuddy/赫尔墨斯特工"
LOG="$HOME/.hermes/kb-sync.log"
cd "$WS" || exit 1

# P2-9: 动态解析 python（WorkBuddy 升级会改托管目录名，硬编码版本 = 静默腐烂）
# 顺序：版本号数值降序取最高 → PATH 兜底
PY=""
PV_BASE="$HOME/.workbuddy/binaries/python/versions"
if [ -d "$PV_BASE" ]; then
  while IFS= read -r v; do
    [ -x "$PV_BASE/$v/bin/python3" ] && { PY="$PV_BASE/$v/bin/python3"; break; }
  done <<< "$(ls -1 "$PV_BASE" 2>/dev/null | grep -E '^[0-9]+(\.[0-9]+)*$' | sort -t. -k1,1nr -k2,2nr -k3,3nr)"
fi
[ -z "$PY" ] && PY="$(command -v python3 2>/dev/null || true)"
[ -z "$PY" ] && { echo "$(date) [kb-sync] no python found" >>"$LOG"; exit 1; }

# 索引依赖 FTS5 trigram；不支持则明确告警（而非静默降级成空索引）
if ! "$PY" -c 'import sqlite3;sqlite3.connect(":memory:").execute("CREATE VIRTUAL TABLE t USING fts5(x, tokenize=\"trigram\")")' 2>/dev/null; then
  echo "$(date) [kb-sync] ⚠ 解释器不支持 FTS5 trigram，索引可能退化: $PY" >>"$LOG"
fi

echo "$(date) [kb-sync] start (py=$PY)" >>"$LOG"
"$PY" kb/capture.py --reindex >>"$LOG" 2>&1
"$PY" kb/distill.py --reindex >>"$LOG" 2>&1
echo "$(date) [kb-sync] done" >>"$LOG"
