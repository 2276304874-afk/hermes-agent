#!/usr/bin/env python3
"""
终极Python 3.9兼容性修复脚本 - 批量修复所有类型注解
"""

import re
from pathlib import Path

def fix_all_union_types(content):
    """修复所有联合类型注解"""
    # 系统性的替换规则
    rules = [
        # 简单类型
        (r': str \| None', ': Optional[str]'),
        (r': int \| None', ': Optional[int]'),
        (r': bool \| None', ': Optional[bool]'),
        (r': float \| None', ': Optional[float]'),
        (r': bytes \| None', ': Optional[bytes]'),
        
        # 容器类型
        (r': list\[', ': List['),
        (r': dict\[', ': Dict['),
        (r': tuple\[', ': Tuple['),
        (r': set\[', ': Set['),
        (r': frozenset\[', ': FrozenSet['),
        
        # 返回类型
        (r'-> str \| None', '-> Optional[str]'),
        (r'-> int \| None', '-> Optional[int]'),
        (r'-> bool \| None', '-> Optional[bool]'),
        (r'-> list\[', '-> List['),
        (r'-> dict\[', '-> Dict['),
        (r'-> tuple\[', '-> Tuple['),
        
        # 变量类型注解
        (r': list\[str\]', ': List[str]'),
        (r': dict\[str, str\]', ': Dict[str, str]'),
        (r': tuple\[str, str\]', ': Tuple[str, str]'),
        (r': set\[str\]', ': Set[str]'),
        
        # 联合类型
        (r': str \| int', ': Union[str, int]'),
        (r': int \| str', ': Union[int, str]'),
        (r': str | int', ': Union[str, int]'),
        (r': int | str', ': Union[int, str]'),
        
        # 复杂联合类型
        (r': dict\[str, str\] \| None', ': Optional[Dict[str, str]]'),
        (r': list\[str\] \| None', ': Optional[List[str]]'),
        (r': tuple\[.*?\] \| None', r': Optional[Tuple\1]'),
        (r': dict\[.*?\] \| None', r': Optional[Dict\1]'),
        (r': list\[.*?\] \| None', r': Optional[List\1]'),
    ]
    
    for pattern, replacement in rules:
        content = re.sub(pattern, replacement, content)
    
    return content

def fix_hermes_constants():
    """修复hermes_constants.py"""
    file_path = Path("/Users/zhaocaozheng/.hermes/hermes-agent/hermes_constants.py")
    
    with open(file_path, 'r', encoding='utf-8') as f:
        content = f.read()
    
    original_content = content
    
    # 修复所有联合类型
    content = fix_all_union_types(content)
    
    # 确保有正确的导入
    if 'from typing import' in content:
        # 检查是否有所需的导入
        required_imports = ['Optional', 'Union', 'Tuple', 'Dict', 'List', 'Set']
        existing_imports = re.search(r'from typing import \(([^)]+)\)', content)
        
        if existing_imports:
            current_imports = existing_imports.group(1)
            missing = [imp for imp in required_imports if imp not in current_imports]
            if missing:
                content = content.replace(
                    existing_imports.group(0),
                    f'from typing import ({current_imports}, {", ".join(missing)})'
                )
    
    # 写回文件
    with open(file_path, 'w', encoding='utf-8') as f:
        f.write(content)
    
    if content != original_content:
        print("✅ 修复完成: hermes_constants.py")
        return True
    else:
        print("⏭️  无需修改: hermes_constants.py")
        return False

def main():
    """主函数"""
    print("🔧 开始终极Python 3.9兼容性修复...")
    
    # 修复最关键的问题文件
    if fix_hermes_constants():
        print("\n🎉 修复完成！")
        print("💡 现在测试赫尔墨斯特工:")
        print("   cd /Users/zhaocaozheng/.hermes/hermes-agent")
        print("   python3 cli.py --help")
    else:
        print("\n🤔 文件已经是最新的状态")

if __name__ == "__main__":
    main()