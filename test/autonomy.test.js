'use strict';
/*
 * lib/autonomy.js 单元测试：
 *   1. autonomous=false 时原样返回（引用相等，零改动）
 *   2. autonomous=true 时前导 + 空行 + 原 prompt
 *   3. 模板字节稳定性：两次调用逐字节一致（审计/diff 依赖）
 *   4. 前导内容守门：三色关键词、停问条件、交付摘要格式必须存在
 *     （模板是安全方案的可执行压缩版，关键段落被误删时应立即失败）
 */
const test = require('node:test');
const assert = require('node:assert');
const { AUTONOMY_PREAMBLE, withAutonomy } = require('../lib/autonomy');

test('autonomous=false 时原样返回同一引用', () => {
  const p = '帮我修个 bug';
  assert.strictEqual(withAutonomy(p, false), p);
  assert.strictEqual(withAutonomy(p, undefined), p);
});

test('autonomous=true 时前导 + 空行 + 原 prompt', () => {
  const p = '帮我修个 bug';
  const out = withAutonomy(p, true);
  assert.ok(out.startsWith(AUTONOMY_PREAMBLE));
  assert.ok(out.endsWith(p));
  assert.strictEqual(out, AUTONOMY_PREAMBLE + '\n\n' + p);
});

test('模板字节稳定（两次调用逐字节一致）', () => {
  const a = withAutonomy('x', true);
  const b = withAutonomy('x', true);
  assert.strictEqual(a, b);
  assert.strictEqual(Buffer.byteLength(AUTONOMY_PREAMBLE), Buffer.byteLength(AUTONOMY_PREAMBLE));
});

test('前导内容守门：三色/停问/摘要关键段落齐全', () => {
  for (const kw of ['权限边界（三色）', '绿区直接做', '黄区已授权', '红区必停',
    'git add/commit', '禁止 push', '⛔ 需要授权', '📦 交付摘要',
    '连续修复 3 次失败', '用户任务如下']) {
    assert.ok(AUTONOMY_PREAMBLE.includes(kw), `前导缺少关键段落: ${kw}`);
  }
});

test('prompt 为空串时 autonomous=true 仍返回纯前导（调用方上游已拦空 prompt）', () => {
  assert.strictEqual(withAutonomy('', true), AUTONOMY_PREAMBLE + '\n\n');
});
