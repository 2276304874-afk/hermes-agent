#!/usr/bin/env python3
"""
终极Python 3.9兼容性修复脚本 v2
"""

import re
from pathlib import Path

def fix_hermes_constants():
    """修复hermes_constants.py中的类型注解"""
    file_path = Path("/Users/zhaocaozheng/.hermes/hermes-agent/hermes_constants.py")
    
    with open(file_path, 'r', encoding='utf-8') as f:
        content = f.read()
    
    original_content = content
    
    # 简单的替换规则
    replacements = [
        (': str | None', ': Optional[str]'),
        (': int | None', ': Optional[int]'),
        (': bool | None', ': Optional[bool]'),
        (': dict | None', ': Optional[Dict]'),
        (': list | None', ': Optional[List]'),
        ('-> str | None', '-> Optional[str]'),
        ('-> int | None', '-> Optional[int]'),
        ('-> bool | None', '-> Optional[bool]'),
        ('-> dict | None', '-> Optional[Dict]'),
        ('-> list | None', '-> Optional[List]'),
        (': str | int', ': Union[str, int]'),
        (': int | str', ': Union[int, str]'),
    ]
    
    for pattern, replacement in replacements:
        content = content.replace(pattern, replacement)
    
    # 确保有正确的导入
    typing_imports = 'from typing import Optional, Union, Tuple, Dict, List, Set'
    if 'from typing import' in content:
        if 'Optional' not in content:
            content = content.replace('from typing import', f'{typing_imports}\nfrom typing import')
    else:
        content = f'{typing_imports}\n\n' + content
    
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
    
    if fix_hermes_constants():
        print("\n🎉 修复完成！")
        print("💡 现在测试赫尔墨斯特工:")
        print("   cd /Users/zhaocaozheng/.hermes/hermes-agent")
        print("   python3 cli.py --help")
    else:
        print("\n🤔 文件已经是最新的状态")

if __name__ == "__main__":
    main()