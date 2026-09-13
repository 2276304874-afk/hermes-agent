#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
多轮对话探针（v1，零依赖纯本地）——补 probe_local_model.py 只测单轮的缺口。

与单轮版的差异：
  1. 客户端【真实执行】模型发出的工具调用并回灌结果（单轮版只检查 JSON 是否生成）；
  2. 跨 3 轮对话：轮1 查 git log → 轮2 读文件 → 轮3 不给工具、要求凭记忆复述
     轮1 的提交消息 + 轮2 的文件内容 → 直接检验跨轮上下文保持；
  3. 轮3 的答案与探针自己采到的【地面真值】比对，防"编造式通过"。

网络边界：唯一的通信目标是本机 Ollama，用 http.client 直连【字面量环回 IP】
127.0.0.1:11434，不存在动态 URL，也不经过 DNS（无 rebinding 面）。

用法：
  python3 scripts/probe_multiround.py [model ...]     # 默认 qwen3.5:9b
"""
import sys, json, time, http.client, subprocess
from pathlib import Path

WS = "/Users/zhaocaozheng/WorkBuddy/赫尔墨斯特工"
MODELS = sys.argv[1:] or ["qwen3.5:9b"]
NUM_CTX = 8192

OLLAMA_HOST = "127.0.0.1"   # 字面量环回 IP，探针只与本机 Ollama 通信
OLLAMA_PORT = 11434

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

R1 = "请用 get_git_log 查看这个仓库最近 3 个提交，然后告诉我最新一条提交的消息。"
R2 = "很好。请再用 read_file 读取仓库根目录下的 package.json 文件，告诉我里面 name 字段的值。"
R3 = ("不调用任何工具，只凭我们刚才的对话回答，一句话各答一问："
      "1) 最新一条 git 提交的消息是什么？ 2) 那个文件里 name 字段的值是什么？")


# ---------- 工具真实执行（地面真值在这里产生） ----------
def exec_tool(name, args):
    """真实执行工具并返回 (工具输出文本, 该输出是否成功)。"""
    try:
        if name == "get_git_log":
            count = int(args.get("count", 3))
            out = subprocess.run(
                ["git", "-C", WS, "log", f"-{count}", "--pretty=%h %s"],
                capture_output=True, text=True, timeout=10)
            return out.stdout.strip(), out.returncode == 0
        if name == "read_file":
            p = Path(args.get("path", ""))
            if not p.is_absolute():
                p = Path(WS) / p
            return p.read_text(encoding="utf-8", errors="replace")[:4000], p.exists()
    except Exception as e:
        return f"工具执行异常: {e}", False
    return f"未知工具: {name}", False


def collect_ground_truth():
    """探针自己采一份真值，用于轮3比对。"""
    gt = {}
    out, ok = exec_tool("get_git_log", {"count": 3})
    gt["commit_subject"] = out.splitlines()[0].strip() if ok and out else ""
    out, ok = exec_tool("read_file", {"path": "package.json"})
    try:
        gt["pkg_name"] = json.loads(out).get("name", "")
    except Exception:
        gt["pkg_name"] = ""
    return gt


# ---------- Ollama 调用 ----------
def chat_once(model, messages):
    """发一轮 /api/chat（流式），返回 (assistant_message, first_tok_s, elapsed_s)。

    Ollama 流式响应是增量分片：content 逐段追加、tool_calls 在中间分片出现，
    必须跨 chunk 累积，只留最后一个 chunk 会把工具调用和正文全丢掉。
    """
    body = json.dumps({
        "model": model, "messages": messages, "tools": TOOLS,
        "stream": True, "options": {"num_ctx": NUM_CTX, "enable_thinking": False},
    }).encode()
    conn = http.client.HTTPConnection(OLLAMA_HOST, OLLAMA_PORT, timeout=600)
    conn.request("POST", "/api/chat", body=body,
                 headers={"Content-Type": "application/json"})
    resp = conn.getresponse()
    t0 = time.time()
    first_tok = None
    content = ""
    tool_calls = []
    for line in resp:
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except Exception:
            continue
        m = obj.get("message", {})
        if first_tok is None and (m.get("content") or m.get("tool_calls")):
            first_tok = round(time.time() - t0, 1)
        if m.get("content"):
            content += m["content"]
        if m.get("tool_calls"):
            tool_calls.extend(m["tool_calls"])
        if obj.get("done"):
            break
    conn.close()
    return {"content": content, "tool_calls": tool_calls}, first_tok, round(time.time() - t0, 1)


def run_rounds(model):
    """对一个模型跑完整 3 轮，返回逐轮记录。"""
    messages = []
    rounds = []
    for idx, user_text in enumerate((R1, R2, R3), 1):
        messages.append({"role": "user", "content": user_text})
        rec = {"round": idx, "tool_calls": [], "first_tok_s": None, "elapsed_s": None,
               "tool_iters": 0, "ok": True, "err": "", "answer": ""}
        try:
            for _ in range(4):  # 单轮最多 4 次工具迭代，防死循环
                msg, ft, el = chat_once(model, messages)
                rec["first_tok_s"] = rec["first_tok_s"] or ft
                rec["elapsed_s"] = (rec["elapsed_s"] or 0) + el
                calls = msg.get("tool_calls") or []
                if calls:
                    messages.append({"role": "assistant", "content": msg.get("content") or "",
                                     "tool_calls": calls})
                    for tc in calls:
                        fn = tc.get("function", {})
                        out, ok = exec_tool(fn.get("name"), fn.get("arguments", {}))
                        rec["tool_calls"].append(fn.get("name"))
                        messages.append({"role": "tool", "content": out if ok else f"失败: {out}"})
                    rec["tool_iters"] += 1
                    continue
                rec["answer"] = (msg.get("content") or "").strip()
                break
            else:
                rec["err"] = "工具迭代超限"
        except Exception as e:
            rec["ok"] = False
            rec["err"] = str(e)[:160]
        rounds.append(rec)
        print(f"  轮{idx}: tools={rec['tool_calls'] or '-'} "
              f"首tok={rec['first_tok_s']}s 总={rec['elapsed_s']}s", flush=True)
        if rec["answer"]:
            print(f"        答: {rec['answer'][:110]!r}", flush=True)
        if rec["err"]:
            print(f"        错: {rec['err']}", flush=True)
    return rounds


def judge(rounds, gt):
    """与地面真值比对，返回判定 dict。"""
    r1, r2, r3 = (rounds + [{}]*3)[:3]
    tools_12 = r1.get("tool_calls", []) + r2.get("tool_calls", [])
    used_log = "get_git_log" in tools_12
    used_read = "read_file" in tools_12
    ans = r3.get("answer", "")
    cheated = bool(r3.get("tool_calls"))
    parts = gt["commit_subject"].split()
    hit_commit = bool(parts) and len(parts) > 1 and parts[1][:12] in ans
    hit_name = bool(gt["pkg_name"]) and gt["pkg_name"] in ans
    return {
        "round1_tool": used_log, "round2_tool": used_read,
        "round3_no_tool": not cheated,
        "记忆-提交消息": hit_commit, "记忆-包名": hit_name,
        "commit_gt": gt["commit_subject"][:50], "name_gt": gt["pkg_name"],
    }


def mem_size(model):
    try:
        out = subprocess.run(["ollama", "ps"], capture_output=True, text=True, timeout=10).stdout
    except Exception:
        return "?"
    for ln in out.splitlines():
        if model in ln:
            p = ln.split()
            return f"{p[2]} {p[3]}" if len(p) > 3 else (p[2] if p else "?")
    return "?"


def stop_model(model):
    try:
        subprocess.run(["ollama", "stop", model], capture_output=True, text=True, timeout=30)
    except Exception:
        pass


# ---------- 主流程 ----------
gt = collect_ground_truth()
print(f"地面真值: 提交={gt['commit_subject'][:60]!r} 包名={gt['pkg_name']!r}\n", flush=True)

all_results = []
for m in MODELS:
    print(f"=== 多轮探针: {m} ===", flush=True)
    t0 = time.time()
    rounds = run_rounds(m)
    verdict = judge(rounds, gt)
    total = round(time.time() - t0, 1)
    verdict.update({"model": m, "total_s": total, "mem": mem_size(m)})
    all_results.append(verdict)
    print(f"  判定: 轮1工具={verdict['round1_tool']} 轮2工具={verdict['round2_tool']} "
          f"轮3无工具={verdict['round3_no_tool']} 记忆(提交/包名)="
          f"{verdict['记忆-提交消息']}/{verdict['记忆-包名']} 总耗时={total}s", flush=True)
    stop_model(m)
    time.sleep(3)

print("\n=== 汇总 ===", flush=True)
print(f"{'模型':<18}{'轮1':<5}{'轮2':<5}{'轮3纯记忆':<9}{'记忆提交':<8}{'记忆包名':<8}{'总耗时':<8}", flush=True)
for v in all_results:
    print(f"{v['model']:<18}{str(v['round1_tool']):<5}{str(v['round2_tool']):<5}"
          f"{str(v['round3_no_tool']):<9}{str(v['记忆-提交消息']):<8}"
          f"{str(v['记忆-包名']):<8}{str(v['total_s'])+'s':<8}", flush=True)
