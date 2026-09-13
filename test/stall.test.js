'use strict';
/* =============================================================================
 * test/stall.test.js —— ⑥ 模型 stall 降级决策的行为锁
 *
 * lib/stall.js 是纯函数，所有分支都能断言 —— 这正是把它抽出来的原因：
 * 降级一旦判错（例如"降到一个冷的备用模型"）会让 16G 机器比不降级更慢，
 * 而这类错误在真机上极难复现（要恰好撞上一次 model stall）。
 *
 * 重点锁死两条硬边界：
 *   A) 已经在流式输出（首 token 已见）→ 绝不降级；
 *   B) 备用模型未驻留 → 绝不降级（降它要先驱逐主模型，代价更大）。
 * ========================================================================== */

const test = require('node:test');
const assert = require('node:assert');
const { stallConfig, failoverPlan } = require('../lib/stall');

const OK = {
  firstTokenSeen: false, attempts: 0, sec: 60,
  model: 'hermes-local-gemma4', fallback: 'qwen3:8b', fallbackResident: true,
};

test('stallConfig：未设 / 非法 / ≤0 一律视为关闭', () => {
  assert.deepStrictEqual(stallConfig({}), { sec: 0, fallback: '' });
  assert.strictEqual(stallConfig({ HERMES_STALL_SEC: '' }).sec, 0);
  assert.strictEqual(stallConfig({ HERMES_STALL_SEC: 'abc' }).sec, 0);
  assert.strictEqual(stallConfig({ HERMES_STALL_SEC: '0' }).sec, 0);
  assert.strictEqual(stallConfig({ HERMES_STALL_SEC: '-5' }).sec, 0);
});

test('stallConfig：读阈值与备用模型（trim）', () => {
  const c = stallConfig({ HERMES_STALL_SEC: '45', HERMES_FALLBACK_MODEL: '  qwen3:8b  ' });
  assert.strictEqual(c.sec, 45);
  assert.strictEqual(c.fallback, 'qwen3:8b');
});

test('关闭态（sec=0）不降级', () => {
  assert.deepStrictEqual(failoverPlan({ ...OK, sec: 0 }), { action: 'none', reason: 'disabled' });
});

test('硬边界 A：已见首 token → 绝不降级', () => {
  assert.deepStrictEqual(failoverPlan({ ...OK, firstTokenSeen: true }), { action: 'none', reason: 'already-streaming' });
});

test('硬边界 B：备用模型未驻留 → 绝不降级（否则先驱逐主模型，更慢）', () => {
  assert.deepStrictEqual(failoverPlan({ ...OK, fallbackResident: false }), { action: 'none', reason: 'fallback-cold' });
});

test('只降一级：attempts≥1 不再降', () => {
  assert.deepStrictEqual(failoverPlan({ ...OK, attempts: 1 }), { action: 'none', reason: 'retry-exhausted' });
  assert.deepStrictEqual(failoverPlan({ ...OK, attempts: 2 }), { action: 'none', reason: 'retry-exhausted' });
});

test('未配置备用模型 → 不降级', () => {
  assert.deepStrictEqual(failoverPlan({ ...OK, fallback: '' }), { action: 'none', reason: 'no-fallback' });
});

test('备用与当前同一模型 → 无意义，不降级', () => {
  assert.deepStrictEqual(failoverPlan({ ...OK, fallback: 'hermes-local-gemma4' }), { action: 'none', reason: 'same-model' });
});

test('条件齐备 → 降级到备用模型', () => {
  assert.deepStrictEqual(failoverPlan(OK), { action: 'retry', model: 'qwen3:8b' });
});

test('判定优先级：关闭 > 已在流式 > 已降过 > 无备用 > 同模型 > 备用未驻留', () => {
  // 同时违反多条时，应按上面顺序返回最靠前的原因（顺序错了会把"没配置"误报成"备用冷"）
  assert.strictEqual(failoverPlan({ ...OK, sec: 0, firstTokenSeen: true }).reason, 'disabled');
  assert.strictEqual(failoverPlan({ ...OK, firstTokenSeen: true, attempts: 1 }).reason, 'already-streaming');
  assert.strictEqual(failoverPlan({ ...OK, attempts: 1, fallback: '' }).reason, 'retry-exhausted');
  assert.strictEqual(failoverPlan({ ...OK, fallback: '', fallbackResident: false }).reason, 'no-fallback');
  assert.strictEqual(failoverPlan({ ...OK, fallback: 'hermes-local-gemma4', fallbackResident: false }).reason, 'same-model');
  assert.strictEqual(failoverPlan({ ...OK, fallbackResident: false }).reason, 'fallback-cold');
});
