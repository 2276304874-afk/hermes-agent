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

# ---------- 5. KB 接口（P2-10：与 /api/* 同一闸门，需 token）----------
echo
echo "[5] 知识库接口"
# P2-10 不变量：不带 token 必须 401。KB 曾作为公开路由（原 4174 遗留），
# 而其中含 MEMORY.md 私有笔记 —— 这条断言保证它不会再悄悄变回公开。
if [ -n "${TOKEN}" ]; then
  CODE="$(curl -s -m 5 -o /dev/null -w '%{http_code}' "http://${HOST_}:${PORT}/api/kb/status")"
  if [ "${CODE}" = "401" ]; then ok "/api/kb/status 无 token -> 401（KB 未暴露）"; else bad "/api/kb/status 无 token -> HTTP ${CODE}（期望 401，KB 可能又变回公开了）"; fi
fi
KB_STATUS="$(curl -s -m 5 -H "Authorization: Bearer ${TOKEN}" "http://${HOST_}:${PORT}/api/kb/status" 2>/dev/null)"
if echo "${KB_STATUS}" | grep -q '"total"'; then
  TOTAL="$(echo "${KB_STATUS}" | sed -n 's/.*"total":\([0-9]*\).*/\1/p')"
  ok "/api/kb/status 可用 (total=${TOTAL})"
else
  bad "/api/kb/status 无响应"
fi
for cat in inbox distilled memory all; do
  N="$(curl -s -m 5 -H "Authorization: Bearer ${TOKEN}" "http://${HOST_}:${PORT}/api/kb/list?cat=${cat}" 2>/dev/null \
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

# 只统计「本次启动以来」的日志行，以 server.js 写的 [lifecycle] 启动 为界。
# 为什么必须这样：err.log 是追加式的，历史故障会一直躺在里面。全量统计的结果是
# 「修完 bug 之后自检仍然报红」—— 曾经因此把两条已修复的旧 [FATAL] 当成当前故障。
since_boot() {
  awk '/^\[lifecycle\] 启动/{n=0; buf=""} {buf=buf $0 "\n"} END{printf "%s", buf}' "$1"
}
if [ -f "${ERR}" ]; then
  CUR="$(since_boot "${ERR}")"
  if [ -z "${CUR}" ]; then
    warn "err.log 无启动标记（可能是旧版本进程写入的），退化为全量统计"
    CUR="$(cat "${ERR}" 2>/dev/null || true)"
  fi
  # 注意：grep -c 无匹配时输出 0 但退出码为 1，故**不能**写 `|| echo 0`（会变成 "0\n0"）。
  F="$(printf '%s\n' "${CUR}" | grep -c '\[FATAL')"; F="${F:-0}"
  if [ "${F}" = "0" ]; then ok "本次启动无 [FATAL] 崩溃"; else bad "本次启动有 ${F} 条 [FATAL]，见 ${ERR}"; fi
  # handler 异常：请求处理中抛错但被兜底 catch 接住（服务没死）。这是 P0-2 之前
  # 完全看不到的信号 —— 旧写法下这类错误要么静默 500，要么二次写头把进程带走。
  H="$(printf '%s\n' "${CUR}" | grep -c '\[handler\]')"; H="${H:-0}"
  if [ "${H}" = "0" ]; then ok "本次启动无 [handler] 请求异常"; else warn "[handler] 捕获 ${H} 条请求异常（已被兜底处理，未崩溃）"; fi
  PARSEN="$(printf '%s\n' "${CUR}" | grep -c '\[parse\]')"; PARSEN="${PARSEN:-0}"
  if [ "${PARSEN}" = "0" ]; then ok "本次启动无 [parse] 解析告警"; else warn "[parse] 告警 ${PARSEN} 条 — CLI 输出格式可能已变 (见 ${ERR})"; fi
else
  warn "找不到 ${ERR}"
fi
# 启动自印的关键行，用于发现"路径腐烂"
if [ -f "${OUT}" ]; then
  grep -E "KB 解释器" "${OUT}" 2>/dev/null | tail -1 | sed 's/^/     /'
  # 运行时心跳基线/快照：rss 是否持续爬升、active（在跑子进程）是否泄漏
  HB="$(grep '\[hb' "${OUT}" 2>/dev/null | tail -1)"
  [ -n "${HB}" ] && echo "     ${HB}"
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

# ---------- 8. 备份产物 ----------
# 为什么单独查「产物」而不是查配置：2026-09-12 审计发现「配置已写、机制未跑」是本项目
# 的系统性模式 —— cron 声称每天备份 state.db 却零产物、checkpoints 0 B、curator 0 技能、
# skills.preload 查无解析。配置文件里的字面承诺全部不可信，只有磁盘上的产物算数。
echo
echo "[8] 备份产物"
# 与 backup.sh 的默认输出目录保持一致（仓库的上级目录，而非仓库内）。
BK_DIR="${HERMES_BACKUP_DIR:-$(cd "${WS}/.." && pwd)/_hermes-backups}"
LATEST_BUNDLE="$(ls -t "${BK_DIR}"/*.bundle 2>/dev/null | head -1 || true)"
if [ -n "${LATEST_BUNDLE}" ]; then
  ok "仓库 bundle 存在: $(basename "${LATEST_BUNDLE}") ($(du -h "${LATEST_BUNDLE}" | cut -f1))"
  # 新鲜度：备份超过 7 天等于没有备份（只会给人虚假的安全感）
  if [ -n "$(find "${LATEST_BUNDLE}" -mtime -7 2>/dev/null)" ]; then
    ok "bundle 在 7 天内 ($(date -r "${LATEST_BUNDLE}" '+%Y-%m-%d %H:%M'))"
  else
    bad "bundle 已超 7 天未更新 —— 跑: npm run backup:all（一键双轨）"
  fi
else
  bad "无仓库 bundle —— 跑: npm run backup:all（一键双轨）"
fi
# 引擎侧（~/.hermes）：config/state.db/auth/cron —— 磁盘一挂无法从 git 恢复。
# ⚠️ 实测坑：`hermes backup --quick` 的产物落在 ~/.hermes/state-snapshots/<ts>/，
#    而**不是** -o 指定的路径（-o 对 --quick 无效，会被静默忽略）。断言必须查真实落点。
SNAP_DIR="$HOME/.hermes/state-snapshots"
LATEST_SNAP="$(ls -td "${SNAP_DIR}"/*/ 2>/dev/null | head -1 || true)"
if [ -n "${LATEST_SNAP}" ]; then
  ok "引擎侧快照存在: $(basename "${LATEST_SNAP}") ($(du -sh "${LATEST_SNAP}" 2>/dev/null | cut -f1))"
  if [ -n "$(find "${LATEST_SNAP}" -maxdepth 0 -mtime -7 2>/dev/null)" ]; then
    ok "引擎侧快照在 7 天内 ($(date -r "${LATEST_SNAP}" '+%Y-%m-%d %H:%M'))"
  else
    bad "引擎侧快照超 7 天未更新 —— 跑: npm run backup:all（一键双轨）"
  fi
else
  bad "无引擎侧快照 —— 跑: npm run backup:all（一键双轨）"
fi
# cron daily_backup 的落点。实测从未产出：该 cron 由 hermes 常驻进程调度，而我们的常驻入口是
# gateway（非 serve），不跑 cron 表。state-snapshots 已覆盖 state.db，故这里只提示不算失败。
if [ -z "$(ls -A "$HOME/.hermes/backups" 2>/dev/null)" ]; then
  warn "~/.hermes/backups 为空：config 的 cron daily_backup 从未产出（快照已覆盖其用途，可删该 cron）"
fi

# ---------- 9. 引擎配置不变量 ----------
# 这三条都是「曾经踩过、修好后怕被静默改回去」的坑，各对应一次真实故障。
# 放在 health 里的意义：hermes 升级或手工调整后，一条命令就能发现回退。
echo
echo "[9] 引擎配置不变量"
CFG="$HOME/.hermes/config.yaml"
if [ -f "${CFG}" ]; then
  # 9.1 上下文窗口取值必须处处一致。
  # 故障史：Modelfile 已把模型改为 32K，但 config 四处仍是 16384 → 引擎按旧窗口算预算
  # （tools/budget_config.py，turn_budget = 窗口 30%），工具结果阈值被腰斩，扩窗白做。
  CTX_VALS="$(grep -oE '(context_length|context_window|num_ctx):[[:space:]]*[0-9]+' "${CFG}" 2>/dev/null \
              | grep -oE '[0-9]+$' | sort -u | tr '\n' ' ' | sed 's/ *$//')"
  if [ "${CTX_VALS}" = "32768" ]; then
    ok "上下文窗口处处一致 = 32768"
  else
    bad "上下文窗口不一致或非 32768（实测取值: ${CTX_VALS:-无}）—— 四处 must 同改，见 MEMORY.md"
  fi
  # 9.2 micro_compact 必须关闭（官方默认 False）。
  # 故障史：曾开 true + every_n_turns:1 = 每回合打断一次 prompt-cache 前缀，
  # 实测首字延迟 100% 命中 6.5s / 97% 命中 34.7s（差 5 倍）。
  if grep -qE '^[[:space:]]*micro_compact:[[:space:]]*(false|False|off)' "${CFG}" 2>/dev/null; then
    ok "micro_compact 已关闭（保住 prompt-cache 前缀）"
  else
    bad "micro_compact 处于开启态 —— 每回合打断 cache 前缀，首字延迟会退化 5 倍"
  fi
else
  bad "找不到 ${CFG}"
fi
# 9.3 元技能改名未被 hermes 升级复原。
# 故障史：技能索引里出现 "- hermes-agent:" 会让 system_prompt.py:608 注入
# 「先 skill_view 加载元技能」的激进引导，小模型把任务里的工具名误判触发，
# 加载 15KB 技能文后把「技能已加载」当成交付（5/5 稳定复现）。
META_SKILL="$HOME/.hermes/skills/autonomous-ai-agents/hermes-agent/SKILL.md"
if [ -f "${META_SKILL}" ]; then
  if grep -qE '^name:[[:space:]]*hermes-agent-docs' "${META_SKILL}" 2>/dev/null; then
    ok "元技能已改名 (hermes-agent-docs)，不触发激进引导"
  else
    bad "元技能名被复原为 hermes-agent —— 元技能脱轨会复发，见 MEMORY.md"
  fi
else
  warn "找不到元技能 SKILL.md，跳过（是否换过 skills 目录？）"
fi

# ---------- 10. 本轮新增配置不变量 ----------
# 同样各对应一次真实故障，都是「修好了但怕被静默改回去」的类型。
echo
echo "[10] 检查点与工作目录不变量"
if [ -f "${CFG}" ]; then
  # 10.1 terminal.cwd 必须是绝对路径且等于本工作区。
  # 故障史：gateway 模式下 agent 的 cwd 默认落在 $HOME。后果有二 ——
  #   ① agent 说"在当前目录创建文件"会往家目录乱写；
  #   ② $HOME 是检查点的硬护栏（ensure_checkpoint 里 abs_dir in {"/", home} 直接跳过），
  #      于是影子快照**永不触发**，回退能力形同虚设。修法就是钉死 terminal.cwd。
  # 用 awk 精确取 terminal: 块下的 cwd，避免误抓 config 里其它层级的 cwd 键。
  TERM_CWD="$(awk '/^terminal:/{f=1;next} /^[^[:space:]#]/{f=0} f && /^[[:space:]]*cwd:/{sub(/^[[:space:]]*cwd:[[:space:]]*/,"");print;exit}' "${CFG}" 2>/dev/null)"
  if [ "${TERM_CWD}" = "${WS}" ]; then
    ok "terminal.cwd 钉死在工作区（agent 不会写到家目录，检查点可触发）"
  elif [ -z "${TERM_CWD}" ]; then
    bad "terminal.cwd 缺失 —— agent cwd 会落到 \$HOME，家目录是检查点硬护栏，快照将永不触发"
  else
    bad "terminal.cwd=${TERM_CWD} 与工作区 ${WS} 不一致（检查点会登记到别的目录）"
  fi
  # 10.2 checkpoints.enabled 必须为 true。
  # 故障史：官方默认 checkpoints_enabled=False（run_agent.py 构造参数），v2 起 opt-in。
  # 我们一直以为"这功能是坏的"，实为默认关闭 —— 影子库 0 B / 0 项目空转。
  CP_EN="$(awk '/^checkpoints:/{f=1;next} /^[^[:space:]#]/{f=0} f && /^[[:space:]]*enabled:/{sub(/^[[:space:]]*enabled:[[:space:]]*/,"");print;exit}' "${CFG}" 2>/dev/null)"
  if [ "${CP_EN}" = "true" ]; then
    ok "checkpoints.enabled = true（影子快照写入开）"
  else
    bad "checkpoints.enabled=${CP_EN:-缺失} —— 默认关闭，回退能力不会工作"
  fi
else
  bad "找不到 ${CFG}"
fi
# 10.3 检查点/裁判两个新模块的导出形状完好。
# 意义：导出被改名时 server.js 的接线会静默失效（路由注册不到、裁判不生效），
# 单测跑在直接 require 上反而发现不了。这里锁住接线依赖的那个名字。
if node -e "
  const cp = require('${WS}/lib/checkpoints.js');
  const sj = require('${WS}/lib/stopjudge.js');
  const need = [['checkpoints', cp, 'listCheckpoints'], ['stopjudge', sj, 'createJudge']];
  for (const [n, m, k] of need) if (typeof m[k] !== 'function') { console.error(n + '.' + k); process.exit(1); }
" 2>/dev/null; then
  ok "checkpoints/stopjudge 模块导出完好（server.js 接线依赖项在）"
else
  bad "checkpoints 或 stopjudge 模块导出缺失 —— 路由接线会静默失效"
fi

# ---------- [11] 资源余量与双驻留（2026-09-13 升级规划 v0.3-#2） ----------
echo
echo "[11] 资源余量与双驻留"
# 内存余量：<20% 时双驻留/大前缀推理会出现换页与槽位挤压（实测 29% 即触发模型互挤）
FREE_PCT=$(memory_pressure 2>/dev/null | grep -oE "System-wide memory free percentage: [0-9]+" | grep -oE "[0-9]+" | head -1)
if [ -n "${FREE_PCT}" ] && [ "${FREE_PCT}" -ge 20 ] 2>/dev/null; then
  ok "系统可用内存 ${FREE_PCT}%（≥20% 安全线）"
elif [ -n "${FREE_PCT}" ]; then
  warn "系统可用内存仅 ${FREE_PCT}%（<20%）—— 双模型驻留/长上下文推理可能被挤页"
else
  warn "无法读取内存余量（memory_pressure 不可用）"
fi
# Ollama 服务模式：无头服务（com.zhaocaozheng.ollama）才带 MAX_LOADED_MODELS=2/KV q8_0 等环境配置
# 注意：launchctl list 里"已退出但注册项还在"的行首列是 '-'（无 PID），必须要求 PID 为数字才算运行中
if launchctl list 2>/dev/null | grep -E "^[0-9]+[[:space:]].*com\.zhaocaozheng\.ollama" > /dev/null; then
  ok "Ollama 以无头服务运行（MAX_LOADED_MODELS=2 / KV q8_0 环境生效）"
elif launchctl list 2>/dev/null | grep -E "^[0-9]+[[:space:]].*com\.ollama\.ollama" > /dev/null; then
  warn "Ollama 以 GUI App 运行 —— D1 环境配置（双驻留/KV 量化）未生效，建议切换无头服务"
else
  warn "未检测到 Ollama 服务注册项"
fi
# 驻留模型数（信息项，不计分）
RESIDENT=$(ollama ps 2>/dev/null | tail -n +2 | grep -cE ".+" || true)
echo "  ℹ️  当前驻留模型数: ${RESIDENT}（双驻留 = 2；内存不足时 Ollama 会按需驱逐）"
# 工具集门禁（2026-09-13 升级规划 v0.3-#1）：platform_toolsets 显式名单是 opt-in 语义——
# 拼写错误 / 引擎升级改名都会被引擎【静默丢弃】而无任何报错，症状是工具能力悄悄消失。
# 这里用引擎同款解析函数实测 api_server 平台解析出的工具集数与核心成员，偏离基线即报警。
if [ -x "${HOME}/.hermes/venvs/hermes/bin/python" ]; then
  TOOLSET_CHECK=$(HOME="${HOME}" "${HOME}/.hermes/venvs/hermes/bin/python" -c "
import sys, yaml
sys.path.insert(0, '${HOME}/.hermes/hermes-agent')
config = yaml.safe_load(open('${HOME}/.hermes/config.yaml')) or {}
from hermes_cli.tools_config import _get_platform_tools
resolved = _get_platform_tools(config or {}, 'api_server')
core = {'file', 'terminal', 'memory', 'web', 'skills'}
missing = sorted(core - resolved)
print(f'{len(resolved)}|{\",\".join(missing)}')
" 2>/dev/null || echo "ERR|")
  COUNT="${TOOLSET_CHECK%%|*}"; MISSING="${TOOLSET_CHECK#*|}"
  if [ "${COUNT}" = "ERR" ]; then
    warn "工具集解析探测失败（venv/引擎路径异常）"
  elif [ "${COUNT}" -ge 13 ] 2>/dev/null && [ -z "${MISSING}" ]; then
    ok "api_server 解析工具集 ${COUNT} 个 ≥ 基线 13，核心成员齐全"
  else
    bad "api_server 解析工具集仅 ${COUNT} 个（基线 13）${MISSING:+，核心缺失: ${MISSING}} —— platform_toolsets 名单可能有拼写错误或引擎改名后失效"
  fi
else
  warn "引擎 venv 不存在，跳过工具集门禁"
fi

# ---------- 汇总 ----------
echo
echo "=============================================="
echo " 通过 ${PASS} 项 / 失败 ${FAIL} 项"
echo "=============================================="
if [ "${FAIL}" = "0" ]; then echo "✅ 全部通过"; exit 0; else echo "❌ 存在失败项，见上"; exit 1; fi
