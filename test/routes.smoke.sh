#!/bin/bash
# =============================================================================
# 赫尔墨斯特工 · 路由清单冒烟测试（P1-3 拆分的回归网）
#
# 目的：拆分/改动路由层后，证明「每一条路由都还被正确登记」。
# 判据不是 200，而是**命中**：校验失败(400)/未配置(404)/无鉴权(401) 都算通过，
# 只有落到兜底 404「not found」才说明路由丢了。
#
# 设计原则：只打「会被参数校验拦下」的请求，绝不触发真实副作用
# （不建 cron、不装技能、不写记忆、不删会话）。
#
# 用法: bash test/routes.smoke.sh [port]      # 默认 4173
#       HERMES_TOKEN=xxx bash test/routes.smoke.sh 4199
# 退出码: 0 = 全通过; 1 = 有失败
# =============================================================================
set -uo pipefail

PORT="${1:-4173}"
BASE="http://127.0.0.1:${PORT}"
TOKEN="${HERMES_TOKEN:-$(cat "$HOME/.hermes/ui_token" 2>/dev/null || true)}"

PASS=0; FAIL=0
ok()  { echo "  ✅ $1"; PASS=$((PASS+1)); }
bad() { echo "  ❌ $1"; FAIL=$((FAIL+1)); }

# chk <描述> <期望码> <METHOD> <路径> [json body] [是否带 token: 1/0]
chk() {
  local desc="$1" want="$2" m="$3" p="$4" body="${5:-}" auth="${6:-1}"
  local code
  local -a args=(-s -m 15 -o /dev/null -w '%{http_code}' -X "$m")
  [ "${auth}" = "1" ] && args+=(-H "Authorization: Bearer ${TOKEN}")
  if [ -n "${body}" ]; then
    args+=(-H "Content-Type: application/json" -d "${body}")
  fi
  code="$(curl "${args[@]}" "${BASE}${p}")"
  if [ "${code}" = "${want}" ]; then
    ok "${desc} — ${m} ${p} → ${code}"
  else
    bad "${desc} — ${m} ${p} → ${code}（期望 ${want}）"
  fi
}

echo "=============================================="
echo " 路由清单冒烟测试"
echo " 目标: ${BASE}"
echo "=============================================="

# ---------- 0. 服务存活 ----------
echo
echo "[0] 服务存活"
code="$(curl -s -m 5 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer ${TOKEN}" "${BASE}/api/health")"
if [ "${code}" = "200" ]; then ok "/api/health → 200"; else bad "/api/health → ${code}（服务没起来？）"; echo; echo "跳过后续检查"; exit 1; fi

# ---------- 1. 公开路由（认证前）----------
echo
echo "[1] 公开路由（无需 token）"
chk "KB 查看器页面"        200 GET  "/kb"                      "" 0
# P2-10 不变量：KB 数据接口必须被认证闸门挡住。
# 它们曾经是公开路由（原 4174 独立服务遗留），而 KB 内含 MEMORY.md 私有笔记 ——
# 一旦有人把 HOST 改回 0.0.0.0 开局域网，公开的 KB 就等于对全网段裸奔。
chk "KB 列表需认证"        401 GET  "/api/kb/list?cat=all"     "" 0
chk "KB 检索需认证"        401 GET  "/api/kb/search?q=launchd" "" 0
chk "KB 状态需认证"        401 GET  "/api/kb/status"           "" 0
chk "KB slash 需认证"      401 GET  "/api/kb?q=launchd"        "" 0
chk "主界面静态文件"       200 GET  "/"                        "" 0
chk "认证闸门（无 token）" 401 GET  "/api/health"              "" 0

# ---------- 2. 认证组 · GET ----------
echo
echo "[2] 认证路由 · GET"
chk "健康"     200 GET "/api/health"   ""
chk "Ollama 状态" 200 GET "/api/status" ""
chk "用量"     200 GET "/api/usage"    ""
chk "模型列表" 200 GET "/api/models"   ""
chk "认证探测" 200 GET "/api/auth"     ""
chk "会话列表" 200 GET "/api/sessions" ""
chk "云端配置" 200 GET "/api/providers" ""
chk "MCP 列表" 200 GET "/api/mcp"      ""
chk "定时任务" 200 GET "/api/cron"     ""
chk "技能列表" 200 GET "/api/skills"   ""
chk "记忆读取" 200 GET "/api/memory"   ""
# P2-10：带 token 时必须正常（上面已断言无 token 是 401，两边合起来才是完整的不变量）
chk "KB 列表" 200 GET "/api/kb/list?cat=all" ""
chk "KB 检索" 200 GET "/api/kb/search?q=launchd" ""
chk "KB 状态" 200 GET "/api/kb/status" ""
chk "KB slash 召回" 200 GET "/api/kb?q=launchd" ""

# 用真实会话验证 history / export（无会话则跳过）
SID="$(curl -s -m 8 -H "Authorization: Bearer ${TOKEN}" "${BASE}/api/sessions" 2>/dev/null \
       | python3 -c 'import sys,json;d=json.load(sys.stdin);s=d.get("sessions",[]);print(s[0]["id"] if s else "")' 2>/dev/null || echo "")"
if [ -n "${SID}" ]; then
  chk "会话历史 (${SID})" 200 GET "/api/history?session=${SID}"    ""
  chk "会话导出 (${SID})" 200 GET "/api/session/export?session=${SID}" ""
else
  echo "  ⚠️  无会话数据，跳过 /api/history 与 /api/session/export"
  chk "会话历史（缺参应 400）" 400 GET "/api/history" ""
fi

# ---------- 2b. 解析降级不变量（P1-4）----------
# 健康态下这三个「CLI 文本解析」接口不得报 degraded。一旦报，说明解析器已与
# hermes CLI 的实际输出格式脱节（历史上表现为"功能凭空消失"），必须当天暴露。
echo
echo "[2b] 解析降级不变量（健康态不得 degraded）"
chk_nodegraded() {
  local desc="$1" path="$2" body warn
  body="$(curl -s -m 20 -H "Authorization: Bearer ${TOKEN}" "${BASE}${path}" 2>/dev/null)"
  if printf '%s' "${body}" | grep -q '"degraded":true'; then
    warn="$(printf '%s' "${body}" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("warning",""))' 2>/dev/null || true)"
    bad "${desc} — 报 degraded（${warn}）"
  else
    ok "${desc} — 未降级"
  fi
}
chk_nodegraded "会话列表解析" "/api/sessions"
chk_nodegraded "MCP 列表解析" "/api/mcp"
chk_nodegraded "定时任务解析" "/api/cron"

# ---------- 3. 认证组 · POST（全部走参数校验，不产生副作用）----------
echo
echo "[3] 认证路由 · POST（参数校验路径，零副作用）"
chk "对话（空 prompt）"     400 POST "/api/chat"            '{}'
chk "中断（无活动会话）"    200 POST "/api/stop"            '{}'
chk "会话重命名（坏 id）"   400 POST "/api/session/rename"  '{"id":"bad","title":"x"}'
chk "会话删除（坏 id）"     400 POST "/api/session/delete"  '{"id":"bad"}'
chk "云端保存（未知 id）"   400 POST "/api/providers/save"  '{"id":"__nope__"}'
chk "云端删除（未知 id）"   200 POST "/api/providers/delete" '{"id":"__nope__"}'
chk "云端健康（未配置）"    404 POST "/api/provider/health" '{"id":"deepseek"}'
chk "本地预热"              200 POST "/api/prewarm"         '{}'
chk "图片理解（缺图）"      400 POST "/api/vision"          '{}'
chk "语音转写（缺音频）"    400 POST "/api/transcribe"      '{}'
chk "文件上传（缺数据）"    400 POST "/api/upload"          '{}'
chk "追问推荐（空答案）"    200 POST "/api/suggest"         '{"answer":"","model":""}'
chk "MCP 新增（缺参数）"    400 POST "/api/mcp/add"         '{}'
chk "MCP 删除（坏名）"      400 POST "/api/mcp/remove"      '{"name":"bad name!"}'
chk "定时创建（缺字段）"    400 POST "/api/cron/create"     '{}'
chk "定时操作（坏 id）"     400 POST "/api/cron/action"     '{"id":"zz","action":"pause"}'
chk "定时操作（坏动作）"    400 POST "/api/cron/action"     '{"id":"abcdef","action":"bogus"}'
chk "技能检索（缺 query）"  400 POST "/api/skills/search"   '{}'
chk "技能语义找（缺 query）" 400 POST "/api/skills/find"    '{}'
chk "技能安装（坏名）"      400 POST "/api/skills/install"  '{"name":"a b"}'
chk "技能卸载（坏名）"      400 POST "/api/skills/uninstall" '{"name":"a b"}'

# ---------- 4. 兜底 ----------
echo
echo "[4] 兜底 404"
chk "未知路由"  404 GET  "/api/__definitely_not_a_route__" ""
chk "未知静态"  404 GET  "/__definitely_not_a_file__"       "" 0

echo
echo "=============================================="
echo " 通过 ${PASS} 项 / 失败 ${FAIL} 项"
echo "=============================================="
if [ "${FAIL}" = "0" ]; then echo "✅ 全部通过（路由无遗漏）"; exit 0; else echo "❌ 有失败项，见上"; exit 1; fi
