'use strict';
/* =============================================================================
 * test/usage.test.js —— lib/usage.js 回归测试（node:test，零依赖）
 *
 * 重点覆盖两处"看起来能跑、其实会悄悄丢数据/报错"的地方：
 *   1. 从文件中间开始读的尾部截断 —— 第一行必然是半截 JSON，必须丢掉；
 *      漏丢会让每次聚合静默少一条，看起来像"最近一轮没记上"。
 *   2. 超限裁剪 —— 必须保尾部（最新的），而不是保头部（最旧的）。
 *
 * 约定：**所有用例都传显式 file 路径**，绝不碰真实 ~/.hermes/usage.jsonl。
 * ========================================================================== */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const U = require('../lib/usage');

let TMP;
before(() => { TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-usage-')); });
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ } });

const tmp = (name) => path.join(TMP, name);
const write = (name, text) => { const p = tmp(name); fs.writeFileSync(p, text); return p; };

/* ------------------------------------------------------------ usageFile */
describe('usageFile', () => {
  test('HERMES_USAGE_FILE 优先于默认值', () => {
    assert.equal(U.usageFile({ HERMES_USAGE_FILE: '/tmp/x.jsonl' }), '/tmp/x.jsonl');
  });
  test('无环境变量时回落到 config 默认路径（含 usage.jsonl）', () => {
    assert.match(U.usageFile({}), /usage\.jsonl$/);
  });
});

/* ---------------------------------------------------------- appendUsage */
describe('appendUsage', () => {
  test('追加一行且能被 readUsageTail 读回', () => {
    const f = tmp('append.jsonl');
    U.appendUsage({ ts: 1000, elapsedSec: 2.5, toolCalls: 1 }, f);
    U.appendUsage({ ts: 2000, elapsedSec: 3.5, toolCalls: 0 }, f);
    const rows = U.readUsageTail(f);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].ts, 1000);
    assert.equal(rows[1].elapsedSec, 3.5);
  });

  test('写不进去也不抛（best-effort，不能拖垮聊天路径）', () => {
    const bad = path.join(TMP, 'no-such-dir', 'x.jsonl');
    assert.doesNotThrow(() => U.appendUsage({ ts: 1 }, bad));
  });
});

/* --------------------------------------------------------- readUsageTail */
describe('readUsageTail', () => {
  test('文件不存在 → 空数组', () => {
    assert.deepEqual(U.readUsageTail(tmp('missing.jsonl')), []);
  });

  test('尾部截断时丢弃半截首行（不得丢/错最新那条）', () => {
    const rows = [];
    for (let i = 1; i <= 40; i++) rows.push({ ts: i, pad: 'x'.repeat(60) });
    const f = write('tail.jsonl', rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    // 只读尾部 200 字节：一定会从某行中间切开
    const got = U.readUsageTail(f, 200);
    assert.ok(got.length > 0, '应至少解析出一条');
    assert.ok(got.length < 40, '不应把整个文件都读进来');
    // 关键断言：每一条都必须是完整 JSON，且最后一条就是文件里最后一条
    for (const r of got) assert.equal(typeof r.ts, 'number');
    assert.equal(got[got.length - 1].ts, 40);
  });

  test('坏行被跳过，不影响其余记录', () => {
    const f = write('broken.jsonl', '{"ts":1}\nnot-json\n{"ts":2}\n');
    const rows = U.readUsageTail(f);
    assert.deepEqual(rows.map(r => r.ts), [1, 2]);
  });
});

/* ------------------------------------------------------------ summarize */
describe('summarize', () => {
  const NOW = 1_700_000_000_000;
  const H = 3600 * 1000;

  test('空输入不抛，计数为 0、均值为 null', () => {
    const s = U.summarize([], NOW);
    assert.equal(s.total, 0);
    assert.equal(s.last24h, 0);
    assert.equal(s.avgFirstTokenSec24h, null);
    assert.equal(s.avgTokPerSec24h, null);
    assert.equal(s.firstTs, null);
    assert.equal(s.lastTs, null);
  });

  test('窗口划分、均值、工具调用与本地/云端计数', () => {
    const recs = [
      { ts: NOW - 1 * H, firstTokenSec: 2, tokPerSec: 10, elapsedSec: 20, toolCalls: 2 },
      { ts: NOW - 2 * H, firstTokenSec: 4, tokPerSec: 20, elapsedSec: 40, toolCalls: 0, cloud: true },
      { ts: NOW - 3 * 24 * H, firstTokenSec: 99, tokPerSec: 1, elapsedSec: 999, toolCalls: 5 },
    ];
    const s = U.summarize(recs, NOW);
    assert.equal(s.total, 3);
    assert.equal(s.last24h, 2, '24h 窗口只算前两条');
    assert.equal(s.last7d, 3, '第三条在 72 小时前 → 落在 7 天窗口内');
    assert.equal(s.avgFirstTokenSec24h, 3, '(2+4)/2');
    assert.equal(s.avgTokPerSec24h, 15);
    assert.equal(s.avgElapsedSec24h, 30);
    assert.equal(s.toolCallsTotal, 7);
    assert.equal(s.localRuns, 2);
    assert.equal(s.cloudRuns, 1);
    assert.equal(s.firstTs, NOW - 3 * 24 * H);
    assert.equal(s.lastTs, NOW - 1 * H);
  });

  test('缺失/非数值字段被跳过，不产生 NaN', () => {
    const s = U.summarize([{ ts: NOW, firstTokenSec: null }, { ts: NOW, tokPerSec: 5 }], NOW);
    assert.equal(s.avgFirstTokenSec24h, null);
    assert.equal(s.avgTokPerSec24h, 5);
    assert.equal(s.avgElapsedSec24h, null);
  });
});

/* ------------------------------------------------------ trimIfOversized */
describe('trimIfOversized', () => {
  test('未超限不动文件', () => {
    const f = write('small.jsonl', '{"ts":1}\n{"ts":2}\n');
    assert.equal(U.trimIfOversized(f, 1024, 10), false);
    assert.equal(fs.readFileSync(f, 'utf8'), '{"ts":1}\n{"ts":2}\n');
  });

  test('超限时保留**尾部** N 行（最新的），不是头部', () => {
    const lines = [];
    for (let i = 1; i <= 50; i++) lines.push(JSON.stringify({ ts: i, pad: 'y'.repeat(40) }));
    const f = write('big.jsonl', lines.join('\n') + '\n');
    assert.equal(U.trimIfOversized(f, 300, 5), true);
    const rows = U.readUsageTail(f);
    assert.equal(rows.length, 5);
    assert.deepEqual(rows.map(r => r.ts), [46, 47, 48, 49, 50]);
  });
});

/* --------------------------------------------------------- usageSummary */
describe('usageSummary（端到端：落盘 → 聚合）', () => {
  test('写 3 条后聚合出正确计数', () => {
    const f = tmp('e2e.jsonl');
    const now = Date.now();
    U.appendUsage({ ts: now - 60_000, firstTokenSec: 1.5, tokPerSec: 12, elapsedSec: 30 }, f);
    U.appendUsage({ ts: now - 30_000, firstTokenSec: 2.5, tokPerSec: 18, elapsedSec: 31 }, f);
    U.appendUsage({ ts: now, elapsedSec: 32 }, f);
    const s = U.usageSummary(f);
    assert.equal(s.total, 3);
    assert.equal(s.last24h, 3);
    assert.equal(s.avgFirstTokenSec24h, 2);
    assert.equal(s.avgTokPerSec24h, 15);
    assert.equal(s.avgElapsedSec24h, 31);
  });
});
