#!/usr/bin/env node
'use strict';
/* =============================================================================
 * test/chat.gateway.smoke.js —— gateway 多轮续聊 + 危险放行 后端契约测试
 *
 * 为什么需要它：选项 B 后端（gateway）的两条关键路径此前只有端到端手测验证、无自动化断言：
 *   1) 多轮续聊：前端必须把第一轮 `session` 事件里的 api_* id 回传成下一轮 body.sessionId，
 *      服务端据此走 gateway resume；一旦前端/服务端任一侧断了这条链，续聊会退化成"每次新会话"。
 *   2) 危险放行：allowDangerous:true 时 server 必须（同步于建会话后）把该 api_* 会话写进
 *      ui_bypass_sessions.json，pre_tool_call hook 才放行高危命令。
 *
 * 实现：直接打前端同款 /api/chat 端点（与浏览器同一入口），解析 SSE，不依赖模型输出具体内容，
 * 只断言事件形状，故稳定。gateway 不可达时 SKIP（不打断流水线）。
 *
 * 用法：
 *   node test/chat.gateway.smoke.js [port] [token]
 *   node test/chat.gateway.smoke.js 4173 "$(cat ~/.hermes/ui_token)"
 * ========================================================================== */

const fs = require('fs');
const os = require('os');
const path = require('path');

// 预检 gateway 健康用 lib/gateway 自带的 gatewayUp()（带正确 api_server key），
// 不应用 UI token 去打 8642 的 /health（后者走的是另一套鉴权）。
const { gatewayUp } = require('../lib/gateway');

const PORT = process.argv[2] || '4173';
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = process.argv[3] || process.env.HERMES_TOKEN || (() => {
  try { return fs.readFileSync(path.join(os.homedir(), '.hermes', 'ui_token'), 'utf8').trim(); } catch { return ''; }
})();
const HOME = os.homedir();

let pass = 0, fail = 0;
const failures = [];
function ok(name, detail) { pass++; console.log(`  ✅ ${name}${detail ? ' — ' + detail : ''}`); }
function bad(name, detail) { fail++; failures.push(`${name}${detail ? ' — ' + detail : ''}`); console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
function check(cond, name, detail) { cond ? ok(name, detail) : bad(name, detail); }

/* ---------- SSE 客户端：POST /api/chat，逐事件回调；until(ev,data) 为真则提前结束 ---------- */
function postChat(body, { onEvent, until, timeoutMs = 150000 } = {}) {
  return new Promise((resolve, reject) => {
    const ac = new AbortController();
    const timer = setTimeout(() => { ac.abort(); reject(new Error('chat 超时未结束')); }, timeoutMs);
    fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(body),
      signal: ac.signal,
    }).then(async (r) => {
      if (!r.ok) { clearTimeout(timer); return reject(new Error(`/api/chat -> HTTP ${r.status}`)); }
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      const dispatch = (block) => {
        let ev = '', data = '';
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) ev = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (!ev) return;
        let obj = {};
        try { obj = data ? JSON.parse(data) : {}; } catch { /* 忽略坏帧 */ }
        try { onEvent && onEvent(ev, obj); } catch { /* 回调异常不影响流 */ }
        if (until && until(ev, obj)) { clearTimeout(timer); ac.abort(); resolve(); }
      };
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (block.trim()) dispatch(block);
        }
      }
      clearTimeout(timer);
      resolve();
    }).catch((e) => { clearTimeout(timer); reject(e); });
  });
}

function readBypass() {
  try { return JSON.parse(fs.readFileSync(path.join(HOME, '.hermes', 'ui_bypass_sessions.json'), 'utf8')); }
  catch { return null; }
}

(async () => {
  if (!TOKEN) { console.log('⚠️  SKIP：无 UI token，无法打 /api/chat'); process.exit(0); }

  // 预检 gateway 是否在；不在则 /api/chat 会静默回退 -z，backend 不会是 gateway，无意义。
  let gwUp = false;
  try { gwUp = await gatewayUp(); } catch { gwUp = false; }
  if (!gwUp) { console.log('⚠️  SKIP：gateway 未就绪（127.0.0.1:8642），契约测试无法验证 backend=gateway'); process.exit(0); }

  console.log(`gateway 契约测试 → ${BASE}（gateway up）`);

  /* ---------- 第一轮：backend=gateway + 拿到 api_* 会话 id ---------- */
  console.log('第一轮：建会话，断言 backend=gateway + 收到 session 事件');
  let r1 = { backend: null, sessionId: null };
  await postChat({ prompt: 'ping（冒烟测试，请简短回复即可）' }, {
    onEvent: (ev, d) => {
      if (ev === 'ready') r1.backend = d.backend;
      if (ev === 'session') r1.sessionId = d.sessionId;
    },
    until: (ev, d) => ev === 'done' || (ev === 'error'),
  });
  check(r1.backend === 'gateway', 'ready.backend === gateway', String(r1.backend));
  check(!!r1.sessionId, '收到 session 事件（api_* 不透明 id）', r1.sessionId || 'n/a');

  /* ---------- 第二轮：带 sessionId 续聊，断言服务端复用同一会话 ---------- */
  console.log('第二轮：带 sessionId 续聊，断言服务端复用同一会话 + gateway 真的在处理');
  let r2 = { sessionId: null, sawOutput: false };
  await postChat({ prompt: '继续（冒烟测试第二轮）', sessionId: r1.sessionId }, {
    onEvent: (ev, d) => {
      if (ev === 'ready') r2.sessionId = d.sessionId;
      if (ev === 'token' || ev === 'msg') r2.sawOutput = true;
    },
    until: (ev, d) => ev === 'done' || (ev === 'error') || r2.sawOutput,
  });
  check(r2.sessionId === r1.sessionId, '第二轮 ready.sessionId 与第一轮一致（多轮复用）', `${r1.sessionId} -> ${r2.sessionId}`);
  check(r2.sawOutput, '第二轮 gateway 确实开始产出（token/msg 出现）', r2.sawOutput ? '有' : '无');

  /* ---------- 危险放行：allowDangerous=true → server 同步写 ui_bypass_sessions.json ---------- */
  console.log('危险放行：allowDangerous=true，断言 server 写入放行文件');
  let dSession = null;
  await postChat({ prompt: '冒烟测试：允许危险操作探测', allowDangerous: true }, {
    onEvent: (ev, d) => { if (ev === 'session') dSession = d.sessionId; },
    // 拿到 session 事件即可——approveSession 在建会话后同步调用，无需等生成结束
    until: (ev) => ev === 'session' || ev === 'error',
  });
  check(!!dSession, '危险轮收到 session 事件', dSession || 'n/a');
  if (dSession) {
    const bp = readBypass();
    const hit = bp && bp.sessions && Object.prototype.hasOwnProperty.call(bp.sessions, dSession);
    check(hit, 'ui_bypass_sessions.json 含该 api_* 会话（server 已写放行）', hit ? `${dSession} 已放行` : '未找到放行条目');
  }

  console.log('');
  console.log(`结果：${pass} 通过 / ${fail} 失败`);
  if (fail) { console.log('失败项：'); failures.forEach((f) => console.log('  - ' + f)); }
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  bad('测试执行异常', String(e && e.message || e).split('\n')[0]);
  console.log(`结果：${pass} 通过 / ${fail} 失败`);
  process.exit(1);
});
