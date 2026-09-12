#!/usr/bin/env bash
# =============================================================================
# 赫尔墨斯特工 · 双轨备份（一条命令跑完两条链路）
#
# 为什么必须是两条轨道 —— 任一条单独都不够：
#   轨道 A｜项目侧（git bundle）：源码 + 全部提交历史。
#          不含 ~/.hermes（配置/会话/令牌），且与工作区**同盘**，只防 .git 损坏与误删。
#   轨道 B｜引擎侧（state snapshot）：~/.hermes 的 config.yaml / state.db / auth.json / cron。
#          这些**不在 git 里**，磁盘一挂无从恢复；但也不含项目源码。
#
# 实测坑（2026-09-12）：
#   `hermes backup --quick` 的产物落在 ~/.hermes/state-snapshots/<ts>/，
#   而**不是** -o 指定的路径 —— `-o` 对 --quick 无效且被静默忽略（无报错、无产物）。
#   本脚本因此按真实落点做轮转。
#
# 用法:
#   bash scripts/backup-all.sh                    # 双轨本地备份
#   bash scripts/backup-all.sh /Volumes/MyDisk     # 轨道 A 额外复制到外置盘（异地容灾）
#
# ⚠️ 真正防磁盘故障只有一条路：把轨道 A 复制到**另一块盘**，或用 `npm run mirror`
#    推到异地 git 远端（本机 github.com:443 阻断，走 api.github.com 的 REST 路径）。
# =============================================================================
set -uo pipefail

WS="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HERMES_BIN="$HOME/.hermes/venvs/hermes/bin/hermes"
SNAP_DIR="$HOME/.hermes/state-snapshots"
KEEP_SNAPS="${HERMES_SNAP_KEEP:-5}"
EXTERNAL="${1:-}"

FAIL=0
ok()   { printf '  ✅ %s\n' "$*"; }
bad()  { printf '  ❌ %s\n' "$*"; FAIL=1; }
warn() { printf '  ⚠️  %s\n' "$*"; }

echo "=============================================="
echo " 赫尔墨斯特工 · 双轨备份"
echo " 工作区: ${WS}"
echo "=============================================="

# ---------- 轨道 A：项目侧 git bundle（含 ~/.hermes 关键配置归档）----------
echo
echo "[A] 项目侧 bundle"
if bash "${WS}/backup.sh" ${EXTERNAL:+"${EXTERNAL}"} 2>&1 | grep -E '✅|❌|⚠️' | sed 's/^/  /'; then
  :
fi
BK_DIR="${HERMES_BACKUP_DIR:-$(cd "${WS}/.." && pwd)/_hermes-backups}"
LATEST_BUNDLE="$(ls -t "${BK_DIR}"/*.bundle 2>/dev/null | head -1 || true)"
if [ -n "${LATEST_BUNDLE}" ]; then
  ok "最新 bundle: $(basename "${LATEST_BUNDLE}") ($(du -h "${LATEST_BUNDLE}" | cut -f1))"
else
  bad "轨道 A 未产出 bundle"
fi

# ---------- 轨道 B：引擎侧 state snapshot ----------
echo
echo "[B] 引擎侧快照 (~/.hermes)"
if [ ! -x "${HERMES_BIN}" ]; then
  bad "找不到 Hermes CLI: ${HERMES_BIN}"
else
  SNAP_OUT="$(env -u PYTHONPATH NO_PROXY=127.0.0.1,localhost "${HERMES_BIN}" backup --quick 2>&1)"
  SNAP_ID="$(printf '%s' "${SNAP_OUT}" | sed -n 's/.*State snapshot created:[[:space:]]*//p' | head -1)"
  if [ -n "${SNAP_ID}" ]; then
    ok "已创建快照 ${SNAP_ID}（$(du -sh "${SNAP_DIR}/${SNAP_ID}" 2>/dev/null | cut -f1)）"
  else
    bad "快照创建失败：$(printf '%s' "${SNAP_OUT}" | tail -1)"
  fi
fi

# ---------- 轨道 B 轮转（hermes 自身无保留策略，会无限堆积）----------
echo
echo "[B] 快照轮转（保留最近 ${KEEP_SNAPS} 份）"
if [ -d "${SNAP_DIR}" ]; then
  CNT="$(find "${SNAP_DIR}" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')"
  if [ "${CNT}" -gt "${KEEP_SNAPS}" ]; then
    find "${SNAP_DIR}" -maxdepth 1 -mindepth 1 -type d 2>/dev/null \
      | while IFS= read -r d; do printf '%s\t%s\n' "$(stat -f %m "$d")" "$d"; done \
      | sort -rn | tail -n +"$((KEEP_SNAPS + 1))" | cut -f2 \
      | while IFS= read -r old; do rm -rf "$old"; warn "已删除旧快照 $(basename "$old")"; done
  fi
  NOW="$(find "${SNAP_DIR}" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')"
  ok "当前保留 ${NOW} 份快照"
else
  warn "快照目录不存在: ${SNAP_DIR}"
fi

# ---------- 汇总 ----------
echo
echo "=============================================="
if [ "${FAIL}" = "0" ]; then
  echo "✅ 双轨备份完成（⚠️ 仍在同一块磁盘，不防磁盘故障）"
  echo "   异地容灾: npm run mirror（推远端）或 bash scripts/backup-all.sh /Volumes/外置盘"
  exit 0
else
  echo "❌ 存在失败轨道，见上"
  exit 1
fi
