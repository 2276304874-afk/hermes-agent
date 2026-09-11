#!/usr/bin/env python3
"""
更全面的Python 3.9兼容性修复脚本
"""

import re
import os
from pathlib import Path

def fix_hermes_constants():
    """修复hermes_constants.py中的所有类型注解"""
    file_path = Path("/Users/zhaocaozheng/.hermes/hermes-agent/hermes_constants.py")
    
    with open(file_path, 'r', encoding='utf-8') as f:
        content = f.read()
    
    # 替换所有剩余的联合类型注解
    replacements = [
        (r': dict\[str, str\] \| None', ': Optional[Dict[str, str]]'),
        (r': list\[str\]', ': List[str]'),
        (r': tuple\[str, str\]', ': Tuple[str, str]'),
        (r': dict\[str, str\]', ': Dict[str, str]'),
        (r'-> dict\[str, str\] \| None', '-> Optional[Dict[str, str]]'),
        (r': set\[str\]', ': Set[str]'),
        (r'-> set\[str\]', '-> Set[str]'),
        (r': frozenset\[str\]', ': FrozenSet[str]'),
        (r'-> frozenset\[str\]', '-> FrozenSet[str]'),
        (r': bool \| None', ': Optional[bool]'),
        (r': int \| str', ': Union[int, str]'),
        (r': str \| int', ': Union[str, int]'),
        (r': Path \| str', ': Union[Path, str]'),
        (r': str \| Path', ': Union[str, Path]'),
        (r': bytes \| str', ': Union[bytes, str]'),
        (r': str \| bytes', ': Union[str, bytes]'),
    ]
    
    for pattern, replacement in replacements:
        content = re.sub(pattern, replacement, content)
    
    # 修复函数返回类型
    content = re.sub(r'-> (tuple\[.*?\]) \| None', r'-> Optional[\1]', content)
    content = re.sub(r'-> (list\[.*?\]) \| None', r'-> Optional[\1]', content)
    content = re.sub(r'-> (dict\[.*?\]) \| None', r'-> Optional[\1]', content)
    
    with open(file_path, 'w', encoding='utf-8') as f:
        f.write(content)
    
    print("✅ 修复完成: hermes_constants.py")

def main():
    """主函数"""
    print("🔧 开始全面修复Python 3.9兼容性问题...")
    
    # 修复最关键的文件
    fix_hermes_constants()
    
    print("\n🎉 全面修复完成！")
    print("💡 现在测试赫尔墨斯特工: cd /Users/zhaocaozheng/.hermes/hermes-agent && python3 cli.py --help")

if __name__ == "__main__":
    main()