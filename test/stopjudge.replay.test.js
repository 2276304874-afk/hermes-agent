'use strict';
/*
 * 停止条件裁判 · 真实轨迹回放测试（A1 复测）
 * ============================================
 * 与 stopjudge.test.js 的分工：
 *   · 那边是**合成小场景**，专攻「不该报的不能报」（高精度低召回的反面验证）；
 *   · 这边用**真实感的 agent 运行轨迹**（取自 docs/PROJECT-AUDIT 复现过的跑偏模式）
 *     回放，证明裁判在「乐观停止 / 打转」真发生时能正确报出，并**界定能力边界**。
 *
 * 审计文档里复现过两类跑偏：
 *   ② 反复用同样参数重试同一条命令，每次都拿到同样的失败结果，绕不出来
 *      → 这正是 D2 same_result（同一调用+返回完全相同 ≥2 → hard）要抓的。
 *   ① 上下文被吃满后失忆，把「做旅行网站」退化成写 hello-world 原型 demo
 *      → 这是**语义漂移**，每次工具调用都不同，确定性判据覆盖不到（需 LLM 裁判）。
 *        本文件用场景 3 显式固化这个边界，避免误以为裁判能治一切跑偏。
 *
 * 运行：node --test test/stopjudge.replay.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { createJudge } = require('../lib/stopjudge');

let seq = 0;
const call = (name, args) =>
  ({ id: ++seq, role: 'assistant', tool_calls: JSON.stringify([{ function: { name, arguments: args } }]) });
const res = (content) =>
  ({ id: ++seq, role: 'tool', tool_name: 'x', content: JSON.stringify({ output: content }) });

/** 一次性把整段轨迹喂完，返回裁判。 */
function run(rows) {
  const j = createJudge();
  for (const r of rows) j.observe([r]);
  return j;
}

test('回放②：命令打转（同一命令 + 同一错误反复出现）→ D2 hard', () => {
  // 审计复现过的「绕不出来」：node build.js 每次都报同一个缺失模块
  const rows = [];
  for (let i = 0; i < 4; i++) {
    rows.push(call('terminal', { command: 'node build.js' }), res("ERROR: Cannot find module 'foo'"));
  }
  const j = run(rows);
  assert.strictEqual(j.result().level, 'hard');
  assert.strictEqual(j.result().code, 'same_result');
  // 第 2 次拿到相同返回即达 dupLimit=2 → hard；证据凝固在首次判定（同结论只报一次），
  // 故 hits 停在第 2 次的累计数，而非全部 4 次。这是设计行为，不是 bug。
  assert.strictEqual(j.result().evidence.hits, 2);
});

test('回放：先重复写文件(warn) → 再测试卡死(hard)，严重度单调且最终 hard', () => {
  const j = createJudge();
  // 3 次重复 edit，但每次结果不同 → 只撞 D1（repeatLimit=3 → warn）
  for (let i = 0; i < 2; i++) {
    j.observe([call('edit_file', { path: 'a.js', patch: 'x' }), res(`applied ${i}`)]);
  }
  assert.strictEqual(j.result().level, 'ok', '还差一次才到 repeatLimit');
  const t1 = j.observe([call('edit_file', { path: 'a.js', patch: 'x' }), res('applied 2')]);
  assert.strictEqual(j.result().level, 'warn');
  assert.strictEqual(j.result().code, 'repeat');
  assert.strictEqual(t1.transitions.length, 1, 'warn 应恰好上报一次');

  // 随后测试卡死：npm test 同一错误 ×2
  j.observe([call('terminal', { command: 'npm test' }), res('3 failing')]); // 首次，仍 ok 级
  const t2 = j.observe([call('terminal', { command: 'npm test' }), res('3 failing')]); // 第 2 次同结果
  assert.strictEqual(j.result().level, 'hard', 'D2 必须覆盖先前的 warn');
  assert.strictEqual(j.result().code, 'same_result');
  assert.strictEqual(t2.transitions.length, 1);
});

test('边界①：语义跑偏（做网站退化成 hello-world）但每次工具调用都不同 → ok', () => {
  // 这类确定性判据**抓不到**——调用各异，没有重复签名，也没有相同结果。
  const j = createJudge();
  const files = ['index.html', 'style.css', 'app.js', 'hello.tsx', 'demo.py', 'README.md'];
  for (let i = 0; i < files.length; i++) {
    j.observe([call('write_file', { path: files[i], content: `prototype ${i}` }), res('written')]);
  }
  assert.strictEqual(j.result().level, 'ok', '语义漂移超出确定性判据范围，需 LLM 冷裁判');
  assert.strictEqual(j.stats().calls, files.length);
});

test('回放：真实探索 —— 12 次不同命令/不同结果，全部 ok（不误报）', () => {
  const j = createJudge();
  for (let i = 0; i < 12; i++) {
    j.observe([call('read_file', { path: `src/f${i}.js` }), res(`body ${i}`)]);
  }
  assert.strictEqual(j.result().level, 'ok');
  assert.strictEqual(j.stats().calls, 12);
});

test('回放：混合轨迹 —— 正常 5 轮后卡在「反复跑测试」，第 2 次同结果即 hard', () => {
  const j = createJudge();
  const normal = [
    [call('read_file', { path: 'a.js' }), res('A')],
    [call('read_file', { path: 'b.js' }), res('B')],
    [call('edit_file', { path: 'a.js', patch: '1' }), res('ok')],
    [call('grep', { pattern: 'TODO' }), res('3 matches')],
    [call('read_file', { path: 'c.js' }), res('C')],
  ];
  for (const [c, r] of normal) j.observe([c, r]);
  assert.strictEqual(j.result().level, 'ok', '正常阶段不报');

  // 卡在测试循环：npm test 反复同样的 3 failing
  j.observe([call('terminal', { command: 'npm test' }), res('3 failing')]);
  assert.strictEqual(j.result().level, 'ok', '首次测试失败是正常反馈');
  const t = j.observe([call('terminal', { command: 'npm test' }), res('3 failing')]);
  assert.strictEqual(t.transitions.length, 1, 'hard 应恰好上报一次');
  assert.strictEqual(j.result().level, 'hard');
  assert.strictEqual(j.result().code, 'same_result');
  assert.strictEqual(j.result().evidence.calls > 5, true, '证据应含累计调用数');
});

test('设计契约：judge 只报告，绝不自行中断（abort 决定权在 chat.js）', () => {
  // chat.js:77 用 `t.level === 'hard' && judgeAbortEnabled()` 决定是否 abort；
  // judge 本身是纯状态机，不抛副作用。这保证「默认只报告」的安全契约。
  const j = createJudge();
  j.observe([call('terminal', { command: 'x' }), res('same')]);
  j.observe([call('terminal', { command: 'x' }), res('same')]); // → hard
  assert.strictEqual(j.result().level, 'hard');
  assert.strictEqual(typeof j.result().aborted, 'undefined', 'judge 无权自行中断');
});

test('回放：D3 预算兜底 —— 50 次不同调用（失控式刷工具）→ hard/budget', () => {
  // 注意：这是兜底，正常长任务若调用确实多样不会撞（<40）。
  // 只有「无目的刷工具」才会超 40；属预期内的 high-recall 兜底。
  const j = createJudge({ repeatLimit: 99, dupResultLimit: 99 });
  for (let i = 0; i < 50; i++) {
    j.observe([call('read_file', { path: `massive/f${i}.js` }), res(`b${i}`)]);
  }
  assert.strictEqual(j.result().level, 'hard');
  assert.strictEqual(j.result().code, 'budget');
  // budget 在第 40 次调用即命中（total>=40），证据凝固在 40；之后调用因同 code 去重不再刷新。
  assert.strictEqual(j.result().evidence.calls, 40);
});
