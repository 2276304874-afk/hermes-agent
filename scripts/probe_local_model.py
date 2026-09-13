#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
本地 Ollama 模型编码适配探针（v2，修复内存解析 + 超时 + 压力采样）。

对每个指定模型发一个"带 function calling 的编码任务"：
  用 get_git_log 查仓库最近提交 -> 用 read_file 读其中一个文件 -> 一句话总结项目用途。
记录：真实内存占用(ollama ps SIZE)、首 token 延迟、总耗时、是否生成 tool_calls、任务是否完成、
      系统内存压力级别(开始/结束, memory_pressure)。
每个模型测完即 `ollama stop` 驱逐，保证单跑不共存（16GB 机器避免双 14B 同驻爆内存）。

用法：
  python3 scripts/probe_local_model.py qwen3:8b qwen2.5:14b qwen3:14b gemma4:e4b
"""
import sys, json, time, urllib.request, subprocess

WS = "/Users/zhaocaozheng/WorkBuddy/赫尔墨斯特工"
MODELS = sys.argv[1:] or ["qwen3:8b"]

TOOLS = [
    {"type": "function", "function": {
        "name": "get_git_log",
        "description": "返回指定 git 仓库最近的 N 个提交(哈希+消息)",
        "parameters": {"type": "object", "properties": {
            "count": {"type": "integer", "description": "提交数量,默认3"}}, "required": ["count"]}}},
    {"type": "function", "function": {
        "name": "read_file",
        "description": "读取指定文件的文本内容",
        "parameters": {"type": "object", "properties": {
            "path": {"type": "string", "description": "绝对路径"}}, "required": ["path"]}}},
]

PROMPT = (
    f"你是本地编码助手。请实际操作:先用 get_git_log 查看 {WS} 最近3个提交,"
    f"挑一个提交用 read_file 读取其中一个被改动的文件,然后用一句话总结这个项目是做什么的。"
    f"必须真的调用这两个工具,不要凭记忆编造。"
)


def chat_stream(model, messages, timeout=600):
    body = json.dumps({
        "model": model, "messages": messages, "tools": TOOLS,
        "stream": True, "options": {"enable_thinking": False},
    }).encode()
    req = urllib.request.Request("http://localhost:11434/api/chat", data=body,
                                 headers={"Content-Type": "application/json"})
    return urllib.request.urlopen(req, timeout=timeout)


def mem_size(model):
    """返回 ollama ps 中该模型的 SIZE 列，如 '9.0 GB'；未常驻返回 '?'。"""
    try:
        out = subprocess.run(["ollama", "ps"], capture_output=True, text=True, timeout=10).stdout
    except Exception:
        return "?"
    for ln in out.splitlines():
        if model in ln or model.split(":")[0] in ln:
            p = ln.split()
            if len(p) >= 4:
                sz = p[2]
                if len(p) > 3 and p[3] in ("GB", "MB"):
                    sz += " " + p[3]
                return sz
    return "?"


def mem_pressure():
    try:
        out = subprocess.run(["memory_pressure"], capture_output=True, text=True, timeout=10).stdout
    except Exception:
        return "?"
    for ln in out.splitlines():
        if "pressure" in ln.lower() and "level" in ln.lower():
            return ln.strip()
    return "?"


def stop_model(model):
    try:
        subprocess.run(["ollama", "stop", model], capture_output=True, text=True, timeout=30)
    except Exception:
        pass


results = []
for m in MODELS:
    print(f"\n=== 探针: {m} ===", flush=True)
    print(f"  基线内存压力: {mem_pressure()}", flush=True)
    mem_before = mem_size(m)
    t0 = time.time()
    first_tok = None
    mem_during = None
    tool_calls = []
    content = ""
    ok = True
    err = ""
    try:
        resp = chat_stream(m, [{"role": "user", "content": PROMPT}])
        for raw in resp:
            raw = raw.strip()
            if not raw:
                continue
            try:
                obj = json.loads(raw)
            except Exception:
                continue
            msg = obj.get("message", {})
            if first_tok is None and (msg.get("content") or msg.get("tool_calls")):
                first_tok = time.time() - t0
                mem_during = mem_size(m)  # 首个 chunk 时模型已加载
            if msg.get("content"):
                content += msg["content"]
            if msg.get("tool_calls"):
                tool_calls.extend(msg["tool_calls"])
            if obj.get("done"):
                break
    except Exception as e:
        ok = False
        err = str(e)
    elapsed = time.time() - t0
    mem_after = mem_size(m)
    funcs = [tc.get("function", {}).get("name") for tc in tool_calls]
    has_log = "get_git_log" in funcs
    has_read = "read_file" in funcs
    tool_any = len(funcs) > 0
    task_done = ok and has_log and has_read and len(content.strip()) > 10
    rec = {
        "model": m, "mem_before": mem_before, "mem_during": mem_during, "mem_after": mem_after,
        "first_tok_s": round(first_tok, 1) if first_tok else None,
        "elapsed_s": round(elapsed, 1), "tool_calls": funcs,
        "tool_any": tool_any, "has_log": has_log, "has_read": has_read,
        "content_len": len(content), "task_done": task_done, "ok": ok, "err": err,
    }
    results.append(rec)
    print(f"  内存(加载中): {mem_during} | 加载后: {mem_after} | 首token: {rec['first_tok_s']}s | 总: {rec['elapsed_s']}s", flush=True)
    print(f"  tool_calls: {funcs} | 生成工具调用: {tool_any} | 任务完成: {task_done}", flush=True)
    if content:
        print(f"  回答预览: {content[:240].strip()!r}", flush=True)
    if err:
        print(f"  错误: {err}", flush=True)
    print(f"  结束内存压力: {mem_pressure()}", flush=True)
    stop_model(m)
    time.sleep(3)

print("\n\n=== 汇总 ===", flush=True)
print(f"{'模型':<22}{'加载内存':<10}{'首tok':<9}{'总耗时':<9}{'生成工具':<8}{'toolCalls':<26}{'完成':<6}", flush=True)
for r in results:
    print(f"{r['model']:<22}{str(r['mem_during']):<10}{str(r['first_tok_s']):<9}{str(r['elapsed_s']):<9}{str(r['tool_any']):<8}{str(r['tool_calls']):<26}{str(r['task_done']):<6}", flush=True)
