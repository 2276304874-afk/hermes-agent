#!/usr/bin/env node
'use strict';
/* =============================================================================
 * scripts/repomap.js —— 仓库地图（代码检索层的本地执行器，零依赖）
 *
 * 用法：node scripts/repomap.js [目录，默认当前工作区] [--max 行数上限，默认 240]
 *
 * 输出（stdout，纯文本，≤ 限额行数）：
 *   1. 目录树（带行数/大小，跳过依赖与产物目录）
 *   2. 代码符号索引：JS/TS/JSX/TSX/VUE 的 function/class/const 箭头函数/export，
 *      Python 的 def/class —— 供 agent 在多文件任务中先看地图再精读目标文件
 *
 * 设计约束：总输出必须能直接塞进 prompt（≤3K token），超出按行数硬截断。
 * ============================================================================ */

const fs = require('fs');
const path = require('path');

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.workbuddy',
  'archive', 'backup', '.trash-20260912', 'coverage', '__pycache__', '.venv', 'venv',
  'launchd', 'deploy', '.hermes', 'kb_data']);
const CODE_EXTS = new Set(['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs', '.vue', '.py', '.go', '.rs']);
const MAX_FILE_BYTES = 512 * 1024;   // 超大文件只记行数不解析符号

const symPatterns = [
  /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^\s*const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/,
  /^\s*module\.exports(?:\.([A-Za-z_$][\w$]*))?\s*=/,
  /^\s*def\s+([A-Za-z_][\w]*)/, /^\s*class\s+([A-Za-z_][\w]*)/,
  /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)/,
];

function walk(dir, base, depth, out) {
  if (depth > 6 || out.files.length > 1200) return;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.isDirectory() - b.isDirectory()) || a.name.localeCompare(b.name)); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.github') continue;
    const full = path.join(dir, e.name);
    const rel = path.relative(base, full);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      out.dirs.push(rel);
      walk(full, base, depth + 1, out);
    } else {
      const ext = path.extname(e.name).toLowerCase();
      let lines = 0;
      try { lines = fs.readFileSync(full, 'utf8').split('\n').length; } catch { continue; }
      out.files.push({ rel, ext, lines, size: e.isFile() ? 0 : 0, full });
    }
  }
}

function symbolsOf(full) {
  const ext = path.extname(full).toLowerCase();
  if (!CODE_EXTS.has(ext)) return [];
  let text;
  try { text = fs.readFileSync(full, 'utf8'); } catch { return []; }
  if (text.length > MAX_FILE_BYTES) return [];
  const syms = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length && syms.length < 40; i++) {
    for (const re of symPatterns) {
      const m = lines[i].match(re);
      if (m && m[1]) { syms.push(m[1] + ':' + (i + 1)); break; }
    }
  }
  return syms;
}

function main() {
  const args = process.argv.slice(2);
  const maxLines = Number(args.includes('--max') ? args[args.indexOf('--max') + 1] : 240) || 240;
  const root = path.resolve(args.find((a, i) => a !== '--max' && args[i - 1] !== '--max') || process.cwd());

  const out = { dirs: [], files: [] };
  walk(root, root, 0, out);
  out.files.sort((a, b) => b.lines - a.lines);

  const L = [];
  L.push('# 仓库地图 ' + root);
  L.push('# 目录数 ' + out.dirs.length + ' · 文件数 ' + out.files.length + ' · 总行数 ' + out.files.reduce((s, f) => s + f.lines, 0));
  L.push('');
  L.push('## 目录树');
  for (const d of out.dirs.slice(0, 40)) L.push('  ' + d + '/');
  L.push('');
  L.push('## 文件（按行数降序，仅代码/文档）');
  for (const f of out.files.slice(0, 60)) L.push(`  ${String(f.lines).padStart(5)} 行  ${f.rel}`);
  L.push('');
  L.push('## 符号索引（文件 → 符号:行号，top 40 文件）');
  for (const f of out.files.slice(0, 40)) {
    if (!CODE_EXTS.has(f.ext)) continue;
    const syms = symbolsOf(f.full);
    if (syms.length) L.push(`  ${f.rel}\n    ${syms.join('  ')}`);
  }
  if (L.length > maxLines) L.length = maxLines;
  L.push('');
  L.push('# 使用提示：先读本地图定位目标文件，再用文件读取工具精读；不要整目录通读。');
  L.push('# 交付契约：拿到本地图后，你的下一个动作必须是向用户输出一段项目总结');
  L.push('#（项目类型 / 技术栈 / 目录结构 / 核心模块 / 入口文件），不要创建或修改任何文件，');
  L.push('# 不要加载技能；后续精读哪个文件由用户下一步指令决定。');
  console.log(L.join('\n'));
}

main();
