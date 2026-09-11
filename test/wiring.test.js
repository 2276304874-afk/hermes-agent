'use strict';
/* =============================================================================
 * test/wiring.test.js —— 模块接线自检
 *
 * 挡住的是这一类错误：「A 模块从 B 模块解构了 X，但 B 根本没导出 X」。
 *
 * 起因（真实事故）：P0-2 加固时给 lib/maintenance.js 加了 startHeartbeat 函数，
 * 却忘了加进 module.exports；server.js 在 listen 回调里调用它 →
 * 启动即 `TypeError: startHeartbeat is not a function` → 崩溃循环。
 * 而 `npm run check`（只看语法）通过、单测也不覆盖启动路径 —— 这类错误原本
 * 只能靠跑起来才发现。
 *
 * 做法：静态扫描全部源码里的 `const { … } = require('…')`，逐名核对导出是否存在。
 * **不 require server.js**（那会真的把服务拉起来），只 require 无副作用的 lib/*。
 * ========================================================================== */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/* 扫描范围：源码 + 脚本（不含 node_modules） */
function listSources() {
  const out = [];
  const add = (rel) => {
    const p = path.join(ROOT, rel);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) out.push(p);
  };
  add('server.js');
  for (const dir of ['lib', 'lib/routes', 'test', 'scripts']) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs)) {
      if (/\.(js|sh)$/.test(f)) out.push(path.join(abs, f));
    }
  }
  return out;
}

/* 解析相对模块路径 → 真实文件；解析不到返回 null */
function resolveLocal(fromFile, spec) {
  if (!spec.startsWith('.')) return null;           // 内置/第三方，跳过
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const c of [base, base + '.js', path.join(base, 'index.js')]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

/* 解构名单 → 被引入的原始名字（处理 `{ a: b }` 重命名 与 `{ a = 默认 }`） */
function importedNames(inner) {
  return inner.split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => s.split('=')[0].trim())              // 去默认值
    .map(s => s.split(':')[0].trim())              // 取「原名: 本地名」的原名
    .filter(s => /^[A-Za-z_$][\w$]*$/.test(s));
}

test('接线自检：所有 require 解构的成员都真实导出', () => {
  const re = /(?:const|let|var)\s*\{([^}]+)\}\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g;
  const problems = [];
  let checkedPairs = 0;

  for (const file of listSources()) {
    const src = fs.readFileSync(file, 'utf8');
    let m;
    while ((m = re.exec(src)) !== null) {
      const names = importedNames(m[1]);
      const target = resolveLocal(file, m[2]);
      if (!target || names.length === 0) continue;
      // 不 require server.js：它有 listen 副作用，会把服务拉起来
      if (path.basename(target) === 'server.js') continue;

      let mod;
      try {
        mod = require(target);
      } catch (e) {
        problems.push(`${path.relative(ROOT, file)} → ${m[2]}：require 失败（${e.message}）`);
        continue;
      }
      for (const n of names) {
        checkedPairs++;
        if (mod[n] === undefined) {
          problems.push(`${path.relative(ROOT, file)} 解构了 ${m[2]} 的 \`${n}\`，但该模块未导出它`);
        }
      }
    }
  }

  assert.ok(checkedPairs > 40, `扫描到的解构成员太少（${checkedPairs}），正则可能失效`);
  assert.deepStrictEqual(problems, [], '存在未导出/已改名的绑定：\n  ' + problems.join('\n  '));
});

test('接线自检：lib 下每个模块都能独立 require（无加载期副作用）', () => {
  const dirs = ['lib', 'lib/routes'];
  const failed = [];
  for (const d of dirs) {
    const abs = path.join(ROOT, d);
    for (const f of fs.readdirSync(abs)) {
      if (!f.endsWith('.js')) continue;
      const p = path.join(abs, f);
      try { require(p); } catch (e) { failed.push(`${d}/${f}: ${e.message}`); }
    }
  }
  assert.deepStrictEqual(failed, []);
});
