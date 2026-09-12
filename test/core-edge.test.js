'use strict';
/* =============================================================================
 * test/core-edge.test.js —— 核心逻辑边界用例（node:test，零依赖）
 *
 * 覆盖三块最近改动过/历史上出过事故的核心逻辑：
 *   1. lib/parse.js SESSION_ID_RE —— 三种会话 id 形态的单一真源（-z / gateway / legacy），
 *      曾因双份不同步导致全部 gateway 会话 400（2026-09-11 事故），边界必须锁死
 *   2. lib/parse.js parseSessions —— 空输入 / CRLF / #runId 后缀标题 / 退化路径
 *   3. lib/safety.js approveSession —— 秒级时间戳契约（写毫秒=永久放行的历史血泪），
 *      含「毫秒残留条目清理」；测试会临时改写真实 bypass 文件并在 after 恢复
 * ========================================================================== */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const P = require('../lib/parse');
const { BYPASS_FILE, approveSession } = require('../lib/safety');

/* --------------------------------------------------------- 1. SESSION_ID_RE */
describe('SESSION_ID_RE（三形态单一真源）', () => {
  const RE = P.SESSION_ID_RE;
  const ok = (id, why) => test(`接受 ${id}（${why}）`, () => assert.equal(RE.test(id), true));
  const no = (id, why) => test(`拒绝 ${JSON.stringify(id)}（${why}）`, () => assert.equal(RE.test(id), false));

  ok('20260912_135801_a1b2c3', '-z 形态：日期_时间_6位hex');
  ok('20260911_022504_4f8a05', '-z 形态（真实 fixture）');
  ok('api_1789157245_abc123', 'gateway 形态：epoch_6位尾');
  ok('api_1234567890_abcd1234ef', 'gateway 形态：尾段更长');
  ok('api-abc123def', 'legacy 形态：连字符');

  no('20260912_135801_a1b2c', '-z 尾段只有 5 位');
  no('api_12345_abc123', 'gateway epoch 段只有 5 位');
  no('API_1789157245_abc123', '大写前缀');
  no('api-ab1', 'legacy 尾段过短');
  no('api_1789157245', 'gateway 缺尾段');
  no('api_xxx', 'gateway 残缺');
  no('', '空串');
  no('20260912_135801_a1b2c3 ', '带尾随空格');
});

/* --------------------------------------------------------- 2. parseSessions */
describe('parseSessions 边界', () => {
  test('空输入全部返回 []', () => {
    assert.deepEqual(P.parseSessions(''), []);
    assert.deepEqual(P.parseSessions(null), []);
    assert.deepEqual(P.parseSessions(undefined), []);
  });

  test('CRLF 行尾不产生脏字段', () => {
    const raw = 'Title   Workspace   Last Active   ID\r\n只回复两个字：你好 #b8e8f637   赫尔墨斯特工   1h ago   20260911_173559_3e8110\r\n';
    const rows = P.parseSessions(raw);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, '20260911_173559_3e8110');
    assert.ok(!rows[0].title.includes('\r'), '标题不得残留 \\r');
  });

  test('#runId 去重后缀保留在标题里（不被分列切断）', () => {
    const raw = '只回复两个字：你好 #b8e8f637              赫尔墨斯特工             1h ago        20260911_173559_3e8110';
    const rows = P.parseSessions(raw);
    assert.equal(rows.length, 1);
    assert.ok(rows[0].title.includes('#b8e8f637'), `实际标题: ${rows[0].title}`);
  });

  test('标题内单空格不截断，列间多空格正确分列', () => {
    const raw = '请记住：测试数字是 7391。只用一句话确认。      tmp                16h ago       20260911_021903_78a27e';
    const rows = P.parseSessions(raw);
    assert.equal(rows.length, 1);
    assert.ok(rows[0].title.includes('7391'), `实际标题: ${rows[0].title}`);
    assert.equal(rows[0].info, 'tmp 16h ago');
  });

  test('id 非法的行被跳过，不影响其余行', () => {
    const raw = [
      '坏行没有表格结构                          ws      1h ago     notanid',
      '好行                                      ws      2h ago     api-abcdef12',
    ].join('\n');
    const rows = P.parseSessions(raw);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 'api-abcdef12');
  });

  test('无分隔列的退化路径：按空白分词仍能解析出条目', () => {
    const raw = '标题 甲乙 1h ago api_1234567890_abc123';
    const rows = P.parseSessions(raw);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 'api_1234567890_abc123');
  });
});

/* ------------------------------------------------- 3. safety.approveSession */
describe('approveSession（秒级时间戳契约 + 残留清理）', () => {
  let original = null;
  before(() => {
    // 备份真实放行文件，测试后恢复（测试窗口毫秒级，且用 test- 前缀假会话 id）
    try { original = fs.readFileSync(BYPASS_FILE, 'utf8'); } catch { original = null; }
  });
  after(() => {
    try {
      if (original === null) fs.unlinkSync(BYPASS_FILE);
      else fs.writeFileSync(BYPASS_FILE, original, { mode: 0o600 });
    } catch { /* 恢复失败不掩盖测试结论 */ }
  });

  test('空会话 id 拒绝写入', () => {
    assert.equal(approveSession(''), false);
  });

  test('过期时间戳是秒不是毫秒（血泪契约：写毫秒=永久放行）', () => {
    assert.equal(approveSession('test-sec-unit-01'), true);
    const data = JSON.parse(fs.readFileSync(BYPASS_FILE, 'utf8'));
    const nowSec = Math.floor(Date.now() / 1000);
    const expiry = data.sessions['test-sec-unit-01'];
    assert.ok(expiry > nowSec, '必须晚于当前秒级时间');
    assert.ok(expiry < nowSec + 6 * 60, `必须是秒级（约+5分钟），实际 ${expiry}`);
  });

  test('保留其他会话未过期条目，清掉已过期条目', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    fs.writeFileSync(BYPASS_FILE, JSON.stringify({ sessions: {
      'test-keep-me': nowSec + 3600,
      'test-stale-me': nowSec - 10,
    }}), { mode: 0o600 });
    assert.equal(approveSession('test-new-entry'), true);
    const data = JSON.parse(fs.readFileSync(BYPASS_FILE, 'utf8'));
    assert.ok(data.sessions['test-keep-me'], '未过期条目必须保留');
    assert.ok(!data.sessions['test-stale-me'], '过期条目必须清理');
    assert.ok(data.sessions['test-new-entry'], '新条目必须写入');
  });

  test('历史毫秒残留条目被清理（1.7e12 会被误判为未过期 → 永久放行）', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    fs.writeFileSync(BYPASS_FILE, JSON.stringify({ sessions: {
      'test-ms-bug-residue': 1750000000000,   // 毫秒级时间戳（远超任何合法 TTL）
      'test-normal': nowSec + 60,
    }}), { mode: 0o600 });
    assert.equal(approveSession('test-foo'), true);
    const data = JSON.parse(fs.readFileSync(BYPASS_FILE, 'utf8'));
    assert.ok(!data.sessions['test-ms-bug-residue'], '毫秒残留必须被清掉');
    assert.ok(data.sessions['test-normal'], '正常条目保留');
    assert.ok(data.sessions['test-foo'], '新条目写入');
  });

  test('放行文件损坏时重建而非崩溃', () => {
    fs.writeFileSync(BYPASS_FILE, '{broken json!!', { mode: 0o600 });
    assert.equal(approveSession('test-after-corrupt'), true);
    const data = JSON.parse(fs.readFileSync(BYPASS_FILE, 'utf8'));
    assert.ok(data.sessions['test-after-corrupt']);
  });
});
