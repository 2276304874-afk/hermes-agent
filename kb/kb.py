#!/usr/bin/env python3
"""赫尔墨斯特工 · 本地知识库检索（方案乙：C 检索）

零外部依赖（仅 Python 标准库 + sqlite3 FTS5 trigram）。
把现有记忆文件（项目 daily logs / MEMORY.md / 用户级 MEMORY.md）
建成可检索索引，任务时按需 recall 注入。

用法：
  python kb.py build                 # (重)建索引
  python kb.py recall "首字延迟"     # 检索 top5
  python kb.py recall "launchd 装不上" --top 3

程序内调用：
  from kb import recall, build
  hits = recall("首字延迟", top=5)   # -> [{"source","section","text","rank"}, ...]
"""
import os
import sys
import glob
import json
import sqlite3
import argparse

WS = "/Users/zhaocaozheng/WorkBuddy/赫尔墨斯特工"
MEM_DIR = os.path.join(WS, ".workbuddy", "memory")
USER_MEM = os.path.expanduser("~/.workbuddy/MEMORY.md")
DB_PATH = os.environ.get("KB_DB", os.path.join(WS, ".workbuddy", "kb.db"))

# 记忆源：(路径或目录, 标签, 是否扫描目录内 dated 文件)
SOURCES = [
    (os.path.join(MEM_DIR, "MEMORY.md"), "项目长期记忆", False),
    (MEM_DIR, "项目日志", True),          # 扫描 *.md（排除 MEMORY.md）
    (USER_MEM, "用户级记忆", False),
    (os.path.join(WS, ".workbuddy", "kb_inbox.md"), "自动捕获", False),  # capture.py 产出
    (os.path.join(WS, ".workbuddy", "kb_distilled.md"), "蒸馏技能", False),  # distill.py 产出
]


def _chunk_file(path, label):
    """按 markdown 标题 + 空行切块，返回 [(section, text), ...]"""
    try:
        with open(path, "r", encoding="utf-8") as f:
            lines = f.read().splitlines()
    except OSError:
        return []
    chunks = []
    section = ""
    buf = []
    flush = lambda: None
    for line in lines:
        if line.startswith("#"):
            # 标题变更：先把上一块 flush
            if buf:
                chunks.append((section, "\n".join(buf).strip()))
                buf = []
            section = line.lstrip("#").strip()
            continue
        if line.strip() == "":
            if buf:
                chunks.append((section, "\n".join(buf).strip()))
                buf = []
            continue
        buf.append(line)
    if buf:
        chunks.append((section, "\n".join(buf).strip()))
    return [(label + (" / " + s if s else ""), t) for s, t in chunks if len(t) >= 6]


def _collect():
    out = []
    for path, label, is_dir in SOURCES:
        if is_dir:
            if not os.path.isdir(path):
                continue
            for fp in sorted(glob.glob(os.path.join(path, "*.md"))):
                if os.path.basename(fp) == "MEMORY.md":
                    continue
                out.extend((fp, s, t) for s, t in _chunk_file(fp, label))
        else:
            if os.path.isfile(path):
                out.extend((path, s, t) for s, t in _chunk_file(path, label))
    return out


def build(db_path=DB_PATH):
    chunks = _collect()
    con = sqlite3.connect(db_path)
    con.execute("DROP TABLE IF EXISTS kb")
    con.execute(
        "CREATE VIRTUAL TABLE kb USING fts5("
        "source UNINDEXED, section UNINDEXED, body, tokenize='trigram')"
    )
    con.executemany(
        "INSERT INTO kb(source, section, body) VALUES (?,?,?)",
        [(p, s, t) for p, s, t in chunks],
    )
    con.commit()
    n = con.execute("SELECT count(*) FROM kb").fetchone()[0]
    con.close()
    return n


def _query_tokens(q):
    """返回用于匹配/打分的分词列表（与 _build_match 同源）：
    中英文按边界切词；中文长串滑窗 3-gram；latin 转小写。仅保留 >=3 字符项。"""
    import re
    toks = re.findall(r"[A-Za-z0-9_]+|[一-鿿]+", q)
    bare = []
    for t in toks:
        t = t.strip()
        if len(t) < 3:
            continue
        if re.fullmatch(r"[一-鿿]+", t):
            for i in range(len(t) - 2):  # 滑窗 3-gram
                bare.append(t[i:i + 3])
        else:
            bare.append(t.lower())
    seen, uniq = set(), []
    for b in bare:
        if b not in seen:
            seen.add(b)
            uniq.append(b)
    return uniq


def _build_match(q):
    """把查询转成 FTS5 trigram MATCH 表达式（OR 多词）。见 _query_tokens。"""
    return " OR ".join('"%s"' % p.replace('"', "") for p in _query_tokens(q))


def _score(text, tokens):
    """查询 token 在文本中的覆盖率（0~1），作为相关性分数。"""
    if not tokens:
        return 0.0
    low = (text or "").lower()
    hit = sum(1 for tk in tokens if tk in low)
    return hit / len(tokens)


def recall(query, top=5, db_path=DB_PATH):
    q = query.strip()
    if not q:
        return []
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    rows = None
    # 检索只用前 64 字抓任务主旨，避免超长 prompt 生成海量 3-gram
    match = _build_match(q[:64])
    qtokens = _query_tokens(q[:64])
    try:
        if match:
            sql = (
                "SELECT source, section, body, bm25(kb) AS rank "
                "FROM kb WHERE kb MATCH ? ORDER BY rank LIMIT ?"
            )
            rows = con.execute(sql, (match, top)).fetchall()
        else:
            raise sqlite3.OperationalError("no trigram tokens")
    except sqlite3.OperationalError:
        # fallback：LIKE 子串 + 出现次数排序
        like = "%" + q + "%"
        rows = con.execute(
            "SELECT source, section, body, "
            "(LENGTH(body)-LENGTH(REPLACE(body,?,'')))/? AS rank "
            "FROM kb WHERE body LIKE ? ORDER BY rank DESC LIMIT ?",
            (q, max(1, len(q)), like, top),
        ).fetchall()
    hits = [
        {
            "source": r["source"],
            "section": r["section"],
            "text": r["body"],
            "rank": r["rank"],
            "score": round(_score(r["body"], qtokens), 3),
        }
        for r in rows
    ]
    con.close()
    return hits


def _cli():
    ap = argparse.ArgumentParser(description="赫尔墨斯特工本地知识库检索")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("build", help="(重)建索引")
    rp = sub.add_parser("recall", help="检索")
    rp.add_argument("query", help="查询词")
    rp.add_argument("--top", type=int, default=5)
    rp.add_argument("--json", action="store_true", help="输出 JSON（供程序调用）")
    args = ap.parse_args()

    if args.cmd == "build":
        n = build()
        print(f"✅ 索引已建：{n} 个知识块 → {DB_PATH}")
    else:
        hits = recall(args.query, top=args.top)
        if args.json:
            print(json.dumps(hits, ensure_ascii=False))
            return
        if not hits:
            print("（无匹配）")
            return
        for i, h in enumerate(hits, 1):
            print(f"\n[{i}] {h['section']}")
            print(f"    {h['source']}")
            snippet = h["text"].replace("\n", " ")
            if len(snippet) > 200:
                snippet = snippet[:200] + "…"
            print(f"    {snippet}")


if __name__ == "__main__":
    _cli()
