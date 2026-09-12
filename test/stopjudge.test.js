'use strict';
/*
 * lib/stopjudge.js 单元测试。
 *
 * 这是「停止条件裁判」的服务端强制层，判错的代价不对称：
 *   · 漏报 = 少一次提示（可接受）
 *   · 误报 = 用户不再相信告警（狼来了，等于功能失效）
 * 所以这里的重点不是"能检测到"，而是**不该报的都不能报**：正常长任务、参数只差一点
 * 的不同调用、返回内容不同但看起来相似的调用，都必须保持 ok。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { createJudge, signaturesOf, normalizeArgs } = require('../lib/stopjudge');

/* 构造 state.db 形状的行：assistant 带 tool_calls，tool 带结果 */
let seq = 0;
function call(name, args) {
  return { id: ++seq, role: 'assistant', tool_calls: JSON.stringify([{ function: { name, arguments: args } }]) };
}
function result(content) { return { id: ++seq, role: 'tool', tool_name: 'x', content: content == null ? '' : JSON.stringify({ output: content }) }; }

test('normalizeArgs：键序无关（同一次调用不得因为键序差异算成两次）', () => {
  assert.strictEqual(normalizeArgs('{"a":1,"b":2}'), normalizeArgs({ b: 2, a: 1 }));
  assert.strictEqual(normalizeArgs('{"a":{"y":1,"x":2}}'), normalizeArgs({ a: { x: 2, y: 1 } }));
});

test('signaturesOf：非 assistant / 无 tool_calls / 坏 JSON 一律返回空（不得抛）', () => {
  assert.deepStrictEqual(signaturesOf({ role: 'user', content: 'hi' }), []);
  assert.deepStrictEqual(signaturesOf({ role: 'assistant' }), []);
  assert.deepStrictEqual(signaturesOf({ role: 'assistant', tool_calls: '{不是 JSON' }), []);
  assert.strictEqual(signaturesOf(call('read_file', { path: 'a' })).length, 1);
});

test('初始状态为 ok', () => {
  const j = createJudge();
  assert.strictEqual(j.result().level, 'ok');
  assert.strictEqual(j.result().code, '');
});

test('D1 重复调用达阈值 → warn（重复 2 次不报，第 3 次才报）', () => {
  // ⚠️ 结果必须各不相同：若返回也相同，D2（卡死）会先以更高严重度命中，测不到 D1
  const j = createJudge({ repeatLimit: 3, dupResultLimit: 99 });
  const rows = [];
  for (let i = 0; i < 2; i++) { rows.push(call('terminal', { command: 'pytest -q' }), result(`1 failed (attempt ${i})`)); }
  j.observe(rows);
  assert.strictEqual(j.result().level, 'ok', '两次还不该报（探索阶段）');

  const t2 = j.observe([call('terminal', { command: 'pytest -q' }), result('1 failed (attempt 2)')]);
  assert.strictEqual(j.result().level, 'warn');
  assert.strictEqual(j.result().code, 'repeat');
  assert.strictEqual(t2.transitions.length, 1, '状态跃迁应恰好上报一次');
  assert.strictEqual(j.result().evidence.hits, 3);
});

test('★ 高精度：参数不同的同类调用不得算作重复', () => {
  const j = createJudge({ repeatLimit: 3 });
  const rows = [];
  for (let i = 0; i < 6; i++) { rows.push(call('terminal', { command: `pytest test${i}.js` }), result('ok')); }
  j.observe(rows);
  assert.strictEqual(j.result().level, 'ok', '6 次不同命令属于正常探索，不能报');
});

test('★ 高精度：同名工具但参数不同（工具名相同）也不得报', () => {
  const j = createJudge({ repeatLimit: 2 });
  j.observe([
    call('read_file', { path: 'a.js' }), result('A'),
    call('read_file', { path: 'b.js' }), result('B'),
  ]);
  assert.strictEqual(j.result().level, 'ok');
});

test('D2 同一调用 + 返回完全相同 → hard（卡死而非探索）', () => {
  const j = createJudge({ repeatLimit: 99, dupResultLimit: 2 });
  // 第一次拿到结果 A
  j.observe([call('terminal', { command: 'node build.js' }), result('ERROR: missing module')]);
  assert.strictEqual(j.result().level, 'ok', '首次出现不算重复');
  // 第二次拿到同样的 A —— dup 达 2（A 已见过一次 + 本次）→ hard
  const t = j.observe([call('terminal', { command: 'node build.js' }), result('ERROR: missing module')]);
  assert.strictEqual(j.result().level, 'hard');
  assert.strictEqual(j.result().code, 'same_result');
  assert.strictEqual(t.transitions.length, 1);
});

test('★ 高精度：返回不同（哪怕都是错误）不得判 hard', () => {
  const j = createJudge({ repeatLimit: 99, dupResultLimit: 2 });
  for (let i = 0; i < 5; i++) {
    j.observe([call('terminal', { command: 'make' }), result(`ERROR #${i}: different cause`)]);
  }
  assert.strictEqual(j.result().level, 'ok', '错误内容各不相同 = 在推进，不是卡死');
});

test('D3 调用总数超预算 → hard', () => {
  const j = createJudge({ repeatLimit: 99, dupResultLimit: 99, callBudget: 5 });
  const rows = [];
  for (let i = 0; i < 6; i++) rows.push(call('read_file', { path: `f${i}` }), result(`body ${i}`));
  j.observe(rows);
  assert.strictEqual(j.result().level, 'hard');
  assert.strictEqual(j.result().code, 'budget');
});

test('hard 不被后续 warn 冲掉（严重度单调不降）', () => {
  const j = createJudge({ repeatLimit: 2, dupResultLimit: 2, callBudget: 99 });
  j.observe([call('terminal', { command: 'x' }), result('same')]);
  j.observe([call('terminal', { command: 'x' }), result('same')]);   // → hard/same_result
  assert.strictEqual(j.result().code, 'same_result');
  j.observe([call('terminal', { command: 'x' })]);                   // 再撞 repeat（warn）
  assert.strictEqual(j.result().level, 'hard', 'hard 必须保持');
  assert.strictEqual(j.result().code, 'same_result');
});

test('同一结论只报一次（不重复刷告警）', () => {
  const j = createJudge({ repeatLimit: 2, dupResultLimit: 99 });
  const t1 = j.observe([call('terminal', { command: 'x' }), result('r1'), call('terminal', { command: 'x' }), result('r2')]);
  assert.strictEqual(t1.transitions.length, 1);
  const t2 = j.observe([call('terminal', { command: 'x' }), result('r3')]);
  assert.strictEqual(t2.transitions.length, 0, '同 code 不再上报');
});

test('结果归因到最近一次调用（不依赖 Map 插入序）', () => {
  const j = createJudge({ repeatLimit: 99, dupResultLimit: 2 });
  // A 先出现一次，随后 B 出现（Map 插入序里 B 在最后），再回头重复 A 的调用与结果。
  // 若用"Map 最后一个"归因，这次重复会被错记到 B 上 → A 的卡死就检测不到。
  j.observe([
    call('read_file', { path: 'a' }), result('A body'),
    call('terminal', { command: 'b' }), result('B fail'),
  ]);
  assert.strictEqual(j.result().level, 'ok');

  j.observe([call('read_file', { path: 'a' }), result('A body')]);
  assert.strictEqual(j.result().level, 'hard', 'A 的相同返回第二次出现 → 判卡死');
  assert.strictEqual(j.result().evidence.tool, 'read_file', '必须归因到 read_file(A)，不是 terminal(B)');
});

test('stats 报告统计口径（供 UI/诊断核对）', () => {
  const j = createJudge();
  j.observe([call('read_file', { path: 'a' }), result('A'), call('read_file', { path: 'b' }), result('B')]);
  const s = j.stats();
  assert.strictEqual(s.calls, 2);
  assert.strictEqual(s.distinct, 2);
});

test('observe(undefined/[]) 不抛（路由层可能拿到空批次）', () => {
  const j = createJudge();
  assert.strictEqual(j.observe(undefined).state.level, 'ok');
  assert.strictEqual(j.observe([]).transitions.length, 0);
});
