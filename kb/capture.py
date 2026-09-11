#!/usr/bin/env python3
"""赫尔墨斯特工 · 会话自动捕获（方案甲：A 捕获）

零外部依赖（Python 标准库 + sqlite3）。
扫 ~/.hermes/state.db 的新会话，用启发式抽取「可长期复用」片段，
写入本地知识库 inbox（Markdown），再纳入 FTS5 索引，供 recall 召回。

启发式（不调模型，纯规则，保守优先）：
  - 偏好：用户说"记住/以后/务必/别/偏好/规范…"
  - 教训：含"教训/踩坑/根因/事故/红线/纪律…"（高价值）
  - 排障：含"报错/error"且伴随"修复/解决/已回滚…"
  - 决策：含"决定/采用/改为/方案A/拍板…"
  - 工具链：会话用 >=2 个不同工具完成任务 → 记录「任务 + 工具序列」

用法：
  python capture.py            # 捕获自上次以来的新会话
  python capture.py --all     # 全量回填（首次建立知识库用）
  python capture.py --reindex # 捕获后顺带重建 kb 索引
"""
import os
import re
import sys
import json
import sqlite3
import argparse

DB = os.path.expanduser("~/.hermes/state.db")
INBOX = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", ".workbuddy", "kb_inbox.md"
)
STATE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", ".workbuddy", "kb_capture_state.json"
)

PREF_RE = re.compile(r"记住|以后|务必|请记住|记得|约定|规范|规则|红线|习惯|偏好|禁止")
LESSON_RE = re.compile(r"教训|踩坑|血泪|务必记住|根因|事故|回归|红线|纪律|务必注意")
FIX_RE = re.compile(r"报错|error|exception|traceback|失败", re.I)
FIX_OK_RE = re.compile(r"修复|解决|根因|已修|已回滚|回滚|修好|搞定")
DECISION_RE = re.compile(r"决定|采用|改为|方案[ABC]|选型|取舍|拍板")


def load_state():
    if os.path.isfile(STATE):
        try:
            return json.load(open(STATE, encoding="utf-8")).get("last_id", "")
        except Exception:
            return ""
    return None  # None = 首次运行


def save_state(last_id):
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    with open(STATE, "w", encoding="utf-8") as f:
        json.dump({"last_id": last_id}, f, ensure_ascii=False)


def _connect_ro():
    """只读连接 state.db：mode=ro 防止误写，timeout 规避引擎写锁导致的 SQLITE_BUSY。"""
    try:
        return sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=10)
    except Exception:
        return sqlite3.connect(DB, timeout=10)


def get_sessions(last_id, all_sessions):
    con = _connect_ro()
    if all_sessions:
        rows = con.execute(
            "SELECT id, title, cwd, ended_at FROM sessions ORDER BY id"
        ).fetchall()
    elif last_id is None:
        # 首次运行：只处理最新 1 个会话，避免回填风暴
        rows = con.execute(
            "SELECT id, title, cwd, ended_at FROM sessions ORDER BY id DESC LIMIT 1"
        ).fetchall()
    else:
        rows = con.execute(
            "SELECT id, title, cwd, ended_at FROM sessions WHERE id > ? ORDER BY id",
            (last_id,),
        ).fetchall()
    con.close()
    return rows


def extract_nuggets(sid):
    con = _connect_ro()
    msgs = con.execute(
        "SELECT role, content, tool_name, display_kind FROM messages "
        "WHERE session_id=? ORDER BY id",
        (sid,),
    ).fetchall()
    con.close()

    nuggets = []
    seen = set()
    first_task = ""
    tools = []

    for role, content, tool_name, dkind in msgs:
        if tool_name:
            tools.append(tool_name)
        text = (content or "").strip()
        if not text:
            continue
        if role == "user" and not first_task:
            first_task = text[:200]

        if role == "user" and PREF_RE.search(text):
            nuggets.append(("偏好", text[:600]))
        if LESSON_RE.search(text):
            nuggets.append(("教训", text[:600]))
        elif FIX_RE.search(text) and FIX_OK_RE.search(text):
            nuggets.append(("排障", text[:600]))
        if DECISION_RE.search(text):
            nuggets.append(("决策", text[:600]))

    # 工具链：>=2 个不同工具 + 有任务描述（任务过短视为无意义测试，跳过）
    uniq = []
    for t in tools:
        if t not in uniq:
            uniq.append(t)
    if len(uniq) >= 2 and len(first_task) >= 8:
        nuggets.append(("工具链", f"任务：{first_task}\n工具序列：{' → '.join(uniq)}"))

    # 去重
    out = []
    for typ, txt in nuggets:
        key = (typ, txt)
        if key in seen:
            continue
        seen.add(key)
        out.append((typ, txt))
    return out


def main():
    ap = argparse.ArgumentParser(description="赫尔墨斯特工会话自动捕获")
    ap.add_argument("--all", action="store_true", help="全量回填")
    ap.add_argument("--reindex", action="store_true", help="捕获后重建 kb 索引")
    args = ap.parse_args()

    last_id = None if args.all else load_state()
    # 全量回填 = 完全重建，先清空 inbox 避免重复
    if args.all and os.path.isfile(INBOX):
        open(INBOX, "w", encoding="utf-8").close()
    sessions = get_sessions(last_id, args.all)
    if not sessions:
        print("（无新会话可捕获）")
        return

    total = 0
    max_id = sessions[0][0]
    for sid, title, cwd, ended in sessions:
        nuggets = extract_nuggets(sid)
        if not nuggets:
            if sid > max_id:
                max_id = sid
            continue
        # 写 inbox
        os.makedirs(os.path.dirname(INBOX), exist_ok=True)
        with open(INBOX, "a", encoding="utf-8") as f:
            for typ, txt in nuggets:
                head = f"### [{typ}] {sid} · {title or ''}".rstrip()
                f.write(f"\n{head}\n{txt}\n")
        total += len(nuggets)
        print(f"  + {sid}: {len(nuggets)} 条 ({', '.join(t for t, _ in nuggets)})")
        if sid > max_id:
            max_id = sid

    save_state(max_id)
    print(f"✅ 捕获完成：{total} 条 → {os.path.abspath(INBOX)}")

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
