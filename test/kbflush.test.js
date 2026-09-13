'use strict';
/* =============================================================================
 * test/kbflush.test.js —— 「压缩/回退边界按需 flush 记忆」的行为锁
 *
 * 锁死的是 lib/kbflush.js 的四个契约：
 *   1) 启用时 → 以 detached 方式拉起 `sync.sh --capture-only`（不跑蒸馏）；
 *   2) 节流窗口内的第二次调用被跳过（防抖，避免连续压缩打爆）；
 *   3) HERMES_KB_FLUSH=0 时整体关闭；
 *   4) spawn 抛错时**不冒泡**（best-effort，绝不能拖垮 chat/回退请求）。
 * 外加两条静态契约：sync.sh 有单实例锁 + --capture-only 早退分支。
 * ========================================================================== */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const kbflush = require(path.join(ROOT, 'lib', 'kbflush.js'));
const { WORKSPACE } = require(path.join(ROOT, 'lib', 'config.js'));

function fakeChild() {
  return { on() { return this; }, unref() { return this; } };
}

/* 每个用例前后清掉可影响判定的 env，避免用例互相污染 */
function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; }
  Object.assign(process.env, vars);
  try { return fn(); } finally {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('启用时以 detached 拉起 sync.sh --capture-only', () => {
  withEnv({ HERMES_KB_FLUSH: '1', HERMES_KB_FLUSH_THROTTLE_MS: '0' }, () => {
    kbflush._resetForTest();
    const calls = [];
    kbflush._setSpawnForTest((cmd, args, opts) => { calls.push({ cmd, args, opts }); return fakeChild(); });

    const r = kbflush.flushMemory('compact');
    assert.strictEqual(r.ok, true, '应当返回 ok');
    assert.strictEqual(calls.length, 1, '应当恰好 spawn 一次');
    assert.strictEqual(calls[0].cmd, '/bin/bash');
    assert.deepStrictEqual(calls[0].args, [path.join(WORKSPACE, 'kb', 'sync.sh'), '--capture-only']);
    assert.strictEqual(calls[0].opts.cwd, WORKSPACE);
    assert.strictEqual(calls[0].opts.detached, true);
    assert.strictEqual(calls[0].opts.stdio, 'ignore');
    assert.strictEqual(calls[0].opts.env.HERMES_KB_FLUSH_REASON, 'compact');
    kbflush._resetForTest();
  });
});

test('节流窗口内的第二次调用被跳过', () => {
  withEnv({ HERMES_KB_FLUSH: '1', HERMES_KB_FLUSH_THROTTLE_MS: '60000' }, () => {
    kbflush._resetForTest();
    let n = 0;
    kbflush._setSpawnForTest(() => { n++; return fakeChild(); });

    assert.strictEqual(kbflush.flushMemory('compact').ok, true);
    const second = kbflush.flushMemory('rollback');
    assert.strictEqual(second.ok, false);
    assert.strictEqual(second.skipped, 'throttled');
    assert.strictEqual(n, 1, '第二次不应真的 spawn');
    kbflush._resetForTest();
  });
});

test('HERMES_KB_FLUSH=0 时整体关闭（不 spawn）', () => {
  withEnv({ HERMES_KB_FLUSH: '0', HERMES_KB_FLUSH_THROTTLE_MS: '0' }, () => {
    kbflush._resetForTest();
    let n = 0;
    kbflush._setSpawnForTest(() => { n++; return fakeChild(); });

    const r = kbflush.flushMemory('compact');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.skipped, 'disabled');
    assert.strictEqual(n, 0);
    assert.strictEqual(kbflush.isEnabled(), false);
    kbflush._resetForTest();
  });
});

test('spawn 抛错时不冒泡（best-effort）', () => {
  withEnv({ HERMES_KB_FLUSH: '1', HERMES_KB_FLUSH_THROTTLE_MS: '0' }, () => {
    kbflush._resetForTest();
    kbflush._setSpawnForTest(() => { throw new Error('ENOENT spawn bash'); });

    let r;
    assert.doesNotThrow(() => { r = kbflush.flushMemory('compact'); });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.skipped, 'spawn-failed');
    kbflush._resetForTest();
  });
});

test('sync.sh 具备单实例锁与 --capture-only 早退分支', () => {
  const sh = fs.readFileSync(path.join(WORKSPACE, 'kb', 'sync.sh'), 'utf8');
  assert.match(sh, /mkdir "\$LOCK"/, '应有原子 mkdir 锁');
  assert.match(sh, /trap 'rmdir "\$LOCK"/, '应在 EXIT 时释放锁');
  assert.match(sh, /\[ "\$MODE" = "capture" \]/, '应有 capture-only 早退判断');
  assert.match(sh, /--capture-only/, '应识别 --capture-only 参数');
  // 关键：capture-only 分支必须排在 distill 之前（否则等于没省下模型调用）
  const idxCapture = sh.indexOf('done (capture-only)');
  const idxDistill = sh.indexOf('kb/distill.py');
  assert.ok(idxCapture > 0 && idxDistill > 0 && idxCapture < idxDistill,
    'capture-only 早退必须出现在 distill 之前');
});
