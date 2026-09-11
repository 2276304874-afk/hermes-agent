#!/usr/bin/env python3
# =============================================================================
# test/safety.test.py —— pre_tool_call 安全 hook 回归测试（R1 耦合锁死）
#
# 为什么需要它：hooks/safety_check.py 与 lib/safety.js 之间靠一个**隐式耦合**放行
# 高危命令——hook 读 payload.session_id，去 ~/.hermes/ui_bypass_sessions.json 里查
# 该会话是否未过期。这条耦合此前只在一次端到端手测里验证过，没有任何自动化断言；
# 一旦 gateway 改了传给 hook 的 session_id 字段名/取值，放行会静默失效或误放行。
# 本测试把"session_id 能匹配放行文件"固化成回归防线。
#
# 用法：
#   python3 test/safety.test.py
#   退出码 0 = 全过 / 1 = 有失败
#
# 隔离：每个用例用独立临时 HOME（hook 的 BYPASS_FILE = expanduser("~")/.hermes/...），
# 不碰本机 ~/.hermes。
# =============================================================================
import json
import os
import subprocess
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HOOK = os.path.join(ROOT, "hooks", "safety_check.py")

pass_n = 0
fail_n = 0
failures = []


def ok(name, detail=""):
    global pass_n
    pass_n += 1
    print(f"  ✅ {name}{(' — ' + detail) if detail else ''}")


def bad(name, detail=""):
    global fail_n
    fail_n += 1
    failures.append(f"{name}{(' — ' + detail) if detail else ''}")
    print(f"  ❌ {name}{(' — ' + detail) if detail else ''}")


def check(cond, name, detail=""):
    ok(name, detail) if cond else bad(name, detail)


def run_hook(payload, env_extra=None, raw_stdin=None):
    """调用 hook，返回解析后的 stdout JSON。"""
    home = tempfile.mkdtemp(prefix="hermes_hook_")
    env = dict(os.environ)
    env["HOME"] = home
    if env_extra:
        env.update(env_extra)
    hermes_dir = os.path.join(home, ".hermes")
    os.makedirs(hermes_dir, exist_ok=True)
    stdin = raw_stdin if raw_stdin is not None else json.dumps(payload)
    p = subprocess.run(
        [sys.executable, HOOK],
        input=stdin, capture_output=True, text=True, env=env, timeout=30,
    )
    try:
        return json.loads(p.stdout), p.stdout
    except Exception:
        return {"_raw": p.stdout, "_rc": p.returncode}, p.stdout


def write_bypass(home, sessions):
    path = os.path.join(home, ".hermes", "ui_bypass_sessions.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump({"sessions": sessions}, fh)


def home_of():
    """取上一次 run_hook 用的临时 HOME——这里改为显式传 home。"""
    return None


print(f"安全 hook 回归测试 → {HOOK}")

# ---------- 用例 1：无放行文件 + 高危命令 → block ----------
print("用例 1：无放行文件，terminal rm -rf / → 应 block")
home = tempfile.mkdtemp(prefix="hermes_hook_")
env = dict(os.environ); env["HOME"] = home
os.makedirs(os.path.join(home, ".hermes"), exist_ok=True)
out, _ = run_hook({"tool_name": "terminal", "tool_input": {"command": "rm -rf /"}, "session_id": "s0"}, {"HOME": home})
check(out.get("action") == "block", "无条目时高危命令被拦截", f"action={out.get('action')}")

# ---------- 用例 2：未过期条目命中 → continue ----------
print("用例 2：session 命中且未过期 → 应 continue")
home = tempfile.mkdtemp(prefix="hermes_hook_")
os.makedirs(os.path.join(home, ".hermes"), exist_ok=True)
write_bypass(home, {"s1": time.time() + 100})
out, _ = run_hook({"tool_name": "terminal", "tool_input": {"command": "rm -rf /tmp/x"}, "session_id": "s1"}, {"HOME": home})
check(out.get("action") == "continue", "未过期放行生效", f"action={out.get('action')}")

# ---------- 用例 3：过期条目 → block ----------
print("用例 3：session 命中但已过期 → 应 block")
home = tempfile.mkdtemp(prefix="hermes_hook_")
os.makedirs(os.path.join(home, ".hermes"), exist_ok=True)
write_bypass(home, {"s2": time.time() - 10})
out, _ = run_hook({"tool_name": "terminal", "tool_input": {"command": "rm -rf /tmp/x"}, "session_id": "s2"}, {"HOME": home})
check(out.get("action") == "block", "过期条目回到默认拦截", f"action={out.get('action')}")

# ---------- 用例 4：畸形 stdin → fail-open(continue)，记录为已知行为 ----------
print("用例 4：畸形 stdin → hook fail-open(continue)")
home = tempfile.mkdtemp(prefix="hermes_hook_")
os.makedirs(os.path.join(home, ".hermes"), exist_ok=True)
out, _ = run_hook(None, {"HOME": home}, raw_stdin="{ this is not json")
check(out.get("action") == "continue", "解析失败 fail-open（已知行为，由 config.fail_closed 兜底）", f"action={out.get('action')}")

# ---------- 用例 5：HERMES_UI_BYPASS_SAFETY=1 → continue（-z 旧机制兼容） ----------
print("用例 5：HERMES_UI_BYPASS_SAFETY=1 → 应 continue")
home = tempfile.mkdtemp(prefix="hermes_hook_")
os.makedirs(os.path.join(home, ".hermes"), exist_ok=True)
out, _ = run_hook({"tool_name": "terminal", "tool_input": {"command": "rm -rf /"}, "session_id": "sX"}, {"HOME": home, "HERMES_UI_BYPASS_SAFETY": "1"})
check(out.get("action") == "continue", "env 放行兼容 -z 路径", f"action={out.get('action')}")

# ---------- 用例 6：非 terminal 工具 → continue（不拦截 read_file 等） ----------
print("用例 6：非 terminal 工具 → 应 continue")
home = tempfile.mkdtemp(prefix="hermes_hook_")
os.makedirs(os.path.join(home, ".hermes"), exist_ok=True)
out, _ = run_hook({"tool_name": "read_file", "tool_input": {"path": "/etc/passwd"}, "session_id": "s0"}, {"HOME": home})
check(out.get("action") == "continue", "非 terminal 工具直接放行", f"action={out.get('action')}")

print("")
print(f"结果：{pass_n} 通过 / {fail_n} 失败")
if failures:
    print("失败项：")
    for f in failures:
        print("  - " + f)
sys.exit(1 if fail_n else 0)
