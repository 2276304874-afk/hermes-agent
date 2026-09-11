#!/usr/bin/env python3
"""赫尔墨斯特工 · 蒸馏（方案乙 B 蒸馏）

零外部依赖（Python 标准库 + 本地 Ollama）。
把 capture.py 抓到的原始 nugget（偏好/教训/排障/决策/工具链）交给本地模型，
压缩成结构化、可复用的「技能」草稿，写入 kb_distilled.md，并纳入 FTS5 索引供 recall。

用法：
  python distill.py                       # 蒸馏自上次以来的新 nugget
  python distill.py --all                # 全量重蒸馏（清空旧产物）
  python distill.py --model gemma4:e4b   # 指定模型
  python distill.py --reindex            # 蒸馏后顺带重建 kb 索引
  python distill.py --types 教训,排障     # 只蒸馏指定类型
"""
import os
import re
import sys
import json
import hashlib
import argparse
import urllib.request

WS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INBOX = os.path.join(WS, ".workbuddy", "kb_inbox.md")
OUT = os.path.join(WS, ".workbuddy", "kb_distilled.md")
STATE = os.path.join(WS, ".workbuddy", "kb_distill_state.json")
OLLAMA = "http://127.0.0.1:11434/api/generate"
DEFAULT_MODEL = "hermes-local-gemma4"

PROMPT_TMPL = """你是一个知识提炼助手。把下面的「智能体交互片段」压缩成一条可复用的技能（skill），供以后类似任务直接调用。

严格按以下格式输出（中文，简洁，总计不超过 200 字），不要任何解释或前缀：
【名称】<简短技能名>
【适用】<什么情况下用这条技能>
【要点】<2-4 条关键步骤或经验，用分号分隔>
【禁忌】<容易踩的坑；没有则写 无>

交互片段（类型：{typ}）：
{text}"""


def load_state():
    if os.path.isfile(STATE):
        try:
            return set(json.load(open(STATE, encoding="utf-8")).get("hashes", []))
        except Exception:
            return set()
    return set()


def save_state(hashes):
    with open(STATE, "w", encoding="utf-8") as f:
        json.dump({"hashes": list(hashes)}, f, ensure_ascii=False)


def parse_inbox(path):
    """解析 inbox：每行 '### [类型] ...' 为一条 nugget 头，其后文本到下一个头为止。"""
    nugs = []
    cur_header = None
    buf = []
    for line in open(path, encoding="utf-8"):
        if line.startswith("### ["):
            if cur_header is not None:
                nugs.append((cur_header, "\n".join(buf).strip()))
            cur_header = line[4:].strip()
            buf = []
        elif cur_header is not None:
            buf.append(line.rstrip("\n"))
    if cur_header is not None:
        nugs.append((cur_header, "\n".join(buf).strip()))
    return nugs


def nugget_type(header):
    m = re.match(r"\[(.*?)\]", header)
    return m.group(1) if m else ""


def ollama_generate(model, prompt, timeout=120):
    payload = json.dumps({"model": model, "prompt": prompt, "stream": False}).encode()
    req = urllib.request.Request(
        OLLAMA, data=payload, headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode()).get("response", "").strip()


def main():
    ap = argparse.ArgumentParser(description="赫尔墨斯特工 nugget 蒸馏为技能")
    ap.add_argument("--all", action="store_true", help="全量重蒸馏（清空旧产物）")
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--reindex", action="store_true", help="蒸馏后重建 kb 索引")
    ap.add_argument("--types", default="", help="只蒸馏指定类型，逗号分隔，如 教训,排障")
    args = ap.parse_args()

    if not os.path.isfile(INBOX):
        print("（inbox 不存在，请先跑 capture.py）")
        return

    keep = set(t.strip() for t in args.types.split(",") if t.strip())
    done = set() if args.all else load_state()
    if args.all and os.path.isfile(OUT):
        open(OUT, "w", encoding="utf-8").close()

    nugs = parse_inbox(INBOX)
    count = 0
    for header, text in nugs:
        typ = nugget_type(header)
        if keep and typ not in keep:
            continue
        h = hashlib.sha1((typ + text).encode()).hexdigest()[:12]
        if h in done:
            continue
        if not text:
            continue
        print(f"  ⚙ 蒸馏 [{typ}] {header[:40]} …", flush=True)
        try:
            skill = ollama_generate(args.model, PROMPT_TMPL.format(typ=typ, text=text))
        except Exception as e:
            print(f"  ⚠ Ollama 调用失败（{e}）；跳过后续。请确认 Ollama 在线。")
            break
        if not skill:
            continue
        with open(OUT, "a", encoding="utf-8") as f:
            f.write(f"\n## 技能（源自 {header}）\n{skill}\n")
        done.add(h)
        count += 1
        print(f"     ✅ {skill[:60].replace(chr(10),' ')}…")

    save_state(done)
    print(f"✅ 蒸馏完成：{count} 条技能 → {os.path.abspath(OUT)}")

    if args.reindex:
        try:
            sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
            import subprocess
            print("🔄 重建 kb 索引…")
            subprocess.run(
                [sys.executable, os.path.join(os.path.dirname(__file__), "kb.py"), "build"],
                check=True,
            )
        except Exception as e:
            print("⚠️ 重建索引失败：", e)


if __name__ == "__main__":
    main()
