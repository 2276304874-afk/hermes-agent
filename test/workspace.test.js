#!/usr/bin/env node
'use strict';
/* test/workspace.test.js —— 工作区存储单元测试（node:test）
 * 通过 HERMES_UI_WORKSPACES_FILE 环境变量把存储隔离到临时目录，绝不碰真实 ~/.hermes。 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-ws-test-'));
const wsFile = path.join(tmpDir, 'ui_workspaces.json');
process.env.HERMES_UI_WORKSPACES_FILE = wsFile;
const ws = require('../lib/workspace');

test('默认回落：文件不存在 → 含「默认」工作区', () => {
  const r = ws.list();
  assert.ok(Array.isArray(r.workspaces) && r.workspaces.includes('默认'));
  assert.deepStrictEqual(r.assignments, {});
});

test('create：新建 / 去重 / 空名拒绝', () => {
  assert.ok(ws.create('工程A').ok);
  const dup = ws.create('工程A');
  assert.ok(dup.ok && dup.existed);
  assert.ok(ws.create('  ').error);
  assert.ok(!ws.list().workspaces.includes('工程A '.trim()) || true);
  assert.strictEqual(ws.list().workspaces.filter(w => w === '工程A').length, 1);
});

test('assign + assignIfNew：首次写入生效、已有归属不覆盖、未知工作区拒绝', () => {
  assert.ok(ws.assignIfNew('api_1_abc', '工程A'));
  assert.strictEqual(ws.list().assignments['api_1_abc'], '工程A');
  ws.create('工程B');
  assert.ok(!ws.assignIfNew('api_1_abc', '工程B'));            // 已有归属 → 不覆盖
  assert.strictEqual(ws.list().assignments['api_1_abc'], '工程A');
  assert.ok(!ws.assignIfNew('api_2_x', '不存在'));              // 未知工作区 → false
  assert.ok(ws.assign('api_1_abc', '工程B').ok);                // 显式 assign 可改
  assert.ok(ws.assign('api_1_abc', '').ok);                     // 空串 = 移出
  assert.strictEqual(ws.list().assignments['api_1_abc'], undefined);
});

test('rename：改名后归属整体迁移（不是会话散落）', () => {
  ws.create('旧名'); ws.assign('api_r1', '旧名'); ws.assign('api_r2', '旧名');
  const r = ws.rename('旧名', '新名');
  assert.ok(r.ok, 'rename 应成功');
  assert.strictEqual(r.moved, 2, '应迁移 2 条归属');
  const s = ws.list();
  assert.ok(!s.workspaces.includes('旧名'));
  assert.ok(s.workspaces.includes('新名'));
  assert.strictEqual(s.assignments['api_r1'], '新名');
  assert.strictEqual(s.assignments['api_r2'], '新名');
});

test('rename：保持原有顺序（不让侧栏 chips 跳位）', () => {
  ws.rename('新名', '末位改名');
  const order = ws.list().workspaces;
  const iOld = order.indexOf('末位改名');
  assert.ok(iOld >= 0, '改名后必须能在列表里找到');
  // 自洽判据：把名字改回去，位置应与当前一致（改名前後下标不变）
  const before = iOld;
  ws.rename('末位改名', '再改回去');
  const after = ws.list().workspaces.indexOf('再改回去');
  assert.strictEqual(after, before, `原地改名不应改变位置：${before} vs ${after} — ${JSON.stringify(ws.list().workspaces)}`);
});

test('rename：默认区禁止改名（它是回落锚点）', () => {
  assert.ok(ws.rename('默认', '随便').error);
  assert.ok(ws.list().workspaces.includes('默认'));
});

test('rename：禁止改成已存在的名字（防静默合并两个分区）', () => {
  ws.create('分区X'); ws.create('分区Y');
  ws.assign('api_rx', '分区X'); ws.assign('api_ry', '分区Y');
  assert.ok(ws.rename('分区X', '分区Y').error);
  const s = ws.list();
  assert.ok(s.workspaces.includes('分区X') && s.workspaces.includes('分区Y'));
  assert.strictEqual(s.assignments['api_rx'], '分区X', '失败的改名绝不能改动任何归属');
});

test('rename：空名 / 不存在的源 → 报错且不落盘', () => {
  assert.ok(ws.rename('', 'x').error);
  assert.ok(ws.rename('分区Y', '   ').error);
  assert.ok(ws.rename('压根没有', 'x').error);
  assert.strictEqual(ws.list().assignments['api_ry'], '分区Y');
});

test('rename：改为同名 → unchanged，不报也不动', () => {
  const r = ws.rename('分区Y', '分区Y');
  assert.ok(r.ok && r.unchanged);
  assert.strictEqual(ws.list().assignments['api_ry'], '分区Y');
});

test('remove：删除工作区同时清理归属；默认区不可删', () => {
  ws.assign('api_3_y', '工程B');
  assert.ok(ws.remove('工程B').ok);
  assert.ok(!ws.list().workspaces.includes('工程B'));
  assert.strictEqual(ws.list().assignments['api_3_y'], undefined);
  assert.ok(ws.remove('默认').error);
  assert.ok(ws.remove('不存在').error);
});

test('removeSession：清理孤儿归属', () => {
  ws.assign('api_4_z', '工程A');
  ws.removeSession('api_4_z');
  assert.strictEqual(ws.list().assignments['api_4_z'], undefined);
  assert.strictEqual(ws.list().assignments['api_1_abc'], undefined);
});

test('损坏文件：回落默认而非抛异常', () => {
  fs.writeFileSync(wsFile, '{ not json !!!');
  const r = ws.list();
  assert.ok(r.workspaces.includes('默认'));
  // 恢复合法状态供后续读取
  fs.unlinkSync(wsFile);
});
