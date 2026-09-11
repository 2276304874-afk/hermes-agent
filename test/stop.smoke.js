#!/usr/bin/env node
'use strict';
/* =============================================================================
 * test/stop.smoke.js —— /api/stop 后端契约测试（中止 / 幂等 / 两种 id 都命中）
 *
 * 为什么单独补它：stop 这条路径看似简单，却是唯一一条「用户主动中断」的逃生通道。
 * 它有四个容易回归的语义，此前只有手测，没有自动化断言：
 *   1) 未活跃的 runId → 必须返回 ok:false 而不是 200 ok:true（否则前端会误报"已停止"）；
 *   2) 活跃 run → ok:true，且 SSE 流要在数秒内真正收尾（不是"答应了但还在后台跑"）；
 *   3) 幂等：同一 runId 二次 stop → ok:false（映射已摘除），且不抛异常；
 *   4) gateway 路径同时用 runId 与 sessionId 注册到 active，两个 id 都要能命中。
 *
 * 用法：
 *   node test/stop.smoke.js [port] [token]
 *   node test/stop.smoke.js 4173 "$(cat ~/.hermes/ui_token)"
 *
 * 前置：server 与 gateway 均在跑；gateway 不可达时 /api/chat 会走 -z 保底，
 *       stop 语义两条后端一致（都用 active 映射），故不强制要求 gateway 在线。
 * ========================================================================== */

const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = process.argv[2] || '4173';
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = process.argv[3] || process.env.HERMES_TOKEN || (() => {
  try { return fs.readFileSync(path.join(os.homedir(), '.hermes', 'ui_token'), 'utf8').trim(); } catch { return ''; }
})();

let pass = 0, fail = 0;
const failures = [];
const check = (cond, name, detail) => {
  if (cond) { pass++; console.log(`  ✅ ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail++; failures.push(name + (detail ? ' — ' + detail : '')); console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
};

const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` };

/** 发起一次 /api/chat 并保持流打开，返回 { promise, abort, done } */
function startStream(body, onEvent) {
  const ac = new AbortController();
  let settled = false;
  const promise = (async () => {
    const r = await fetch(`${BASE}/api/chat`, {
      method: 'POST', headers, body: JSON.stringify(body), signal: ac.signal,
    });
    if (!r.ok) throw new Error(`/api/chat -> HTTP ${r.status}`);
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        if (!block.trim()) continue;
        let ev = '', data = '';
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) ev = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (!ev) continue;
        let obj = {};
        try { obj = data ? JSON.parse(data) : {}; } catch { /* 坏帧忽略 */ }
        try { onEvent && onEvent(ev, obj); } catch { /* 回调异常不中断读取 */ }
      }
    }
  })().catch((e) => {
    try { onEvent && onEvent('__stream_end__', { message: String(e && e.message || e) }); } catch { /* noop */ }
  }).finally(() => { settled = true; });
  return { promise, abort: () => ac.abort(), isSettled: () => settled };
}

function postStop(payload) {
  return fetch(`${BASE}/api/stop`, { method: 'POST', headers, body: JSON.stringify(payload) })
    .then((r) => r.json().catch(() => ({})));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!TOKEN) { console.log('⚠️  SKIP：无 UI token，无法打 /api/stop'); process.exit(0); }
  console.log(`stop 契约测试 → ${BASE}`);

  /* ---------- 1. 未活跃 runId → ok:false（不得谎报成功） ---------- */
  console.log('用例1：未活跃的 runId');
  const bogus = await postStop({ runId: 'no-such-run-id-00000000' });
  check(bogus.ok === false, '未活跃 runId → ok:false', JSON.stringify(bogus));
  check(typeof bogus.error === 'string' && bogus.error.length > 0, '返回可读的 error 字段', bogus.error);

  /* ---------- 2. 活跃 run → stop 生效，且流在数秒内真正收尾 ---------- */
  console.log('用例2：活跃 run → stop → 流收尾');
  const seen = [];
  let runId = null, sessionId = null;
  const s = startStream({ prompt: '请慢慢说：从一数到五十（冒烟测试，用于验证中断）' }, (ev, d) => {
    seen.push(ev);
    if (ev === 'ready') runId = d.runId;
    if (ev === 'session') sessionId = d.sessionId;
  });

  // 等到拿齐 runId + sessionId（最多 60s：createSession 有冷启动开销）
  const t0 = Date.now();
  while ((!runId || !sessionId) && Date.now() - t0 < 60000) await sleep(100);
  check(!!runId, '收到 ready.runId', runId || 'n/a');
  check(!!sessionId, '收到 session.sessionId', sessionId || 'n/a');

  const stopRes = await postStop({ runId });
  check(stopRes.ok === true, '活跃 runId → stop 返回 ok:true', JSON.stringify(stopRes));

  // 流必须在 30s 内自然收尾（poll 周期 150ms，真正中断后立刻结算）
  const t1 = Date.now();
  let ended = false;
  while (!ended && Date.now() - t1 < 30000) {
    if (s.isSettled()) { ended = true; break; }
    await sleep(150);
  }
  check(ended, 'stop 后 SSE 流已收尾（未在后台继续跑）', ended ? `${Math.round((Date.now() - t1) / 100) / 10}s` : '30s 仍未结束');

  /* ---------- 3. 幂等：二次 stop → ok:false ---------- */
  console.log('用例3：幂等性');
  const again = await postStop({ runId });
  check(again.ok === false, '同一 runId 二次 stop → ok:false（映射已摘除）', JSON.stringify(again));

  /* ---------- 4. sessionId 也能命中（两条后端都应注意这条） ---------- */
  console.log('用例4：以 sessionId 中止');
  const seen2 = [];
  let runId2 = null, sessionId2 = null;
  const s2 = startStream({ prompt: '再数一次：从一数到五十（冒烟测试第二轮）' }, (ev, d) => {
    seen2.push(ev);
    if (ev === 'ready') runId2 = d.runId;
    if (ev === 'session') sessionId2 = d.sessionId;
  });
  const t2 = Date.now();
  while ((!runId2 || !sessionId2) && Date.now() - t2 < 60000) await sleep(100);
  if (sessionId2) {
    const byS = await postStop({ sessionId: sessionId2 });
    check(byS.ok === true, '以 sessionId 调用 stop → ok:true', JSON.stringify(byS));
  } else {
    check(false, '未能拿到第二轮 sessionId（前置失败）', 'n/a');
  }
  const t3 = Date.now();
  let ended2 = false;
  while (!ended2 && Date.now() - t3 < 30000) { if (s2.isSettled()) { ended2 = true; break; } await sleep(150); }
  check(ended2, '第二轮 SSE 流已收尾', ended2 ? `${Math.round((Date.now() - t3) / 100) / 10}s` : '30s 仍未结束');

  // 清理：确保两条流都没挂着
  try { s.abort(); } catch { /* noop */ }
  try { s2.abort(); } catch { /* noop */ }

  console.log('');
  console.log(`结果：${pass} 通过 / ${fail} 失败`);
  if (fail) { console.log('失败项：'); failures.forEach((f) => console.log('  - ' + f)); }
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  fail++; failures.push(String(e && e.message || e).split('\n')[0]);
  console.log(`  ❌ 测试执行异常 — ${String(e && e.message || e).split('\n')[0]}`);
  console.log(`结果：${pass} 通过 / ${fail} 失败`);
  process.exit(1);
});
