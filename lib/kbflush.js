'use strict';
/* =============================================================================
 * lib/kbflush.js —— 「在压缩 / 检查点回退边界按需 flush 一次记忆沉淀」
 *
 * 由来（OpenClaw 借鉴清单第 4 条 Auto Memory Flush）：
 *   OpenClaw 在 context 压缩前触发一次静默 turn，催模型把重要信息写进记忆文件 ——
 *   因为它的原始上下文是易失的，压缩即永久丢失。
 *   特工**没有**这个数据丢失问题：state.db 里的原始会话是持久化的，
 *   压缩只是「另开一个新会话挂摘要」，旧会话的消息一条不动；而 kb/capture.py
 *   是按 id 指针扫 state.db 的，30min 定时器迟早会把它捞走。所以数据不会丢。
 *
 *   真正的缺口只是**时效**：定时器最坏要等 30min。若用户「长谈 → 立刻压缩 → 关页」，
 *   这段经验要等下一个 tick 才落盘。本条就是把这个延迟压掉：
 *   在「本来就要压缩/回退」的边界上顺手 flush 一次，不新增无谓压缩（护住 prompt cache）。
 *
 * 为什么只跑捕获、不跑蒸馏（sync.sh --capture-only）：
 *   蒸馏 distill.py 要调 hermes-local-gemma4（16G 机器上常驻 ~9.5G）。压缩/回退后
 *   紧接着就是用户在新会话里的第一条消息 —— 此刻抢内存正是最坏时机。
 *   capture.py 是纯规则、秒级、不调模型，落盘即安全；蒸馏/建索引交给 30min 定时器。
 *
 * 边界与安全：
 *   · best-effort：detached + stdio ignore + unref，spawn 失败绝不影响请求本身；
 *   · 幂等：sync.sh 自带原子 mkdir 锁，与定时器并发时后到者直接跳过；
 *   · 可关：HERMES_KB_FLUSH=0 关掉（测试/排障）；HERMES_KB_FLUSH_THROTTLE_MS 调节流。
 * ========================================================================== */

const { spawn } = require('child_process');
const path = require('path');
const { WORKSPACE } = require('./config');

const SYNC_SH = path.join(WORKSPACE, 'kb', 'sync.sh');
const THROTTLE_MS = Number(process.env.HERMES_KB_FLUSH_THROTTLE_MS) || 30 * 1000;

let lastFlush = 0;
let _spawn = spawn;               // 测试可注入
const _spawned = [];              // 测试可观测

function isEnabled() {
  return process.env.HERMES_KB_FLUSH !== '0';
}

/**
 * 按需 flush 一次记忆捕获（只捕获，不蒸馏）。
 * @param {string} reason 触发原因（compact / rollback / manual），仅记录用
 * @returns {{ok:boolean, skipped?:string, error?:string}}
 */
function flushMemory(reason) {
  if (!isEnabled()) return { ok: false, skipped: 'disabled' };
  const now = Date.now();
  if (now - lastFlush < THROTTLE_MS) return { ok: false, skipped: 'throttled' };
  lastFlush = now;
  try {
    const child = _spawn('/bin/bash', [SYNC_SH, '--capture-only'], {
      cwd: WORKSPACE,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, HERMES_KB_FLUSH_REASON: String(reason || '') },
    });
    _spawned.push(String(reason || ''));
    // detached + stdio ignore：spawn 异步失败（ENOENT 等）不能冒泡成 unhandledRejection
    if (child && typeof child.on === 'function') child.on('error', () => {});
    if (child && typeof child.unref === 'function') child.unref();
    return { ok: true };
  } catch (e) {
    return { ok: false, skipped: 'spawn-failed', error: e && e.message };
  }
}

/* ---- 测试专用：注入 spawn / 重置节流（不参与生产逻辑） ---- */
function _setSpawnForTest(fn) { _spawn = fn; }
function _resetForTest() { lastFlush = 0; _spawn = spawn; _spawned.length = 0; }
function _spawnedForTest() { return _spawned.slice(); }

module.exports = { flushMemory, isEnabled, _setSpawnForTest, _resetForTest, _spawnedForTest };
