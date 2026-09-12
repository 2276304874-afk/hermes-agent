'use strict';
/*
 * scripts/judge-demo.js —— 停止条件裁判可重复演示（零依赖）
 * ============================================================
 * 用法：node scripts/judge-demo.js
 *
 * 模拟一个会在「反复跑测试」上打转的 agent，逐步把每轮工具调用喂给裁判，
 * 打印每一步的裁决（ok / warn / hard）与状态跃迁。证明「乐观停止」发生时
 * 裁判会在第 2 次拿到相同结果时判 hard（same_result），且不会把正常探索误报。
 *
 * 这补的是 stopjudge.test.js 之外的「真实轨迹」维度：单测是合成小场景，
 * 这里跑的是审计文档复现过的真实跑偏模式，肉眼可见裁判在工作。
 */

const { createJudge } = require('../lib/stopjudge');

const LEVEL_TAG = { ok: '✅', warn: '⚠️ ', hard: '🛑' };

function call(name, args) {
  return { role: 'assistant', tool_calls: JSON.stringify([{ function: { name, arguments: args } }]) };
}
function res(output) {
  return { role: 'tool', content: JSON.stringify({ output }) };
}

/** 跑一段轨迹，逐步打印裁决。 */
function play(title, steps) {
  console.log('\n────────────────────────────────────────────────');
  console.log('轨迹：' + title);
  console.log('────────────────────────────────────────────────');
  const j = createJudge();
  steps.forEach((step, i) => {
    const { transitions } = j.observe([step.call, step.result]);
    const r = j.result();
    const tag = LEVEL_TAG[r.level] || '  ';
    const line = `  轮${String(i + 1).padStart(2)} ${step.label.padEnd(28)} → ${tag} ${r.level}${r.code ? ' / ' + r.code : ''}`;
    console.log(line);
    for (const t of transitions) {
      console.log(`         ↳ 裁判提示: ${t.message}`);
    }
  });
  const fin = j.result();
  console.log(`  —— 最终: ${LEVEL_TAG[fin.level]} ${fin.level}${fin.code ? ' / ' + fin.code : ''}`);
  return j;
}

console.log('停止条件裁判演示（createJudge 默认阈值：repeat=3, same_result=2, budget=40）');

// 1) 正常探索：每次调用的文件/命令都不同，结果各异 → 全程 ok
play('正常探索（读不同文件，结果各异）', [
  { label: 'read src/a.js', call: call('read_file', { path: 'src/a.js' }), result: res('body A') },
  { label: 'read src/b.js', call: call('read_file', { path: 'src/b.js' }), result: res('body B') },
  { label: 'edit src/a.js', call: call('edit_file', { path: 'src/a.js', patch: '1' }), result: res('applied') },
  { label: 'grep TODO', call: call('grep', { pattern: 'TODO' }), result: res('3 matches') },
  { label: 'read src/c.js', call: call('read_file', { path: 'src/c.js' }), result: res('body C') },
]);

// 2) 命令打转：node build.js 每次都报同一个缺失模块 → 第 2 次相同结果即 hard
play('命令打转（node build.js 反复同样的报错）', [
  { label: "terminal 'node build.js'", call: call('terminal', { command: 'node build.js' }), result: res("ERROR: Cannot find module 'foo'") },
  { label: "terminal 'node build.js'", call: call('terminal', { command: 'node build.js' }), result: res("ERROR: Cannot find module 'foo'") },
  { label: "terminal 'node build.js'", call: call('terminal', { command: 'node build.js' }), result: res("ERROR: Cannot find module 'foo'") },
]);

// 3) 测试卡死：先正常几轮，再卡在 npm test 同样的 3 failing → 第 2 次 same_result 即 hard
play('先正常、后卡在「反复跑测试」', [
  { label: 'read src/a.js', call: call('read_file', { path: 'src/a.js' }), result: res('A') },
  { label: 'read src/b.js', call: call('read_file', { path: 'src/b.js' }), result: res('B') },
  { label: 'edit src/a.js', call: call('edit_file', { path: 'src/a.js', patch: '1' }), result: res('ok') },
  { label: "terminal 'npm test'", call: call('terminal', { command: 'npm test' }), result: res('3 failing') },
  { label: "terminal 'npm test'", call: call('terminal', { command: 'npm test' }), result: res('3 failing') },
]);

console.log('\n提示：裁判默认**只报告不中断**。要强制中断需设 HERMES_JUDGE_ABORT=1，');
console.log('由 lib/routes/chat.js 在收到 hard 裁判时调用 stats.abort() 中止本轮 run。');
