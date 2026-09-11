#!/usr/bin/env python3
"""赫尔墨斯特工 · 知识库只读查看器（零依赖，标准库）

⚠️ 已弃用（2026-09-11，P2-8）：本文件的 3 个能力（/api/list /api/search /api/status）
   已并入主服务 server.js（4173），路由为 /api/kb/list、/api/kb/search、/api/kb/status，
   页面由 GET /kb 直接托管 kb/viewer.html。

   保留原因：作为"单服务故障时的离线兜底"与历史参考。
   现状核实：无任何 launchd plist / cron / 代码引用本文件，4174 无监听 → 处于休眠态。

   ⚠️ 不要再新增调用方。若确需兜底，请手动 `python3 kb/serve.py` 并知悉它读的是同一批文件，
      两套后端同时写索引会互相干扰。

用法（仅兜底时）：
  python3 kb/serve.py                 # 默认 http://127.0.0.1:4174
  KB_VIEWER_PORT=8080 python3 kb/serve.py
浏览器打开 http://127.0.0.1:4174/
"""
import os
import re
import sys
import json
import urllib.request
from urllib.parse import urlparse, parse_qs
from http.server import BaseHTTPRequestHandler, HTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
WS = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import kb  # 复用 recall()

INBOX = os.path.join(WS, ".workbuddy", "kb_inbox.md")
DISTILLED = os.path.join(WS, ".workbuddy", "kb_distilled.md")
MEM_PROJ = os.path.join(WS, ".workbuddy", "memory", "MEMORY.md")
MEM_USER = os.path.expanduser("~/.workbuddy/MEMORY.md")
VIEWER = os.path.join(HERE, "viewer.html")


def _read(p):
    try:
        with open(p, "r", encoding="utf-8") as f:
            return f.read()
    except OSError:
        return ""


def parse_blocks(path, cat, header_re, src_group=1):
    """通用分块：遇到 header_re 匹配的行即一条新条目。"""
    out = []
    if not os.path.isfile(path):
        return out
    cur = None
    buf = []
    for line in open(path, encoding="utf-8"):
        m = header_re.match(line.rstrip("\n"))
        if m:
            if cur is not None:
                cur["text"] = "\n".join(buf).strip()
                out.append(cur)
            cur = {"cat": cat, "type": cat, "src": m.group(src_group).strip(), "text": ""}
            buf = []
        elif cur is not None:
            buf.append(line.rstrip("\n"))
    if cur is not None:
        cur["text"] = "\n".join(buf).strip()
        out.append(cur)
    return out


def list_entries(cat="all"):
    res = []
    res += parse_blocks(INBOX, "inbox", re.compile(r"### \[(.*?)\]\s*(.*)"))
    res += parse_blocks(DISTILLED, "distilled", re.compile(r"## 技能（源自\s*(.*)）"))
    for p in (MEM_PROJ, MEM_USER):
        txt = _read(p)
        if txt:
            res.append({"cat": "memory", "type": "记忆", "src": os.path.relpath(p, WS), "text": txt})
    if cat != "all":
        res = [e for e in res if e["cat"] == cat]
    return res


def search(q):
    hits = kb.recall(q, top=50)
    return [
        {"cat": "search", "type": h.get("section", ""), "src": h.get("source", ""), "text": h.get("text", ""), "score": h.get("score")}
        for h in hits
    ]


def ollama_status():
    """探测本地 Ollama 是否在线，返回可用模型名列表（超时/失败视为离线）。"""
    try:
        req = urllib.request.Request("http://127.0.0.1:11434/api/tags")
        with urllib.request.urlopen(req, timeout=2) as r:
            data = json.loads(r.read().decode("utf-8"))
        models = [m.get("name") for m in data.get("models", [])]
        return {"running": True, "models": models}
    except Exception:
        return {"running": False, "models": []}


def status():
    """底部状态栏数据：各分类条目数 + 本地模型/服务状态。"""
    entries = list_entries("all")
    counts = {"inbox": 0, "distilled": 0, "memory": 0}
    for e in entries:
        if e["cat"] in counts:
            counts[e["cat"]] += 1
    out = {
        "kb_port": int(os.environ.get("KB_VIEWER_PORT", "4174")),
        "counts": counts,
        "total": len(entries),
        "ollama": ollama_status(),
    }
    return out


class H(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        data = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        u = urlparse(self.path)
        if u.path in ("/", "/index.html"):
            self._send(200, _read(VIEWER), "text/html; charset=utf-8")
            return
        if u.path == "/api/list":
            self._send(200, json.dumps(list_entries(parse_qs(u.query).get("cat", ["all"])[0]), ensure_ascii=False))
            return
        if u.path == "/api/search":
            q = parse_qs(u.query).get("q", [""])[0]
            self._send(200, json.dumps(search(q), ensure_ascii=False))
            return
        if u.path == "/api/status":
            self._send(200, json.dumps(status(), ensure_ascii=False))
            return
        self._send(404, json.dumps({"error": "not found"}))

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    port = int(os.environ.get("KB_VIEWER_PORT", "4174"))
    print(f"知识库查看器: http://127.0.0.1:{port}/")
    HTTPServer(("127.0.0.1", port), H).serve_forever()
