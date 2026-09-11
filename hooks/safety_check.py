#!/usr/bin/env python3
"""
Hermes pre_tool_call 安全拦截 hook。

stdin:  JSON  {hook_event_name, tool_name, tool_input, session_id, cwd, extra}
stdout: JSON  {"action": "continue" | "block", "message": "..."}

拦截规则：
  - 默认拦截高风险 terminal 命令（rm -rf / 、mv 到系统目录、sudo、dd、mkfs 等）
  - 环境变量 HERMES_UI_BYPASS_SAFETY=1 时全部放行（用户在前端明确批准后使用）
  - 非 terminal 工具直接放行
  - 解析失败时 fail-open（由 config 中的 fail_closed 兜底）
"""
import json
import os
import re
import sys

# 用户在前端确认"允许危险操作"后，后端会把此 env 注入 Hermes 进程
if os.environ.get("HERMES_UI_BYPASS_SAFETY") == "1":
    sys.stdout.write(json.dumps({"action": "continue"}))
    sys.exit(0)

try:
    payload = json.load(sys.stdin)
except Exception:
    # 解析不出输入就放行，避免误伤；fail_closed 由 Hermes 侧的 timeout/崩溃兜底
    sys.stdout.write(json.dumps({"action": "continue"}))
    sys.exit(0)

tool_name = payload.get("tool_name", "")
tool_input = payload.get("tool_input") or {}

# 只拦 terminal 工具；read_file / write_file / search 等直接放行
if tool_name != "terminal":
    sys.stdout.write(json.dumps({"action": "continue"}))
    sys.exit(0)

command = (tool_input.get("command") or "").strip()
if not command:
    sys.stdout.write(json.dumps({"action": "continue"}))
    sys.exit(0)

# 高风险模式：(正则, 原因)
DANGEROUS_PATTERNS = [
    (r"\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+/",        "递归删除根目录"),
    (r"\brm\s+-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*\s+/",        "递归删除根目录"),
    (r"\brm\s+-rf?\s+~/",                                  "删除用户目录"),
    (r"\brm\s+-rf?\s+\$HOME",                              "删除用户目录"),
    (r"\brm\s+-rf?\s+/etc",                                "删除系统配置"),
    (r"\brm\s+-rf?\s+/usr",                                "删除系统程序"),
    (r"\brm\s+-rf?\s+/bin",                                "删除系统命令"),
    (r"\brm\s+-rf?\s+/sbin",                               "删除系统命令"),
    (r"\brm\s+-rf?\s+/boot",                               "删除引导分区"),
    (r"\brm\s+-rf?\s+/var",                                "删除系统数据"),
    (r"\brm\s+-rf?\s+/lib",                                "删除系统库"),
    (r"\brmdir\s+/etc",                                    "删除系统目录"),
    (r"\brmdir\s+/usr",                                    "删除系统目录"),
    (r"\brmdir\s+/bin",                                    "删除系统目录"),
    (r"\bmv\s+.*\s+/etc/",                                 "移动到系统目录"),
    (r"\bmv\s+.*\s+/usr/",                                 "移动到系统目录"),
    (r"\bmv\s+.*\s+/bin/",                                 "移动到系统目录"),
    (r"\bmv\s+.*\s+/sbin/",                                "移动到系统目录"),
    (r"\bmv\s+.*\s+/boot/",                                "移动到引导分区"),
    (r"\bcp\s+.*\s+/etc/",                                 "覆盖系统配置"),
    (r"\bsudo\b",                                          "需要管理员权限"),
    (r"\bdd\s+.*\bof=/dev/",                               "写入磁盘设备"),
    (r">\s*/dev/sd[a-z]",                                  "覆盖磁盘设备"),
    (r"\bmkfs\b",                                          "格式化磁盘"),
    (r"chmod\s+-R\s+777",                                  "危险权限放开"),
    (r"chown\s+-R\s+.*\s+/",                               "递归改宿主"),
    (r":\(\)\s*\{[^}]*\}\s*;\s*:\s*$",                     "fork 炸弹"),
    (r"\bshutdown\b",                                      "关机"),
    (r"\breboot\b",                                        "重启"),
    (r"\bhalt\b",                                          "停机"),
]

cmd_lower = command.lower()
for pattern, reason in DANGEROUS_PATTERNS:
    if re.search(pattern, cmd_lower):
        sys.stdout.write(json.dumps({
            "action": "block",
            "message": f"安全拦截（{reason}）: {command[:120]}"
        }))
        sys.exit(0)

sys.stdout.write(json.dumps({"action": "continue"}))
