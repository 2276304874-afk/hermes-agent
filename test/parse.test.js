'use strict';
/* =============================================================================
 * test/parse.test.js —— lib/parse.js 回归测试（node:test，零依赖）
 *
 * 跑法：  npm test          （= node --test test/）
 *         node --test test/
 *
 * Fixture 来源约定（重要，别编造）：
 *   - [真实] = 从本机 hermes CLI / 实际文件里抄下来的原文
 *   - [合成] = 当前机器没有对应数据（如 cron 无任务），按已知格式构造
 *   改解析正则时，必须同步更新 fixture，否则测过了也不能说明问题。
 * ========================================================================== */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const P = require('../lib/parse');

/* ---------------------------------------------------------------- 假日志器 */
function fakeLog() {
  const warns = [];
  return { warns, warn: (m) => warns.push(m) };
}

/* ------------------------------------------------------------ sessions list */
describe('parseSessions', () => {
  test('[真实] 解析 hermes sessions list 表格', () => {
    // 抄自本机 `hermes sessions list --limit 5`（含表头 + 长横线分隔符 + 占位标题 '—'）
    const raw = [
      'Title                        Workspace          Last Active   ID',
      '─'.repeat(110),
      '我刚刚给你升级到内容你知道吗               赫尔墨斯特工             1h ago        20260911_173559_3e8110',
      '—                            赫尔墨斯特工             16h ago       20260911_022504_4f8a05',
      '请记住：测试数字是 7391。只用一句话确认。      tmp                16h ago       20260911_021903_78a27e',
    ].join('\n');
    const rows = P.parseSessions(raw);
    assert.equal(rows.length, 3, '表头与分隔符必须被跳过');
    assert.equal(rows[0].id, '20260911_173559_3e8110');
    assert.equal(rows[0].title, '我刚刚给你升级到内容你知道吗');
    assert.equal(rows[0].info, '赫尔墨斯特工 1h ago');
    assert.equal(rows[1].title, '—', '占位标题也要保留成一行');
  });

  test('空输入 / 垃圾输入 → 空数组，不抛错', () => {
    assert.deepEqual(P.parseSessions(''), []);
    assert.deepEqual(P.parseSessions(undefined), []);
    assert.deepEqual(P.parseSessions('乱码没有ID的一行内容'), []);
    assert.deepEqual(P.parseSessions('a b c'), [], 'id 格式不对不得通过');
  });

  test('id 必须匹配 YYYYMMDD_HHMMSS_xxxxxx', () => {
    assert.equal(P.parseSessions('标题 ws 1h ago 20260911_173559_3E8110').length, 0, '大写十六进制不合法');
    assert.equal(P.parseSessions('标题 ws 1h ago 2026091_173559_3e8110').length, 0, '日期少一位不合法');
    assert.equal(P.parseSessions('标题 ws 1h ago 20260911_173559_3e8110').length, 1);
  });
});

/* -------------------------------------------------------------- cron list */
describe('parseCronList', () => {
  test('[真实] "No scheduled jobs." → 空数组（当前机器真实输出）', () => {
    const raw = "No scheduled jobs.\nCreate one with 'hermes cron create ...' or the /cron command in chat.";
    assert.deepEqual(P.parseCronList(raw), []);
  });

  test('[合成] 两个任务：头行 + 缩进键值行', () => {
    const raw = [
      '  Scheduled jobs:',
      '',
      '  9f3a2b1c [active]',
      '    Name:     每日总结',
      '    Schedule: 0 9 * * *',
      '    Next run: 2026-09-12 09:00',
      '    Prompt:   总结昨天的会话',
      '',
      '  ab12cd34 [paused]',
      '    Name:     巡检',
      '    Schedule: every 2h',
      '    Repeat:   3',
    ].join('\n');
    const jobs = P.parseCronList(raw);
    assert.equal(jobs.length, 2);
    assert.equal(jobs[0].id, '9f3a2b1c');
    assert.equal(jobs[0].state, 'active');
    assert.equal(jobs[0].name, '每日总结');
    assert.equal(jobs[0].schedule, '0 9 * * *');
    assert.equal(jobs[0].nextRun, '2026-09-12 09:00');
    assert.equal(jobs[0].prompt, '总结昨天的会话');
    assert.equal(jobs[1].state, 'paused');
    assert.equal(jobs[1].repeat, '3');
  });

  test('键值行出现在任何任务头之前 → 被忽略（不产生幽灵任务）', () => {
    assert.deepEqual(P.parseCronList('    Name: 孤儿\n    Schedule: x'), []);
  });
});

/* --------------------------------------------------------------- mcp list */
describe('parseMcpList', () => {
  test('[真实] "No MCP servers configured." → 空数组', () => {
    const raw = '\n  No MCP servers configured.\n\n  Add one with:\n    hermes mcp add <name> --url <endpoint>\n';
    assert.deepEqual(P.parseMcpList(raw), []);
  });

  test('[合成] 已配置服务器：名称 + 两空格以上 + 详情', () => {
    const raw = [
      '  MCP servers:',
      '  filesystem       npx -y @modelcontextprotocol/server-filesystem /tmp',
      '  github           https://api.githubcopilot.com/mcp/',
      '  ┌──────────┐',
    ].join('\n');
    const servers = P.parseMcpList(raw);
    assert.equal(servers.length, 2);
    assert.equal(servers[0].name, 'filesystem');
    assert.match(servers[0].detail, /^npx -y /);
    assert.equal(servers[1].name, 'github');
  });
});

/* ------------------------------------------------------------ skills list */
describe('parseSkillsList', () => {
  test('[合成] 表格行（│ 细线 / ┃ 粗线都要认）', () => {
    const raw = [
      '┃ Name     ┃ Category ┃ Source  ┃ Trust   ┃ Status  ┃ Desc ┃',
      '│ pdfkit   │ doc      │ local   │ trusted │ active  │ PDF  │',
      '│──────────────────────────────────────────────────────────│',
    ].join('\n');
    const skills = P.parseSkillsList(raw);
    assert.equal(skills.length, 1, '表头行与分隔行都不能算技能');
    assert.equal(skills[0].name, 'pdfkit');
    assert.equal(skills[0].category, 'doc');
    assert.equal(skills[0].status, 'active');
  });
});

/* ---------------------------------------------------- warnIfParseEmpty */
describe('warnIfParseEmpty', () => {
  test('解析出结果 → 不告警', () => {
    const log = fakeLog();
    assert.equal(P.warnIfParseEmpty('x', 'x'.repeat(100), 3, log), false);
    assert.equal(log.warns.length, 0);
  });

  test('真的没输出 / 输出极短 → 不告警（正常空态）', () => {
    const log = fakeLog();
    P.warnIfParseEmpty('x', '', 0, log);
    P.warnIfParseEmpty('x', '   ', 0, log);
    P.warnIfParseEmpty('x', 'short', 0, log);
    assert.equal(log.warns.length, 0);
  });

  test('明确的空态文案 → 不告警（这是真实数据走到的分支）', () => {
    const log = fakeLog();
    P.warnIfParseEmpty('cron list', "No scheduled jobs.\nCreate one with 'hermes cron create ...'", 0, log);
    P.warnIfParseEmpty('mcp list', '\n  No MCP servers configured.\n\n  Add one with:\n', 0, log);
    P.warnIfParseEmpty('kb', '暂无数据，请先导入内容后重试', 0, log);
    assert.equal(log.warns.length, 0);
  });

  test('有实质输出却解析 0 条 → 必须告警（格式变更征兆）', () => {
    const log = fakeLog();
    const raw = 'Title        Workspace     Last Active     ID\n' + '─'.repeat(80) + '\n若干行但格式已变，正则全部失配';
    assert.equal(P.warnIfParseEmpty('sessions list', raw, 0, log), true);
    assert.equal(log.warns.length, 1);
    assert.match(log.warns[0], /\[parse\] ⚠ sessions list/);
    assert.match(log.warns[0], /疑似输出格式变更/);
  });
});

/* -------------------------------------------------------------- parseResult */
describe('parseResult', () => {
  test('解析出结果 → ok，items 原样带出，无 warning', () => {
    const log = fakeLog();
    const items = [{ id: '20260911_173559_3e8110' }];
    const r = P.parseResult('sessions list', 'whatever', items, log);
    assert.equal(r.ok, true);
    assert.deepEqual(r.items, items);
    assert.equal(r.warning, '');
    assert.equal(log.warns.length, 0);
  });

  test('格式变更征兆（有输出却 0 条）→ ok:false，warning 指明来源，且留下日志线索', () => {
    const log = fakeLog();
    const r = P.parseResult('sessions list', 'x'.repeat(80), [], log);
    assert.equal(r.ok, false);
    assert.equal(r.items.length, 0);
    assert.match(r.warning, /sessions list/);
    assert.match(r.warning, /疑似格式变更/);
    assert.equal(log.warns.length, 1, '降级必须同时留日志，光有前端提示不够排障');
  });

  test('真实空态（No scheduled jobs.）→ 仍 ok，不得误报降级', () => {
    const log = fakeLog();
    const r = P.parseResult('cron list', "No scheduled jobs.\nCreate one with 'hermes cron create ...'", [], log);
    assert.equal(r.ok, true);
    assert.equal(r.warning, '');
    assert.equal(log.warns.length, 0);
  });

  test('raw 恒为字符串（null/undefined 不炸），且不截断（排障要原文）', () => {
    assert.equal(P.parseResult('x', undefined, [], fakeLog()).raw, '');
    assert.equal(P.parseResult('x', null, [], fakeLog()).raw, '');
    const big = 'y'.repeat(5000);
    assert.equal(P.parseResult('x', big, [{ a: 1 }], fakeLog()).raw.length, 5000);
  });

  test('items 非数组 → 退化为空数组，并按"0 条 + 有输出"判降级', () => {
    const r = P.parseResult('x', 'z'.repeat(60), undefined, fakeLog());
    assert.deepEqual(r.items, []);
    assert.equal(r.ok, false);
  });
});

/* --------------------------------------------------------- KB 条目解析 */
describe('KB 解析', () => {
  // 抄自 .workbuddy/kb_inbox.md 与 kb_distilled.md 的真实标题格式
  const INBOX = [
    '',
    '### [工具链] 20260905_013956_224d90 · Write and Verify Chain_OK',
    '任务：Step1: use write_file to write CHAIN_OK',
    '工具序列：write_file → read_file',
    '',
    '### [偏好] 20260905_120954_b3f735 · 审查 security.py',
    '工具调用规范：必须用 read_file',
    '',
  ].join('\n');
  const DISTILLED = [
    '',
    '## 技能（源自 [工具链] 20260905_013956_224d90 · Write and Verify Chain_OK）',
    '步骤：先写后读验证',
    '',
    '## 技能（源自 [排障] 20260906_031724_28f3c1 · 这张报错截图是什么问题？）',
    '要点：先看端口占用',
    '',
  ].join('\n');

  test('kbParseBlocks：按标题切块，正文归到上一块', () => {
    const blocks = P.kbParseBlocks(INBOX, 'inbox', /^###\s*\[[^\]]*\]\s*(.*)/);
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].cat, 'inbox');
    assert.equal(blocks[0].src, '20260905_013956_224d90 · Write and Verify Chain_OK');
    assert.match(blocks[0].text, /write_file → read_file/);
    assert.equal(blocks[1].src, '20260905_120954_b3f735 · 审查 security.py');
  });

  test('kbParseBlocks：空文本 → 空数组', () => {
    assert.deepEqual(P.kbParseBlocks('', 'inbox', /^###/), []);
  });

  test('kbListFromBlocks：inbox + distilled + memory 三源合并', () => {
    const all = P.kbListFromBlocks({
      inbox: INBOX,
      distilled: DISTILLED,
      memoryFiles: [{ src: '.workbuddy/memory/MEMORY.md', text: '# 长期记忆' }],
    });
    assert.equal(all.length, 5, '2 inbox + 2 distilled + 1 memory');
    assert.equal(all.filter(e => e.cat === 'inbox').length, 2);
    assert.equal(all.filter(e => e.cat === 'distilled').length, 2);
    assert.equal(all.filter(e => e.cat === 'memory').length, 1);
    assert.equal(all.find(e => e.cat === 'memory').type, '记忆');
    // distilled 的 src 应保留原始来源（含方括号前缀）
    assert.match(all.find(e => e.cat === 'distilled').src, /^\[工具链\] 20260905_013956_224d90/);
  });

  test('kbListFromBlocks：cat 过滤 + 空 memory 文件不计入', () => {
    const src = { inbox: INBOX, distilled: DISTILLED, memoryFiles: [{ src: 'x', text: '' }] };
    assert.equal(P.kbListFromBlocks(src, 'inbox').length, 2);
    assert.equal(P.kbListFromBlocks(src, 'distilled').length, 2);
    assert.equal(P.kbListFromBlocks(src, 'memory').length, 0, '空文本的记忆文件不得产生空条目');
    assert.equal(P.kbListFromBlocks(src, 'all').length, 4);
  });

  test('kbListFromBlocks：无参调用不抛错（HTTP 路径不能 500）', () => {
    assert.deepEqual(P.kbListFromBlocks(), []);
    assert.deepEqual(P.kbListFromBlocks({}, 'all'), []);
  });
});

/* ------------------------------------------------------------ resolvePython */
describe('resolvePython', () => {
  let tmpHome;

  before(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-parse-test-'));
    const versionsDir = path.join(tmpHome, '.workbuddy', 'binaries', 'python', 'versions');
    for (const v of ['3.9.6', '3.13.12', '3.10.0']) {
      fs.mkdirSync(path.join(versionsDir, v, 'bin'), { recursive: true });
      fs.writeFileSync(path.join(versionsDir, v, 'bin', 'python3'), '');
    }
    // 真实存在的坑：versions/current 是**纯文本文件**而不是软链，必须被 isDirectory 过滤掉
    fs.writeFileSync(path.join(versionsDir, 'current'), '3.13.12\n');
    // 缺 bin/python3 的目录也必须被跳过
    fs.mkdirSync(path.join(versionsDir, '3.14.0'), { recursive: true });
  });

  after(() => { try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {} });

  test('版本号按【数值】比较，取最高（3.13.12 必须胜过 3.9.6）', () => {
    const got = P.resolvePython(tmpHome, {});
    assert.ok(got.endsWith(path.join('3.13.12', 'bin', 'python3')),
      `期望选中 3.13.12，实际 ${got} —— 若选中 3.9.6 说明用了字典序排序`);
  });

  test('忽略非目录（versions/current 纯文本文件）与缺 bin/python3 的目录', () => {
    const got = P.resolvePython(tmpHome, {});
    assert.ok(!got.includes('current'), '不得把 current 当版本目录');
    assert.ok(!got.includes('3.14.0'), '缺 bin/python3 的目录不得入选');
  });

  test('KB_PYTHON 环境变量优先（且必须真实存在）', () => {
    const fake = path.join(tmpHome, 'my-python');
    fs.writeFileSync(fake, '');
    assert.equal(P.resolvePython(tmpHome, { KB_PYTHON: fake }), fake);
    // 指向不存在的路径 → 忽略，回落到托管目录
    const got = P.resolvePython(tmpHome, { KB_PYTHON: path.join(tmpHome, 'nope') });
    assert.ok(got.endsWith(path.join('3.13.12', 'bin', 'python3')));
  });

  test('home 不存在 → 回退到系统解释器，绝不抛错、绝不全空', () => {
    const got = P.resolvePython(path.join(tmpHome, 'does-not-exist'), {});
    assert.equal(typeof got, 'string');
    assert.ok(got.length > 0);
    assert.ok(/python3$/.test(got), `回退值应以 python3 结尾，实际 ${got}`);
  });
});
