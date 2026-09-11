#!/usr/bin/env node
'use strict';
/* ==========================================================================
 * serve 探针 —— 验证 PLAN-hermes-serve.md §7 的 1~4 步
 *
 * 零依赖：只用 Node 22 内置的 fetch 与 WebSocket。
 *
 * 背景（为什么要这个文件）：
 *   `hermes serve` 是 JSON-RPC over WebSocket 的常驻后端。改造 server.js 之前，
 *   必须先用最小探针把「协议怎么用 / 哪条路有缓存 / 哪些参数真的生效」实测清楚，
 *   而不是照着文档想当然。本文件就是那把尺子。
 *
 * 用法：
 *   node scripts/serve-probe.js step1     # resume 与缓存（热/冷/续接 三行对照）
 *   node scripts/serve-probe.js step2     # cwd / model / provider 覆盖是否落到会话级
 *   node scripts/serve-probe.js step3     # config.set yolo 是否回读为 true
 *   node scripts/serve-probe.js step4     # approval.request 触发与 approval.respond
 *   node scripts/serve-probe.js ping      # 只验证 WS 管道通不通（最快）
 *
 * 环境变量：
 *   HERMES_SERVE_PORT  默认 9119
 *   PROBE_MODEL        覆盖模型名（默认不传，用 serve/config 的默认值）
 * ========================================================================== */

const { execFileSync } = require('child_process');
const path = require('path');
const os = require('os');

const PORT = Number(process.env.HERMES_SERVE_PORT || 9119);
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL_BASE = `ws://127.0.0.1:${PORT}/api/ws`;
const PROBE_MODEL = process.env.PROBE_MODEL || '';
const WORKSPACE = process.env.HERMES_WORKSPACE || '/Users/zhaocaozheng/WorkBuddy/赫尔墨斯特工';

const ts = () => new Date().toISOString().slice(11, 23);
const log = (...a) => console.log(`[${ts()}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 从 serve 首页抓 token ---------- */
async function fetchToken() {
  const r = await fetch(`${BASE}/`, { redirect: 'manual' });
  const html = await r.text();
  const m = html.match(/__HERMES_SESSION_TOKEN__="([^"]+)"/);
  if (!m) throw new Error(`首页没找到 token（HTTP ${r.status}）：${html.slice(0, 120)}`);
  return m[1];
}

/* ---------- 零依赖 JSON-RPC over WebSocket ---------- */
class ServeClient {
  constructor(token) {
    this.token = token;
    this.ws = null;
    this.seq = 0;
    this.pending = new Map();   // rpc id -> {resolve, reject, timer}
    this.listeners = new Set(); // (frame) => void，收所有 event 帧
    this.events = [];           // 收到的 event 历史（便于事后断言）
    this.closed = false;
  }

  async open(timeoutMs = 20000) {
    await new Promise((resolve, reject) => {
      // 注意：Node 内置 WebSocket 不会自动发 Origin 头。
      // serve 的 _ws_host_origin_reason 在「Origin 缺失」时放行，正好可用。
      const ws = new WebSocket(`${WS_URL_BASE}?token=${encodeURIComponent(this.token)}`);
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error('WS 打开超时')), timeoutMs);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', (e) => {
        clearTimeout(timer);
        reject(new Error(`WS 错误: ${e.message || e.type || 'unknown'}`));
      }, { once: true });
    });

    this.ws.addEventListener('message', (ev) => {
      const raw = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8');
      let obj;
      try { obj = JSON.parse(raw); } catch { return; }
      if (obj.method === 'event') {
        this.events.push(obj);
        for (const fn of this.listeners) { try { fn(obj); } catch { /* 探针里监听器抛错不致命 */ } }
        return;
      }
      if (obj.id != null && this.pending.has(obj.id)) {
        const p = this.pending.get(obj.id);
        this.pending.delete(obj.id);
        clearTimeout(p.timer);
        obj.error ? p.reject(new Error(`RPC ${p.method} 失败: ${JSON.stringify(obj.error)}`)) : p.resolve(obj.result);
      }
      // 其余（含 gateway.ready 之类的非标准帧）忽略
    });

    this.ws.addEventListener('close', (ev) => {
      this.closed = true;
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('WS 已关闭')); }
      this.pending.clear();
    });

    // 排掉 gateway.ready（厂商参考实现 scripts/iso-certify.py 也这么做）
    await sleep(300);
    return this;
  }

  rpc(method, params = {}, timeoutMs = 60000) {
    if (this.closed) return Promise.reject(new Error('连接已关闭'));
    const id = `p${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC ${method} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  /** 注册监听；返回取消函数 */
  onEvent(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  /** 等一个满足条件的 event 帧。
   * ⚠️ fromIndex 不是可选项 —— 第一版忘了它，结果第 2 轮直接匹配到第 1 轮残留的
   * message.complete，量出「0.00s 完成、未收到 delta」的假数据。多轮测量必须用
   * 事件水位线划清"本轮"。 */
  waitEventFrom(fromIndex, pred, timeoutMs = 180000, label = 'event') {
    let cursor = fromIndex;
    const drain = () => {
      while (cursor < this.events.length) {
        const f = this.events[cursor++];
        if (pred(f)) return f;
      }
      return null;
    };
    return new Promise((resolve, reject) => {
      const hit = drain();
      if (hit) return resolve(hit);
      const off = this.onEvent(() => { const h = drain(); if (h) { clearTimeout(timer); off(); resolve(h); } });
      const timer = setTimeout(() => { off(); reject(new Error(`等待 ${label} 超时（${timeoutMs}ms）`)); }, timeoutMs);
    });
  }

  /** 从 0 开始扫（只看历史，用于一次性检查） */
  waitEvent(pred, timeoutMs = 180000, label = 'event') {
    return this.waitEventFrom(0, pred, timeoutMs, label);
  }

  close() { try { this.ws && this.ws.close(); } catch { /* 关闭失败无所谓 */ } }
}

/* ---------- 事件小工具 ---------- */
const evType = (f) => (f.params && f.params.type) || '';
const evSid = (f) => (f.params && f.params.session_id) || '';
const evPayload = (f) => (f.params && f.params.payload) || {};

/* ---------- state.db 读数（cache_read_tokens 是缓存的直接证据） ---------- */
function dbQuery(sql) {
  try {
    const out = execFileSync('/usr/bin/python3', ['-c', `
import sqlite3, json, sys
c = sqlite3.connect(${JSON.stringify(path.join(os.homedir(), '.hermes', 'state.db'))})
c.row_factory = sqlite3.Row
try:
    rows = [dict(r) for r in c.execute(${JSON.stringify(sql)})]
except Exception as e:
    rows = [{"_error": str(e)}]
print(json.dumps(rows, ensure_ascii=False))
`], { encoding: 'utf8', timeout: 15000 });
    return JSON.parse(out);
  } catch (e) {
    return [{ _error: String(e.message || e) }];
  }
}

function sessionUsage(storedId) {
  const r = dbQuery(`select cache_read_tokens, input_tokens, output_tokens, message_count,
                            system_prompt_hash, model, cwd, title
                     from sessions where id = '${String(storedId).replace(/'/g, "''")}'`);
  return r[0] || null;
}

/* ---------- 单轮：提交 → 量首字 → 等 message.complete ----------
 * 关键：用事件水位线（from）把本轮与上一轮切开。监听器只在注册后收到新帧，
 * 所以 delta 不会串；但 waitEventFrom 的历史扫描必须从 from 起，否则会命中残留帧。 */
async function runTurn(client, sid, text, label) {
  const from = client.events.length;
  const t0 = Date.now();
  let firstDelta = null;
  const off = client.onEvent((f) => {
    if (firstDelta != null) return;
    if (evSid(f) !== sid || evType(f) !== 'message.delta') return;
    firstDelta = Date.now() - t0;
  });
  const done = client.waitEventFrom(from, (f) => evSid(f) === sid && evType(f) === 'message.complete', 300000, `${label} message.complete`);
  await client.rpc('prompt.submit', { session_id: sid, text }, 60000);
  let completeFrame;
  try { completeFrame = await done; } finally { off(); }
  const p = evPayload(completeFrame);
  return {
    label,
    firstDeltaMs: firstDelta,
    totalMs: Date.now() - t0,
    status: p.status || '?',
    answer: String(p.text || '').replace(/\s+/g, ' ').slice(0, 40),
    usage: p.usage || null,
    completeKeys: Object.keys(p),
  };
}

function fmtTurn(r) {
  const fd = r.firstDeltaMs == null ? '  未收到 delta' : `${(r.firstDeltaMs / 1000).toFixed(2)}s`;
  return `  ${r.label.padEnd(24)} 首字 ${fd.padStart(12)}   整轮 ${(r.totalMs / 1000).toFixed(2)}s   status=${r.status}   「${r.answer}」`;
}

/** 从 message.complete 的 usage 里取 cache 读数字段（字段名随版本可能变，逐个试） */
function cacheOf(usage) {
  if (!usage || typeof usage !== 'object') return null;
  for (const k of ['cache_read_tokens', 'cacheReadTokens', 'cached_tokens', 'cache_read']) {
    if (typeof usage[k] === 'number') return usage[k];
  }
  return null;
}

/* ---------- 原始帧转储（协议有疑问时先用它，别猜） ---------- */
async function dump(token) {
  const c = await new ServeClient(token).open();
  const created = await c.rpc('session.create', { cols: 80, source: 'serve-probe', cwd: WORKSPACE, close_on_disconnect: true }, 60000);
  const sid = created.session_id;
  log(`sid=${sid}，提交一轮并转储全部事件帧 …`);
  const from = c.events.length;
  let n = 0;
  c.onEvent((f) => {
    n++;
    const t = evType(f);
    const p = evPayload(f);
    if (t === 'message.delta') return;   // delta 太多，单独统计
    console.log(`  [帧 ${n}] type=${t} keys=${Object.keys(p).join(',')}`);
    console.log(`        payload=${JSON.stringify(p).slice(0, 500)}`);
  });
  const done = c.waitEventFrom(from, (f) => evSid(f) === sid && evType(f) === 'message.complete', 300000, 'complete');
  await c.rpc('prompt.submit', { session_id: sid, text: '只回复：ok' }, 60000);
  const cf = await done;
  const deltas = c.events.slice(from).filter((f) => evType(f) === 'message.delta').length;
  console.log(`\nmessage.delta 帧数: ${deltas}`);
  console.log(`message.complete 完整 payload:`);
  console.log(JSON.stringify(evPayload(cf), null, 2));
  c.close();
}

/* ============================ 各场景 ============================ */

/* step1：冷 / 热 / resume 三者的首字与缓存对照
 *
 * 修正后（v2）的做法：
 *   - 用事件水位线切轮，避免匹配到上一轮残留的 message.complete（v1 就是栽在这）
 *   - 缓存数字取自 message.complete 自带的 usage（权威且即时），不再靠轮询 state.db
 *     （DB 落库有滞后，v1 把第 1 轮的 cache_read 记到了第 2 轮头上）
 */
async function step1(token) {
  const A = await new ServeClient(token).open();
  const model = PROBE_MODEL || undefined;
  log('step1: 连接 A，session.create …');
  const created = await A.rpc('session.create', {
    cols: 80, source: 'serve-probe', cwd: WORKSPACE, close_on_disconnect: false,
    ...(model ? { model } : {}),
  }, 60000);
  const sid = created.session_id;
  const storedId = created.stored_session_id;
  log(`  runtime sid = ${sid}`);
  log(`  stored  sid = ${storedId}`);
  log(`  默认模型     = ${(created.info && created.info.model) || '?'}`);

  const r1 = await runTurn(A, sid, '只回复两个字：收到', 'turn1 冷（新会话首轮）');
  log(fmtTurn(r1));
  log(`     usage = ${JSON.stringify(r1.usage)}`);

  const r2 = await runTurn(A, sid, '再说一次，只回复：收到', 'turn2 热（同连接第2轮）');
  log(fmtTurn(r2));
  log(`     usage = ${JSON.stringify(r2.usage)}`);

  // 新连接 + resume（PLAN D2 说这条路会把缓存吃光）
  log('step1: 新开连接 B，session.resume(stored id) …');
  const B = await new ServeClient(token).open();
  let r3;
  try {
    const rs = await B.rpc('session.resume', { session_id: storedId, eager_build: true }, 120000);
    const sid2 = rs.session_id || (rs.info && rs.info.session_id) || storedId;
    log(`  resume 返回 sid = ${sid2}${sid2 === sid ? '（与 A 的 runtime sid 相同 → 复用了活会话）' : '（新 runtime sid → 重建了会话）'}`);
    r3 = await runTurn(B, sid2, '第三次，只回复：收到', 'turn3 续接（新连接B）');
    log(fmtTurn(r3));
    log(`     usage = ${JSON.stringify(r3.usage)}`);
  } catch (e) {
    log(`  resume 失败：${e.message}`);
    r3 = { label: 'turn3 续接（新连接B）', firstDeltaMs: null, totalMs: 0, status: 'ERROR', answer: e.message.slice(0, 40), usage: null };
  } finally { B.close(); }

  A.close();

  const c1 = cacheOf(r1.usage), c2 = cacheOf(r2.usage), c3 = cacheOf(r3.usage);
  const dbRow = sessionUsage(storedId) || {};
  console.log('\n================ step1 结论 ================');
  console.log(`冷（新会话首轮，含 agent build）: ${r1.firstDeltaMs == null ? 'n/a' : (r1.firstDeltaMs / 1000).toFixed(2) + 's'}   cache_read=${c1}`);
  console.log(`热（同连接第 2 轮）            : ${r2.firstDeltaMs == null ? 'n/a' : (r2.firstDeltaMs / 1000).toFixed(2) + 's'}   cache_read=${c2}`);
  console.log(`续接（新连接 resume 后一轮）    : ${r3.firstDeltaMs == null ? 'n/a' : (r3.firstDeltaMs / 1000).toFixed(2) + 's'}   cache_read=${c3}`);
  console.log(`DB 行累计 cache_read_tokens    : ${dbRow.cache_read_tokens}`);
  console.log(`DB 行 system_prompt_hash       : ${dbRow.system_prompt_hash}`);
  const hotFast = r2.firstDeltaMs != null && r2.firstDeltaMs < 3000;
  console.log(`\n热路径 <3s                     : ${hotFast ? '✅' : '❌ 需复查（模型是否被并发抢占？）'}`);
  console.log(`热路径命中缓存（cache_read>0）  : ${c2 > 0 ? '✅' : `❌（${c2}）`}`);
  console.log('说明：turn3 若复用同一 runtime sid，则它不是"重建缓存"而是"复用活会话"，');
  console.log('      此时快是正常的；D2 的结论针对的是「serve 重启后 / 映射丢失后」的重建路径。');
}

/* step1b：resume 一个「serve 里不活着的老会话」—— 这才是用户点历史会话的真实场景
 *
 * 为什么必须单独测：step1 里的 resume 复用了活会话（sid 相同），等于没测重建路径。
 * PLAN D2 的结论（重建后前缀缓存全丢、63.4s）针对的正是这条路径，而它决定了
 * 实现的兜底策略：老会话第一次打开到底要付多大代价。
 */
async function step1b(token) {
  const arg = process.argv[3];
  let storedId = arg;
  if (!storedId) {
    // 挑一个不是本探针造的会话（即 CLI / UI 造的老会话）
    const rows = dbQuery(`select id, source, model, message_count, cache_read_tokens
                          from sessions where source <> 'serve-probe' and message_count > 0
                          order by id desc limit 3`);
    if (!rows.length) { console.error('DB 里没有可用的老会话'); process.exit(1); }
    storedId = rows[0].id;
    console.log('候选老会话:');
    for (const r of rows) console.log(`   ${r.id}  source=${r.source}  msgs=${r.message_count}  cache_read=${r.cache_read_tokens}`);
  }
  log(`step1b: 用新连接 resume 老会话 ${storedId} …`);
  const c = await new ServeClient(token).open();
  const t0 = Date.now();
  let rs;
  try {
    rs = await c.rpc('session.resume', { session_id: storedId, eager_build: true }, 240000);
  } catch (e) {
    console.log(`\nresume 失败：${e.message}`);
    c.close(); return;
  }
  const resumeMs = Date.now() - t0;
  const sid = rs.session_id || (rs.info && rs.info.session_id);
  log(`  resume 耗时 ${(resumeMs / 1000).toFixed(2)}s，返回 runtime sid=${sid}`);
  log(`  返回 info: ${JSON.stringify(rs.info || {}).slice(0, 200)}`);

  let r;
  try {
    r = await runTurn(c, sid, '只回复两个字：收到', 'turn 老会话重建首轮');
    log(fmtTurn(r));
    log(`     usage = ${JSON.stringify(r.usage)}`);
  } catch (e) {
    log(`  提交失败：${e.message}`);
  }
  c.close();

  console.log('\n================ step1b 结论 ================');
  console.log(`resume 调用本身耗时        : ${(resumeMs / 1000).toFixed(2)}s`);
  if (r) {
    console.log(`重建后首字                 : ${r.firstDeltaMs == null ? 'n/a' : (r.firstDeltaMs / 1000).toFixed(2) + 's'}`);
    console.log(`cache_hit_pct              : ${(r.usage && r.usage.cache_hit_pct) != null ? r.usage.cache_hit_pct + '%' : '(无)'}`);
    console.log(`该轮 input tokens          : ${(r.usage && r.usage.input) || '(无)'}`);
  }
  console.log('判读：若首字远大于 1s → 老会话首次打开要付一次冷 prefill（不可消除），');
  console.log('      实现上应当把它当作"首次打开"的合理成本，而不是异常。');
}

/* step2：cwd / model / provider 覆盖 */
async function step2(token) {
  const c = await new ServeClient(token).open();
  log('step2: session.create（显式传 cwd + model + provider）…');
  const created = await c.rpc('session.create', {
    cols: 80, source: 'serve-probe',
    cwd: WORKSPACE,
    ...(PROBE_MODEL ? { model: PROBE_MODEL, provider: 'custom' } : { model: 'hermes-local-gemma4', provider: 'custom' }),
    close_on_disconnect: false,
  }, 60000);
  const sid = created.session_id;
  const storedId = created.stored_session_id;
  log(`  返回 info.model=${(created.info && created.info.model) || '?'}  cwd=${(created.info && created.info.cwd) || '?'}`);
  log(`  branch=${(created.info && created.info.branch) || '?'}`);

  // 提交一轮，逼出 session.info（元数据镜像）并落库
  let info = null;
  const off = c.onEvent((f) => { if (evSid(f) === sid && evType(f) === 'session.info') info = f; });
  try {
    await runTurn(c, sid, '只回复：ok', 'step2 触发轮');
  } catch (e) { log(`  触发轮异常（不致命）：${e.message}`); }
  await sleep(1500);
  off();

  // serve 可能在 create 后立刻发过 session.info，优先用历史里最后一条
  const allInfo = c.events.filter((f) => evSid(f) === sid && evType(f) === 'session.info');
  const lastInfo = allInfo.length ? allInfo[allInfo.length - 1] : info;
  const ip = lastInfo ? evPayload(lastInfo) : {};
  const row = sessionUsage(storedId) || {};
  c.close();

  console.log('\n================ step2 结论 ================');
  console.log(`create.info.model : ${(created.info && created.info.model) || '(空)'}`);
  console.log(`create.info.cwd   : ${(created.info && created.info.cwd) || '(空)'}`);
  console.log(`session.info.model: ${ip.model || '(未收到 session.info)'}`);
  console.log(`session.info.cwd  : ${ip.cwd || ip.workspace || '(无)'}`);
  console.log(`DB 行 model       : ${row.model || '(空)'}`);
  console.log(`DB 行 cwd         : ${row.cwd || '(空)'}`);
  const wantCwd = WORKSPACE;
  const wantModel = PROBE_MODEL || 'hermes-local-gemma4';
  const cwdOk = String(row.cwd || ip.cwd || '').includes(wantCwd) || String(created.info.cwd || '').includes(wantCwd);
  const modelOk = String(row.model || ip.model || created.info.model || '').includes(wantModel.split(':')[0]);
  console.log(`cwd 覆盖落到会话级 : ${cwdOk ? '✅' : '❌'}`);
  console.log(`model 覆盖落到会话级: ${modelOk ? '✅' : '❌'}`);
}

/* step3：会话级 yolo */
async function step3(token) {
  const c = await new ServeClient(token).open();
  log('step3: session.create …');
  const created = await c.rpc('session.create', { cols: 80, source: 'serve-probe', cwd: WORKSPACE, close_on_disconnect: false }, 60000);
  const sid = created.session_id;
  log(`  sid=${sid}`);

  const before = c.events.filter((f) => evSid(f) === sid && evType(f) === 'session.info').pop();
  log(`  config.set 之前 yolo = ${before ? evPayload(before).yolo : '(尚未收到 session.info)'}`);

  log('  发送 config.set {key:"yolo", value:true} …');
  let setResp;
  try {
    setResp = await c.rpc('config.set', { key: 'yolo', value: true, session_id: sid }, 30000);
    log(`  返回: ${JSON.stringify(setResp).slice(0, 200)}`);
  } catch (e) {
    log(`  config.set 失败：${e.message}`);
  }

  // 逼出一次 session.info 回读（提交一轮）
  try { await runTurn(c, sid, '只回复：ok', 'step3 触发轮'); } catch (e) { log(`  触发轮异常（不致命）：${e.message}`); }
  await sleep(1500);

  const infos = c.events.filter((f) => evSid(f) === sid && evType(f) === 'session.info');
  const after = infos.length ? evPayload(infos[infos.length - 1]) : {};
  c.close();

  console.log('\n================ step3 结论 ================');
  console.log(`回读 session.info.yolo      : ${after.yolo}`);
  console.log(`回读 approval_mode          : ${after.approval_mode || '(无字段)'}`);
  console.log(`收到 session.info 条数      : ${infos.length}`);
  console.log(`yolo 生效                   : ${after.yolo === true ? '✅' : '❌（检查 config.set 的 key 名或返回）'}`);
  console.log('注意：yolo 只关掉审批；~/.hermes/hooks 的 pre_tool_call hook 仍然生效（安全底线）。');
}

/* step4：approval.request 触发与应答 */
async function step4(token) {
  const c = await new ServeClient(token).open();
  log('step4: session.create（不开 yolo，让审批浮出来）…');
  const created = await c.rpc('session.create', { cols: 80, source: 'serve-probe', cwd: WORKSPACE, close_on_disconnect: false }, 60000);
  const sid = created.session_id;
  log(`  sid=${sid}`);

  let approvalFrame = null;
  c.onEvent((f) => {
    if (evSid(f) === sid && evType(f) === 'approval.request' && !approvalFrame) {
      approvalFrame = f;
      log(`  ★ 收到 approval.request: ${JSON.stringify(evPayload(f)).slice(0, 300)}`);
    }
  });

  const scenario = '请在终端执行这条命令，不要改写它：rm -rf ~/hermes-probe-should-not-exist-dir';
  log('  提交高危命令场景（预期触发审批）…');
  let completeFrame = null;
  const offDone = c.onEvent((f) => { if (evSid(f) === sid && evType(f) === 'message.complete') completeFrame = f; });
  // 用 rpc 而非 runTurn：这里要自己控审批的时机
  const submit = c.rpc('prompt.submit', { session_id: sid, text: scenario }, 60000).catch((e) => log(`  submit 异常：${e.message}`));

  const deadline = Date.now() + 180000;
  while (!approvalFrame && !completeFrame && Date.now() < deadline) { await sleep(500); }

  let responded = null;
  if (approvalFrame) {
    const p = evPayload(approvalFrame);
    log('  发送 approval.respond {choice:"deny"} …');
    try {
      responded = await c.rpc('approval.respond', {
        session_id: sid, choice: 'deny', all: false, request_id: p.request_id,
      }, 30000);
      log(`  返回: ${JSON.stringify(responded).slice(0, 200)}`);
    } catch (e) { log(`  approval.respond 失败：${e.message}`); }
    // 等等看 turn 能否正常收尾
    const t = Date.now() + 120000;
    while (!completeFrame && Date.now() < t) { await sleep(500); }
  }
  await submit;
  offDone();
  await sleep(500);

  const cp = completeFrame ? evPayload(completeFrame) : {};
  const allTypes = [...new Set(c.events.filter((f) => evSid(f) === sid).map(evType))];
  c.close();

  console.log('\n================ step4 结论 ================');
  console.log(`approval.request 是否触发   : ${approvalFrame ? '✅ 是' : '❌ 否（该命令没被拦，或 hooks 未启用）'}`);
  if (approvalFrame) {
    console.log(`  payload 字段             : ${Object.keys(evPayload(approvalFrame)).join(', ')}`);
    console.log(`approval.respond 是否被接受: ${responded ? '✅' : '❌'}`);
  }
  console.log(`deny 后 turn 是否正常收尾   : ${completeFrame ? `✅ status=${cp.status}` : '❌ 未收到 message.complete（这正是 R3：前端不认识审批 → 静默卡死）'}`);
  console.log(`本轮出现的事件类型          : ${allTypes.join(', ')}`);
}

/* ping：只验证管道 */
async function ping(token) {
  const c = await new ServeClient(token).open();
  log('已连上 WS，发一条 session.create …');
  const created = await c.rpc('session.create', { cols: 80, source: 'serve-probe', cwd: WORKSPACE, close_on_disconnect: true }, 60000);
  console.log(JSON.stringify(created, null, 2).slice(0, 800));
  await sleep(500);
  const types = [...new Set(c.events.map(evType))];
  console.log('已收到的帧类型:', types.join(', ') || '(无)');
  c.close();
}

/* ============================ 入口 ============================ */
(async () => {
  const scenario = process.argv[2] || 'ping';
  const fn = { step1, step1b, step2, step3, step4, ping, dump }[scenario];
  if (!fn) {
    console.error(`未知场景：${scenario}\n可用：step1 | step1b [storedId] | step2 | step3 | step4 | ping | dump`);
    process.exit(2);
  }
  let token;
  try {
    token = await fetchToken();
    log(`token 已获取（${token.slice(0, 8)}…），端口 ${PORT}`);
  } catch (e) {
    console.error(`无法连接 serve（${BASE}）：${e.message}`);
    console.error('提示：先启动 `hermes serve --skip-build --port 9119`；本机需 NO_PROXY=127.0.0.1,localhost。');
    process.exit(1);
  }
  try {
    await fn(token);
  } catch (e) {
    console.error(`\n[探针异常] ${e.stack || e.message}`);
    process.exit(1);
  }
  process.exit(0);
})();
