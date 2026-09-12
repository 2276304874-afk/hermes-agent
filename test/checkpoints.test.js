'use strict';
/*
 * lib/checkpoints.js 契约测试。
 *
 * 全部跑在**临时影子库**上（HERMES_CHECKPOINT_BASE 指向 tmp），绝不碰 ~/.hermes/checkpoints。
 * ⚠️ HERMES_CHECKPOINT_BASE 必须在 require 之前设好 —— 模块在加载期读它。
 *
 * 覆盖的每条断言都对应一个真实踩过的坑：
 *   · 共享库让"任意 workdir + 任意提交"都能 cat-file 可见 → 必须挡（实测把整个项目
 *     checkout 进了 /private/tmp）
 *   · 单文件回退：目标检查点里该文件不存在时，语义是**删除**
 *   · 安全回退：台账认定由助手写入且未被手改的才覆盖，用户手改的一律保留
 *   · 回退前必须留下 pre-rollback 快照（"撤销的撤销"）
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const TMP = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hermes-cp-test-'));
process.env.HERMES_CHECKPOINT_BASE = path.join(TMP, 'cpbase');
process.env.HERMES_CHECKPOINT_MAX_SNAPSHOTS = '20';

const cp = require('../lib/checkpoints');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function newProject(name) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"probe"}');   // 项目标记
  return fs.realpathSync(dir);
}
function setLedger(workdir, absFile, content) {
  const p = path.join(cp.STORE, 'ledgers', `${cp._internal.projectHash(workdir)}.json`);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const l = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
  l[absFile] = { sha256: sha(content), ts: Date.now() / 1000 };
  fs.writeFileSync(p, JSON.stringify(l));
}

test('take：首次快照建库 + 登记项目；无差异时 skip 而非报错', () => {
  const ws = newProject('p1');
  fs.writeFileSync(path.join(ws, 'a.txt'), 'v1');
  const r = cp.take(ws, 'test: first');
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.match(r.hash, /^[0-9a-f]{40}$/);

  const again = cp.take(ws, 'test: no change');
  assert.strictEqual(again.ok, true);
  assert.strictEqual(again.skipped, '与上一次快照无差异');

  const projects = cp.listProjects();
  assert.strictEqual(projects.length, 1);
  assert.strictEqual(projects[0].workdir, ws);
  assert.strictEqual(projects[0].commits, 1);
});

test('listCheckpoints：倒序 + 变更统计', () => {
  const ws = newProject('p2');
  fs.writeFileSync(path.join(ws, 'a.txt'), 'one\n');
  cp.take(ws, 'first');
  fs.writeFileSync(path.join(ws, 'a.txt'), 'one\ntwo\n');
  cp.take(ws, 'second');

  const list = cp.listCheckpoints(ws);
  assert.strictEqual(list.length, 2);
  assert.strictEqual(list[0].reason, 'second', '最新的在最前');
  assert.strictEqual(list[0].insertions, 1, '新增 1 行');
  assert.strictEqual(list[0].filesChanged, 1);
  assert.strictEqual(list[1].filesChanged, 0, '根提交无父 → 统计为 0');
});

test('安全回退：台账认定的助手写入被覆盖，用户手改被保留', () => {
  const ws = newProject('p3');
  const f = path.join(ws, 'a.txt');
  fs.writeFileSync(f, 'v1');
  setLedger(ws, f, 'v1');
  const c1 = cp.take(ws, 'a=v1');

  fs.writeFileSync(f, 'v2');
  setLedger(ws, f, 'v2');                 // 模拟助手再写一次（record_agent_write）
  const userFile = path.join(ws, 'notes.md');
  fs.writeFileSync(userFile, 'hand-written');

  const p = cp.plan(ws, c1.hash);
  assert.deepStrictEqual(p.restore, ['a.txt'], 'a.txt 应可覆盖');
  assert.ok(p.skipped.includes('notes.md'), '用户新建的文件应保留');

  const r = cp.restore(ws, c1.hash);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.mode, 'safe');
  assert.strictEqual(fs.readFileSync(f, 'utf8'), 'v1', 'a.txt 回到 v1');
  assert.ok(fs.existsSync(userFile), 'notes.md 未被触碰');
});

test('安全回退：变动文件全部是手改 → 明确报告"无需回退"且不动文件', () => {
  const ws = newProject('p4');
  const f = path.join(ws, 'a.txt');
  fs.writeFileSync(f, 'v1');
  setLedger(ws, f, 'v1');
  const c1 = cp.take(ws, 'a=v1');
  fs.writeFileSync(f, 'user changed this');    // 手改但不同步台账

  const r = cp.restore(ws, c1.hash);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.restoredFiles, []);
  assert.deepStrictEqual(r.skippedUserEdits, ['a.txt']);
  assert.strictEqual(fs.readFileSync(f, 'utf8'), 'user changed this');
});

test('整目录回退（all）：连手改一起覆盖', () => {
  const ws = newProject('p5');
  const f = path.join(ws, 'a.txt');
  fs.writeFileSync(f, 'v1');
  const c1 = cp.take(ws, 'a=v1');
  fs.writeFileSync(f, 'hand edit');

  const r = cp.restore(ws, c1.hash, { all: true });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.mode, 'all');
  assert.strictEqual(fs.readFileSync(f, 'utf8'), 'v1');
});

test('单文件回退：文件存在于目标检查点 → 还原内容', () => {
  const ws = newProject('p6');
  const f = path.join(ws, 'a.txt');
  fs.writeFileSync(f, 'v1');
  const c1 = cp.take(ws, 'a=v1');
  fs.writeFileSync(f, 'v2');

  const r = cp.restore(ws, c1.hash, { file: 'a.txt' });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.mode, 'file');
  assert.strictEqual(fs.readFileSync(f, 'utf8'), 'v1');
});

test('单文件回退：文件在目标检查点中不存在 → 语义为删除', () => {
  const ws = newProject('p7');
  fs.writeFileSync(path.join(ws, 'seed.txt'), 'x');
  const before = cp.take(ws, '只有 seed');          // 此刻还没有 later.txt
  const later = path.join(ws, 'later.txt');
  fs.writeFileSync(later, 'created by agent');
  setLedger(ws, later, 'created by agent');
  cp.take(ws, 'after later.txt');

  const r = cp.restore(ws, before.hash, { file: 'later.txt' });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.deepStrictEqual(r.deleted, ['later.txt']);
  assert.strictEqual(fs.existsSync(later), false, 'later.txt 应被删除');
});

test('回退前留下 pre-rollback 快照（可撤销的撤销）', () => {
  const ws = newProject('p8');
  const f = path.join(ws, 'a.txt');
  fs.writeFileSync(f, 'v1');
  setLedger(ws, f, 'v1');
  const c1 = cp.take(ws, 'a=v1');
  fs.writeFileSync(f, 'v2');
  setLedger(ws, f, 'v2');

  const r = cp.restore(ws, c1.hash);
  assert.strictEqual(r.ok, true);
  const list = cp.listCheckpoints(ws);
  assert.ok(list.some((c) => c.reason.startsWith('回退前快照')), '应出现 pre-rollback 快照');
  // c1 + 回退前快照 = 2；回退本身不会再产生提交（快照只在写文件前拍）
  assert.ok(list.length >= 2, `至少 2 条，实际 ${list.length}`);
});

test('★ 守卫：跨项目哈希必须被拒（共享库让任意提交 cat-file 可见）', () => {
  const A = newProject('guard-a');
  const B = newProject('guard-b');
  fs.writeFileSync(path.join(A, 'a.txt'), 'A');
  fs.writeFileSync(path.join(B, 'b.txt'), 'B');
  const ca = cp.take(A, 'A snapshot');
  cp.take(B, 'B snapshot');

  // ca.hash 在共享库里 cat-file 可见，但它不属于 B 的历史
  const r = cp.restore(B, ca.hash);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /不属于此项目/);
  assert.strictEqual(fs.existsSync(path.join(B, 'a.txt')), false, 'B 不得被写入 A 的文件');
  assert.strictEqual(cp.diff(B, ca.hash).ok, false);
  assert.strictEqual(cp.plan(B, ca.hash).ok, false);
});

test('守卫：未注册目录 / $HOME / 非法哈希 一律拒绝', () => {
  const ws = newProject('p9');
  fs.writeFileSync(path.join(ws, 'a.txt'), 'x');
  const c1 = cp.take(ws, 'x');

  assert.strictEqual(cp.resolveWorkdir(TMP), null, '未注册目录 → null');
  assert.strictEqual(cp.resolveWorkdir(fs.realpathSync(os.homedir())), null, '$HOME → null');
  assert.strictEqual(cp.resolveWorkdir(ws), ws);

  const unregistered = path.join(TMP, 'never-snapshotted');
  fs.mkdirSync(unregistered, { recursive: true });
  assert.strictEqual(cp.restore(unregistered, c1.hash).ok, false, '未注册目录不得回退');

  assert.strictEqual(cp.restore(ws, 'zzz; rm -rf /').ok, false);
  assert.strictEqual(cp.restore(ws, 'abcdef').ok, false, '不存在于历史中的哈希');
  assert.strictEqual(cp.take(fs.realpathSync(os.homedir()), 'x').ok, false, '$HOME 不得快照');
});

test('路径穿越：file 参数逃出项目目录 → 拒绝', () => {
  const ws = newProject('p10');
  fs.writeFileSync(path.join(ws, 'a.txt'), 'x');
  const c1 = cp.take(ws, 'x');
  for (const bad of ['../../../etc/hosts', '../outside.txt', '/etc/hosts', '..']) {
    const r = cp.restore(ws, c1.hash, { file: bad });
    assert.strictEqual(r.ok, false, `应拒绝：${bad}`);
  }
});

test('超限文件不进快照（体积上限）', () => {
  const ws = newProject('p11');
  fs.writeFileSync(path.join(ws, 'small.txt'), 'ok');
  const big = path.join(ws, 'big.bin');
  fs.writeFileSync(big, Buffer.alloc(11 * 1024 * 1024));   // > 10MB 默认上限
  const r = cp.take(ws, 'with oversize');
  assert.strictEqual(r.ok, true);

  const st = cp._internal.runGit(
    ['ls-tree', '-r', '--name-only', r.hash], ws,
  );
  assert.ok(st.ok);
  assert.ok(st.out.includes('small.txt'));
  assert.ok(!st.out.includes('big.bin'), '超限文件不应被登记进快照');
});

test('diff：返回 stat + patch，且索引被复位（不污染后续快照）', () => {
  const ws = newProject('p12');
  fs.writeFileSync(path.join(ws, 'a.txt'), 'l1\n');
  const c1 = cp.take(ws, 'first');
  fs.writeFileSync(path.join(ws, 'a.txt'), 'l1\nl2\n');

  const d = cp.diff(ws, c1.hash);
  assert.strictEqual(d.ok, true);
  assert.match(d.stat, /1 file changed/);
  assert.match(d.patch, /\+l2/);

  // 复位后：无新改动 → take 应判为无差异
  const t = cp.take(ws, 'after diff');
  assert.strictEqual(t.ok, true);
  assert.strictEqual(t.skipped, undefined, 'diff 后确实有新改动 → 应生成新快照');
});

test('storeInfo：报告库状态与项目数', () => {
  const info = cp.storeInfo();
  assert.strictEqual(info.ready, true);
  assert.strictEqual(info.base, process.env.HERMES_CHECKPOINT_BASE);
  assert.strictEqual(info.projects, cp.listProjects().length);
  assert.ok(info.sizeBytes > 0);
});
