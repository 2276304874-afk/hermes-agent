#!/usr/bin/env python3
"""
批量修复Python 3.9兼容性问题的类型注解脚本
"""

import re
import os
from pathlib import Path

# 需要导入的类型
IMPORTS = """
from typing import (
    Any, Optional, Tuple, Union, List, Dict, Callable, 
    Iterator, Generator, Type, Iterable, Sequence
)
"""

def fix_union_type_annotations(content):
    """修复类型联合注解"""
    # 替换简单的联合类型
    replacements = [
        (r': str \| None', ': Optional[str]'),
        (r': int \| None', ': Optional[int]'),
        (r': bool \| None', ': Optional[bool]'),
        (r': Path \| None', ': Optional[Path]'),
        (r': str \| Path \| None', ': Union[str, Path, None]'),
        (r': str \| Path', ': Union[str, Path]'),
        (r': tuple\[int, int\] \| None', ': Optional[Tuple[int, int]]'),
        (r': int \| None', ': Optional[int]'),
        (r'ContextVar\[str \| object\]', 'ContextVar[Union[str, object]]'),
        (r'-> str \| None', '-> Optional[str]'),
        (r'-> Path \| None', '-> Optional[Path]'),
        (r'-> int \| None', '-> Optional[int]'),
        (r': logging\.Logger \| None', ': Optional[logging.Logger]'),
    ]
    
    for pattern, replacement in replacements:
        content = re.sub(pattern, replacement, content)
    
    return content

def fix_function_annotations(content):
    """修复函数参数注解"""
    # 修复函数参数中的联合类型
    content = re.sub(r': (\w+) \| None', r': Optional[\1]', content)
    content = re.sub(r': (\w+) \| (\w+)', r': Union[\1, \2]', content)
    
    return content

def add_typing_imports(content):
    """添加typing导入"""
    if 'from typing import' in content:
        # 如果已有导入，只添加缺少的类型
        existing_imports = re.search(r'from typing import \(([^)]+)\)', content)
        if existing_imports:
            existing = existing_imports.group(1)
            needed = []
            for type_name in ['Any', 'Optional', 'Tuple', 'Union', 'List', 'Dict']:
                if type_name not in existing and type_name in IMPORTS:
                    needed.append(type_name)
            if needed:
                content = content.replace(
                    existing_imports.group(0),
                    f'from typing import ({existing}, {", ".join(needed)})'
                )
    else:
        # 添加完整的导入
        content = IMPORTS + '\n' + content
    
    return content

def fix_file(file_path):
    """修复单个文件"""
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            content = f.read()
        
        original_content = content
        
        # 修复类型注解
        content = fix_union_type_annotations(content)
        content = fix_function_annotations(content)
        content = add_typing_imports(content)
        
        # 如果有变化，写入文件
        if content != original_content:
            with open(file_path, 'w', encoding='utf-8') as f:
                f.write(content)
            print(f"✅ 修复: {file_path}")
            return True
        else:
            print(f"⏭️  无需修改: {file_path}")
            return False
            
    except Exception as e:
        print(f"❌ 修复失败 {file_path}: {e}")
        return False

def main():
    """主函数"""
    print("🔧 开始修复Python 3.9兼容性问题...")
    
    # 需要修复的关键文件
    critical_files = [
        "hermes_constants.py",
        "utils.py",
        "hermes_logging.py",
        "hermes_state_errors.py",
        "hermes_state_maintenance.py",
        "hermes_time.py",
        "toolsets.py",
        "registration_lifecycle.py",
        "hermes_bootstrap.py",
        "run_agent.py",
        "cli.py"
    ]
    
    fixed_count = 0
    total_count = 0
    
    for filename in critical_files:
        file_path = Path("/Users/zhaocaozheng/.hermes/hermes-agent") / filename
        if file_path.exists():
            total_count += 1
            if fix_file(file_path):
                fixed_count += 1
        else:
            print(f"⚠️  文件不存在: {file_path}")
    
    print(f"\n📊 修复完成: {fixed_count}/{total_count} 个文件已修复")
    
    if fixed_count > 0:
        print("\n🎉 现在可以尝试运行赫尔墨斯特工了！")
        print("💡 运行命令: cd /Users/zhaocaozheng/.hermes/hermes-agent && python3 cli.py --help")
    else:
        print("\n🤔 所有文件都已经是兼容的状态。")

if __name__ == "__main__":
    main()