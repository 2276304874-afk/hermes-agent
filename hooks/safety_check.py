#!/usr/bin/env python3
"""
Hermes pre_tool_call 安全拦截 hook。

stdin:  JSON  {hook_event_name, tool_name, tool_input, session_id, cwd, extra}
stdout: JSON  {"action": "continue" | "block", "message": "..."}

拦截规则：
  - 默认拦截高风险 terminal 命令（rm -rf / 、mv 到系统目录、sudo、dd、mkfs 等）
  - 会话级放行：会话 id 出现在 ~/.hermes/ui_bypass_sessions.json 且未过期时全部放行
    （用户在前端明确批准后由 server.js 写入；见下方"放行为什么改成会话级"）
  - 环境变量 HERMES_UI_BYPASS_SAFETY=1 时全部放行（-z 路径的旧机制，保留兼容）
  - 非 terminal 工具直接放行
  - 解析失败时 fail-open（由 config 中的 fail_closed 兜底）

  ⚠️ 这是**纵深防御（blocklist）而非硬边界**：编码变形命令（如 `bash -c $'…'`、
     `find / -delete`、`curl … | sh`、管道下载后执行）可绕过正则；解析失败也会 fail-open。
     它降低误操作与脚本误伤风险，但**不能当作"已锁死"**——敏感操作仍需人工在前端确认。

放行为什么从"环境变量"改成"会话级文件"：
  `hermes -z` 是每轮新起进程，server.js 能把 HERMES_UI_BYPASS_SAFETY=1 注入那一轮的进程，
  所以"本次请求放行"用 env 就够了。但 `hermes serve` 是**常驻**进程 —— env 在 spawn 时
  就固定了，无法按请求改。若为了放行而给常驻进程常开 bypass，等于永久关闭安全拦截。
  因此放行信号改为落在一个**按会话、带 TTL** 的文件里：server.js 写，hook 读。
  env 那条路保留，是为了 `-z` 回退路径继续可用。
"""
import json
import os
import re
import sys
import time

# 先整块读入 stdin（而不是各处 json.load(sys.stdin)），这样才能既做调试转储又留给后面解析。
raw_in = ""
try:
    raw_in = sys.stdin.read()
except Exception:
    raw_in = ""

HOME = os.path.expanduser("~")
BYPASS_FILE = os.path.join(HOME, ".hermes", "ui_bypass_sessions.json")

# 调试开关：~/.hermes/hook_debug 存在时，把每次调用原样追加到 hook_calls.jsonl。
# 用"文件存在"而非环境变量来控制，是因为 serve 常驻、env 改不了；
# 文件随时可增删，排查完删掉即可。生产环境该文件不存在，零开销。
if os.path.exists(os.path.join(HOME, ".hermes", "hook_debug")):
    try:
        with open(os.path.join(HOME, ".hermes", "hook_calls.jsonl"), "a", encoding="utf-8") as fh:
            fh.write(json.dumps({"ts": time.time(), "pid": os.getpid(), "raw": raw_in}, ensure_ascii=False) + "\n")
    except Exception:
        pass

# 用户在前端确认"允许危险操作"后，后端会把此 env 注入 Hermes 进程（-z 路径）
if os.environ.get("HERMES_UI_BYPASS_SAFETY") == "1":
    sys.stdout.write(json.dumps({"action": "continue"}))
    sys.exit(0)

try:
    payload = json.loads(raw_in) if raw_in.strip() else {}
except Exception:
    # 解析不出输入就放行，避免误伤；fail_closed 由 Hermes 侧的 timeout/崩溃兜底
    sys.stdout.write(json.dumps({"action": "continue"}))
    sys.exit(0)

tool_name = payload.get("tool_name", "")
tool_input = payload.get("tool_input") or {}

# 会话级放行（serve 路径）：会话 id 命中且未过期时放行。
# 判断放在"非 terminal 就直接放行"之前，因为放行本就不该区分工具类型。
session_id = str(payload.get("session_id") or "")
if session_id:
    try:
        with open(BYPASS_FILE, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        expiry = (data.get("sessions") or {}).get(session_id)
        if expiry and float(expiry) > time.time():
            sys.stdout.write(json.dumps({"action": "continue"}))
            sys.exit(0)
    except Exception:
        # 文件缺失/损坏 → 按未放行处理（安全侧默认），不因读文件失败而放行
        pass

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
        # C2 拦截反馈可读化（2026-09-13）：原消息只给原因+命令，模型容易原地重试/
        # 变换写法再撞墙。补一段模型可读的行动指引（勿绕过 / 说明必要性等批准 / 给替代方案）。
        sys.stdout.write(json.dumps({
            "action": "block",
            "message": (
                f"安全拦截（{reason}）：{command[:120]}\n"
                "该命令触发了安全策略。请勿重试或变换写法绕过；"
                "向用户说明执行此操作的必要性与风险，等待用户在界面批准放行后重试，"
                "或改用安全的替代方案完成任务。"
            )
        }))
        sys.exit(0)

sys.stdout.write(json.dumps({"action": "continue"}))
