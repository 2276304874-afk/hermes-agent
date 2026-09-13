#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
前缀 token 测量脚本（工具瘦身 v0.3-#1 的量化地基）。

原理：Ollama 无头服务的 llama-server 子进程会把每次请求的
「prompt eval time = X ms / N tokens」指标写进服务日志（ollama-serve.log）。
脚本记录日志当前偏移 → 触发一次真实的工作模式新会话请求 → 解析新增日志，
其中最大的 prompt token 数即为【工作模式会话前缀的真实体积】。

网络边界：UI 请求用 http.client 直连字面量环回 IP 127.0.0.1:4173，
不存在动态 URL，也不经过 DNS（无 rebinding 面）。

用法：
  python3 scripts/measure_prefix_tokens.py            # 测量并输出基线
"""
import json
import re
import sys
import time
import http.client
from pathlib import Path

LOG = Path.home() / "Library/Logs/ollama-serve.log"
UI_HOST = "127.0.0.1"      # 字面量环回 IP：只与本机 UI 服务通信
UI_PORT = 4173
TOKEN_FILE = Path.home() / ".hermes/ui_token"

PROMPT_RE = re.compile(r"prompt eval time =\s*([\d.]+) ms /\s*(\d+) tokens")
EVAL_RE = re.compile(r"eval time =\s*([\d.]+) ms /\s*(\d+) tokens")


def read_token():
    return TOKEN_FILE.read_text(encoding="utf-8").strip()


def log_size():
    try:
        return LOG.stat().st_size
    except OSError:
        return 0


def new_prefix_lines(since):
    """读取 since 偏移之后的新增日志，抽取 prompt/eval 指标行。"""
    if not LOG.exists():
        return [], []
    with LOG.open("r", encoding="utf-8", errors="replace") as f:
        f.seek(since)
        text = f.read()
    prompts = [(float(m.group(1)), int(m.group(2))) for m in PROMPT_RE.finditer(text)]
    evals = [(float(m.group(1)), int(m.group(2))) for m in EVAL_RE.finditer(text)]
    return prompts, evals


def trigger_work_turn():
    """触发一次工作模式新会话（会自动建会话，测完可在 UI 删除）。"""
    body = json.dumps({"prompt": "只回复两个字：收到", "mode": "work"}).encode()
    conn = http.client.HTTPConnection(UI_HOST, UI_PORT, timeout=300)
    conn.request("POST", "/api/chat", body=body,
                 headers={"Content-Type": "application/json",
                          "Authorization": "Bearer " + read_token()})
    resp = conn.getresponse()
    result = {}
    for line in resp:
        line = line.decode("utf-8", "replace").strip()
        if line.startswith("data:") and "elapsed" in line:
            result = json.loads(line[5:])
            break
    conn.close()
    return result


def main():
    offset = log_size()
    print(f"日志偏移基线: {offset} bytes，触发工作模式新会话…（新会话需完整预填充，约 1~2 分钟）", flush=True)
    t0 = time.time()
    done = trigger_work_turn()
    wall = time.time() - t0
    time.sleep(1.0)  # 等最后的指标行落盘
    prompts, evals = new_prefix_lines(offset)
    if not prompts:
        print("未捕获到指标行——确认 Ollama 以无头服务模式运行（ollama-serve.log 存在）", file=sys.stderr)
        sys.exit(1)
    # 工作模式主请求 = 窗口内 token 数最大的一次预填充
    prompts_sorted = sorted(prompts, key=lambda p: p[1], reverse=True)
    prefix_ms, prefix_tokens = prompts_sorted[0]
    gen_ms, gen_tokens = (evals[-1] if evals else (0, 0))
    print(f"\n=== 工作模式前缀测量 ===")
    print(f"墙钟总耗时      : {wall:.1f}s（网关报 {done.get('elapsed')}s）")
    print(f"前缀 token 数   : {prefix_tokens}  ← 工具瘦身的目标基线")
    print(f"预填充耗时      : {prefix_ms/1000:.1f}s → 速度 {prefix_tokens/(prefix_ms/1000):.0f} t/s")
    if gen_tokens:
        print(f"生成            : {gen_tokens} tok / {gen_ms/1000:.1f}s → {gen_tokens/(gen_ms/1000):.1f} t/s")
    if len(prompts_sorted) > 1:
        print(f"窗口内其他预填充（辅助任务等）: {[p[1] for p in prompts_sorted[1:5]]} tok")
    print("\n提示: v0.3-#1 工具瘦身完成后重跑本脚本对比前缀体积；验收线 = 前缀 ≤ 9k token。")


if __name__ == "__main__":
    main()
