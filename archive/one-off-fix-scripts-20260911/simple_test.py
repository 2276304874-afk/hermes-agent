#!/usr/bin/env python3
"""
简单技能检查
"""

import subprocess
import sys
from pathlib import Path

skills = [
    "ocr-chinese.py",
    "restic-backup.py", 
    "clickhouse-logs.py",
    "slack-communication.py",
    "pdf-parse.py",
    "data-analysis.py",
    "code-scan.py",
    "mcp-adapter.py"
]

base_path = "/Users/zhaocaozheng/.hermes/skills/"

def check_skill(skill):
    skill_path = base_path + skill
    if Path(skill_path).exists():
        print(f"✅ {skill} 存在")
        return True
    else:
        print(f"❌ {skill} 不存在")
        return False

print("检查赫尔墨斯特工技能文件...")
for skill in skills:
    check_skill(skill)