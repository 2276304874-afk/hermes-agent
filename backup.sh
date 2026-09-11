#!/usr/bin/env bash
# =============================================================================
# 赫尔墨斯特工 · 仓库离机备份
#
# 用途：把整个 git 仓库（全部提交历史 + 全部跟踪文件）打包成单个 .bundle，
#       作为「.git 损坏 / 误删 / 磁盘故障」时的还原点。
#
# 用法：
#   bash backup.sh                    # 只做本地 bundle（默认，零触网）
#   bash backup.sh /Volumes/MyDisk    # 额外复制一份到外置盘 / 网盘同步目录
#
# 还原方法（灾难恢复）：
#   git clone <bundle 文件> 目标目录
#   # 若要在原目录原地恢复：
#   cd 目标目录 && git remote set-url origin <你原来的远端>
#
# ⚠️ 注意：本地 bundle 与工作区在**同一块磁盘**上，只防 .git 损坏与误删，
#    不防磁盘故障。真正的异地容灾必须靠外部目标（外置盘 / 远端仓库）。
# =============================================================================
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL_DIR="${HERMES_BACKUP_DIR:-$(cd "${REPO_DIR}/.." && pwd)/_hermes-backups}"
KEEP="${HERMES_BACKUP_KEEP:-10}"          # 本地保留最近 N 份
EXTERNAL="${1:-}"                          # 可选：外部目标目录

FILENAME="hermes-repo-$(date +%Y%m%d-%H%M%S).bundle"
LOCAL_PATH="${LOCAL_DIR}/${FILENAME}"

info() { printf '  %s\n' "$*"; }
ok()   { printf '  ✅ %s\n' "$*"; }
bad()  { printf '  ❌ %s\n' "$*"; }
warn() { printf '  ⚠️  %s\n' "$*"; }

echo "=============================================="
echo " 赫尔墨斯特工 · 仓库备份"
echo " 仓库: ${REPO_DIR}"
echo " 输出: ${LOCAL_DIR}"
echo "=============================================="
echo

# ---------- 0. 前置检查 ----------
[ -d "${REPO_DIR}/.git" ] || { bad "不是 git 仓库：${REPO_DIR}"; exit 1; }
command -v git >/dev/null 2>&1 || { bad "找不到 git"; exit 1; }

cd "${REPO_DIR}"

# 未提交改动 → 警告（bundle 只含已提交内容，工作区改动不会进备份）
if [ -n "$(git status --porcelain)" ]; then
  warn "工作区有未提交改动，这些内容**不会**进备份："
  git status --short | head -8 | sed 's/^/      /'
  echo
fi

mkdir -p "${LOCAL_DIR}"

# ---------- 1. 清理陈旧锁（被打断的备份会留下 .lock，导致后续全部失败）----------
STALE=$(find "${LOCAL_DIR}" -maxdepth 1 -name '*.bundle.lock' 2>/dev/null || true)
if [ -n "${STALE}" ]; then
  warn "清理陈旧锁文件（上次备份被中断的残留）："
  echo "${STALE}" | sed 's/^/      /'
  rm -f "${LOCAL_DIR}"/*.bundle.lock
fi

# ---------- 2. 创建 bundle ----------
echo "[1/4] 创建 bundle（--all：含所有分支与提交）"
if ! git bundle create "${LOCAL_PATH}" --all >/dev/null 2>&1; then
  bad "bundle 创建失败"
  rm -f "${LOCAL_PATH}" "${LOCAL_PATH}.lock"
  exit 1
fi
SIZE=$(du -h "${LOCAL_PATH}" | cut -f1)
ok "已生成 ${FILENAME}（${SIZE}）"
echo

# ---------- 3. 校验完整性 ----------
echo "[2/4] 校验 bundle 完整性"
VERIFY="$(git bundle verify "${LOCAL_PATH}" 2>&1)" || { bad "校验失败：${VERIFY}"; exit 1; }
if ! echo "${VERIFY}" | grep -q 'complete history'; then
  bad "bundle 不含完整历史，放弃"
  exit 1
fi
COMMITS=$(git rev-list --count HEAD)
FILES=$(git ls-files | wc -l | tr -d ' ')
ok "完整历史 · ${COMMITS} 次提交 · ${FILES} 个跟踪文件"
echo

# ---------- 4. 外部复制（可选）----------
echo "[3/4] 外部目标"
if [ -z "${EXTERNAL}" ]; then
  warn "未指定外部目标 —— 本次备份仍在**同一块磁盘**上，不防磁盘故障"
  info "要做异地容灾，重跑：bash backup.sh /Volumes/你的外置盘"
else
  [ -d "${EXTERNAL}" ] || { bad "外部目标不存在或不可写：${EXTERNAL}"; exit 1; }
  cp "${LOCAL_PATH}" "${EXTERNAL}/"
  # 复制后用 sha256 核对，防复制不完整
  A=$(shasum -a 256 "${LOCAL_PATH}" | cut -d' ' -f1)
  B=$(shasum -a 256 "${EXTERNAL}/${FILENAME}" | cut -d' ' -f1)
  if [ "${A}" = "${B}" ]; then
    ok "已复制到 ${EXTERNAL}（sha256 一致 ${A:0:12}）"
  else
    bad "复制后哈希不一致，外部副本不可信"
    exit 1
  fi
fi
echo

# ---------- 5. 轮转旧备份 ----------
echo "[4/4] 轮转（本地保留最近 ${KEEP} 份）"
CNT=$(find "${LOCAL_DIR}" -maxdepth 1 -name '*.bundle' | wc -l | tr -d ' ')
if [ "${CNT}" -gt "${KEEP}" ]; then
  find "${LOCAL_DIR}" -maxdepth 1 -name '*.bundle' -print0 \
    | xargs -0 ls -t \
    | tail -n +"$((KEEP + 1))" \
    | while IFS= read -r f; do
        rm -f "$f"
        info "已删除旧备份 $(basename "$f")"
      done
fi
REMAIN=$(find "${LOCAL_DIR}" -maxdepth 1 -name '*.bundle' | wc -l | tr -d ' ')
ok "当前共 ${REMAIN} 份备份"
echo

echo "=============================================="
ok "备份完成：${LOCAL_PATH}"
echo "=============================================="
