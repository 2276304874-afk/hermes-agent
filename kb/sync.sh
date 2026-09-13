#!/bin/bash
# 赫尔墨斯特工 · 知识库自动同步
# 由 launchd/cron 定时调用：捕获新会话 → 蒸馏成技能 → 重建索引
# 日志：~/.hermes/kb-sync.log
#
# 用法：
#   bash kb/sync.sh                 # 完整链（launchd 定时器用）
#   bash kb/sync.sh --capture-only  # 只跑捕获链（压缩/回退后的边界 flush 用：
#                                   #   capture.py 是纯规则、秒级、不调模型；
#                                   #   distill.py 要调 9.5G 常驻模型，在「用户刚压缩完、
#                                   #   正要开新一轮」的节骨眼上跑会抢 16G 统一内存，
#                                   #   所以边界 flush 只捕获，蒸馏/建索引交给 30min 定时器）
set -u
WS="$HOME/WorkBuddy/赫尔墨斯特工"
LOG="$HOME/.hermes/kb-sync.log"
cd "$WS" || exit 1

MODE="full"
[ "${1:-}" = "--capture-only" ] && MODE="capture"

# ---- 单实例锁（原子 mkdir）----
# 为什么需要：定时器（每 30min）与事件触发（压缩/回退后的按需 flush）可能重叠。
# 两个 sync 并发跑 → 各自读到旧指针 → 重复写 inbox，且 distill/build 互相踩。
# 用 mkdir 的原子性做锁；持锁 >10min 视为僵死强制破锁（僵死会让沉淀彻底停摆，
# 而误破的代价只是可能重复几条 inbox 条目 —— 两害相权取破锁）。
LOCK="$HOME/.hermes/kb-sync.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +10 2>/dev/null)" ]; then
    rmdir "$LOCK" 2>/dev/null
    echo "$(date) [kb-sync] ⚠ 破除僵死锁（mtime>10min）" >>"$LOG"
  fi
  if ! mkdir "$LOCK" 2>/dev/null; then
    echo "$(date) [kb-sync] 已有实例在跑，跳过本次 (mode=$MODE)" >>"$LOG"; exit 0
  fi
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

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

echo "$(date) [kb-sync] start (py=$PY, mode=$MODE)" >>"$LOG"

# ---- 捕获链（多 Agent 经验沉淀，2026-09-13 扩展）----
# 1) 赫尔墨斯特工自身会话：规则启发式捕获（偏好/教训/排障/决策/工具链）
"$PY" kb/capture.py >>"$LOG" 2>&1
# 2) zcode 会话：脚本由用户安装到 ~/.hermes/kb/（读 zcode 会话库属敏感操作，
#    安全策略要求用户亲手创建，Agent 不得代写——2026-09-13 Mimosa 四轮拦截确认）
if [ -f "$HOME/.hermes/kb/capture_zcode.py" ]; then
  "$PY" "$HOME/.hermes/kb/capture_zcode.py" >>"$LOG" 2>&1
fi
# 3) workbuddy App 会话注册表（同上用户安装）
if [ -f "$HOME/.hermes/kb/capture_workbuddy.py" ]; then
  "$PY" "$HOME/.hermes/kb/capture_workbuddy.py" >>"$LOG" 2>&1
fi

# 边界 flush 到此为止：只把新会话落进 inbox（数据安全落盘），
# 蒸馏 + 建索引留给 30min 定时器，避免在用户刚压缩完时抢占常驻模型内存。
if [ "$MODE" = "capture" ]; then
  echo "$(date) [kb-sync] done (capture-only)" >>"$LOG"
  exit 0
fi

# ---- 蒸馏：本地模型把 inbox 原始片段压缩成结构化技能草稿 ----
"$PY" kb/distill.py >>"$LOG" 2>&1

# ---- 治理：inbox 超 300 条滚档（蒸馏已完成，旧原始条目安全归档不再索引）----
"$PY" - "$WS/.workbuddy/kb_inbox.md" "$WS/.workbuddy/kb_archive.md" <<'PYEOF'
import sys, os
inbox, arch = sys.argv[1], sys.argv[2]
MAX = 300
if not os.path.isfile(inbox):
    print("[prune] inbox 不存在"); sys.exit(0)
lines = open(inbox, encoding="utf-8").read().splitlines()
head, entries, cur = [], [], []
for ln in lines:
    if ln.startswith("### "):
        if cur is not None: entries.append(cur)
        cur = [ln]
    elif cur is None:
        head.append(ln)
    else:
        cur.append(ln)
if cur is not None: entries.append(cur)
if len(entries) <= MAX:
    print(f"[prune] 条目 {len(entries)}/{MAX}，无需治理"); sys.exit(0)
overflow, keep = entries[:len(entries)-MAX], entries[len(entries)-MAX:]
with open(arch, "a", encoding="utf-8") as f:
    for e in overflow:
        if "\n".join(e).strip(): f.write("\n".join(e).rstrip() + "\n\n")
out = "\n".join(head).rstrip("\n") + "\n\n" + "\n\n".join("\n".join(e).rstrip() for e in keep) + "\n"
tmp = inbox + ".tmp"
open(tmp, "w", encoding="utf-8").write(out)
os.replace(tmp, inbox)
print(f"[prune] 治理完成：{len(entries)} -> {len(keep)} 条")
PYEOF

# ---- 索引：最终一次性重建（替代各脚本的 --reindex，幂等）----
"$PY" kb/kb.py build >>"$LOG" 2>&1
echo "$(date) [kb-sync] done" >>"$LOG"
