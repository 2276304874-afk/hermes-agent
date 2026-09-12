'use strict';
/*
 * lib/autonomy.js 单元测试：
 *   1. autonomous=false 时 = 原 prompt + META_GUARD 尾缀（守卫始终在）
 *   2. autonomous=true 时前导 + 空行 + 原 prompt + META_GUARD
 *   3. 模板字节稳定性：两次调用逐字节一致（审计/diff/缓存依赖）
 *   4. 前导内容守门：三色关键词、停问条件、交付摘要格式必须存在
 *   5. META_GUARD 守门：封 skill_view/hermes-agent 元话语的关键句必须存在
 *     （该守卫防的是 system prompt 层 HERMES_AGENT_HELP_GUIDANCE 引发的
 *      小模型元技能误路由——2026-09-12 旅行网站排障产物，见 lib/autonomy.js 注释）
 */
const test = require('node:test');
const assert = require('node:assert');
const { AUTONOMY_PREAMBLE, META_GUARD, withAutonomy } = require('../lib/autonomy');

test('autonomous=false 时原 prompt + 守卫尾缀', () => {
  const p = '帮我修个 bug';
  assert.strictEqual(withAutonomy(p, false), p + META_GUARD);
  assert.strictEqual(withAutonomy(p, undefined), p + META_GUARD);
});

test('autonomous=true 时前导 + 空行 + 原 prompt + 守卫尾缀', () => {
  const p = '帮我修个 bug';
  const out = withAutonomy(p, true);
  assert.ok(out.startsWith(AUTONOMY_PREAMBLE));
  assert.ok(out.endsWith(p + META_GUARD));
  assert.strictEqual(out, AUTONOMY_PREAMBLE + '\n\n' + p + META_GUARD);
});

test('模板字节稳定（两次调用逐字节一致）', () => {
  const a = withAutonomy('x', true);
  const b = withAutonomy('x', true);
  assert.strictEqual(a, b);
  assert.strictEqual(withAutonomy('x', false), withAutonomy('x', undefined));
});

test('前导内容守门：三色/停问/摘要关键段落齐全', () => {
  for (const kw of ['权限边界（三色）', '绿区直接做', '黄区已授权', '红区必停',
    'git add/commit', '禁止 push', '⛔ 需要授权', '📦 交付摘要',
    '连续修复 3 次失败', '用户任务如下']) {
    assert.ok(AUTONOMY_PREAMBLE.includes(kw), `前导缺少关键段落: ${kw}`);
  }
});

test('META_GUARD 守门：封元技能误路由的关键句齐全', () => {
  for (const kw of ['任务边界', '不要调用 skill_view', 'hermes-agent',
    '不要输出「技能已加载', '立即继续任务']) {
    assert.ok(META_GUARD.includes(kw), `守卫缺少关键句: ${kw}`);
  }
});

test('prompt 为空串时 autonomous=true 仍返回前导+守卫（调用方上游已拦空 prompt）', () => {
  assert.strictEqual(withAutonomy('', true), AUTONOMY_PREAMBLE + '\n\n' + META_GUARD);
});
