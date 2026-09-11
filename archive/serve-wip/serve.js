'use strict';
/* =============================================================================
 * lib/serve.js —— `hermes serve` 常驻后端客户端（P7-5）
 *
 * 为什么存在：现状每轮对话 spawn 一次 `hermes -z`，冷启动约 25.7s。
 * `hermes serve` 是常驻的 JSON-RPC over WebSocket 后端，把这段冷启动摊掉。
 *
 * ⚠️ 三条架构约束，每条都有实测数字支撑（scripts/serve-probe.js 可复现）：
 *
 *   1. **进程级唯一一条共享 WS**，绝不每请求开新连接。
 *      实测：换新连接的同一活会话首字 23.3s；共享连接同会话第 2 轮 0.67s。差 35 倍。
 *      根因在 serve 侧：流式输出绑定在"当前 transport"上，重新绑定要付代价。
 *
 *   2. **session 长期挂在 serve 进程里**，复用而不重建。
 *      实测：resume 一个 serve 里不活着的老会话 → 首字 92.85s（前缀缓存全丢）；
 *      而 resume 调用本身只要 0.09s。所以"能不能续"不是问题，"续了之后多贵"才是。
 *      因此这里维护 stored id ↔ runtime sid 的映射，命中即直接用。
 *
 *   3. **runtime sid 会随 serve 重启失效**，所以映射带 generation 代次；
 *      代次不匹配就当作未命中，重新 resume（接受一次冷代价）。
 *
 * 降级：serve 起不来 / WS 连不上 / RPC 失败 → 由调用方（chat 路由）回退 `-z` 路径。
 * 本模块只负责"可用就快"，不负责"不可用怎么办"。
 * ========================================================================== */

const fs = require('fs');
const net = require('net');
const { spawn } = require('child_process');
const { HERMES, HOME } = require('./config');
const { hermesEnv } = require('./hermes');

const SERVE_PORT = Number(process.env.HERMES_SERVE_PORT || 9119);
const SERVE_HOST = '127.0.0.1';
const BASE = `http://${SERVE_HOST}:${SERVE_PORT}`;
const WS_URL = `ws://${SERVE_HOST}:${SERVE_PORT}/api/ws`;
// R8: 会话级放行文件（hook 读它）。见 hooks/safety_check.py 头部说明。
const BYPASS_FILE = `${HOME}/.hermes/ui_bypass_sessions.json`;
// 放行有效期：用户点"允许危险操作"后重跑的那一轮足够用，不做长期免检。
const BYPASS_TTL_MS = Number(process.env.HERMES_BYPASS_TTL_MIN || 15) * 60 * 1000;

const log = (...a) => console.log('[serve]', ...a);
const warn = (...a) => console.warn('[serve]', ...a);

/* ============================ 端口探测 ============================ */
function portOpen(port = SERVE_PORT, timeoutMs = 800) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: SERVE_HOST });
    let done = false;
    const finish = (v) => { if (done) return; done = true; try { sock.destroy(); } catch { /* 已关 */ } resolve(v); };
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => finish(true));
    sock.on('timeout', () => finish(false));
    sock.on('error', () => finish(false));
  });
}

/* ============================ token ============================ */
let cachedToken = null;
let tokenFetchedAt = 0;

/** serve 的 WS 认证 token 印在首页 HTML 里（window.__HERMES_SESSION_TOKEN__）。
 *  serve 重启后会变，故缓存带过期与强制刷新。 */
async function getToken(force = false) {
  if (!force && cachedToken && Date.now() - tokenFetchedAt < 60000) return cachedToken;
  const r = await fetch(`${BASE}/`);
  const html = await r.text();
  const m = html.match(/__HERMES_SESSION_TOKEN__="([^"]+)"/);
  if (!m) throw new Error(`serve 首页未找到 token（HTTP ${r.status}）`);
  cachedToken = m[1];
  tokenFetchedAt = Date.now();
  return cachedToken;
}

/* ============================ 拉起 serve ============================ */
let serveChild = null;
let weSpawned = false;
let ensurePromise = null;

/** 确保 9119 后端在跑。
 *  - 已在跑（用户手动起的 / 上次留下的）→ 复用，**不接管生命周期**（不 kill）
 *  - 没在跑 → spawn 一个，记录 PID，本进程退出时清理
 *  幂等：并发调用共享同一个 Promise。 */
function ensureServe() {
  if (ensurePromise) return ensurePromise;
  ensurePromise = (async () => {
    if (await portOpen()) {
      log(`后端已在 ${SERVE_HOST}:${SERVE_PORT} 运行，复用（不接管生命周期）`);
      return { ok: true, reused: true, pid: null };
    }
    log(`拉起 hermes serve --skip-build --port ${SERVE_PORT} …`);
    // 注意：serve 常驻，env 在 spawn 时固定 —— 所以这里**不能**注入
    // HERMES_UI_BYPASS_SAFETY（那等于永久关闭安全拦截）。放行走会话级文件（见 approveSession）。
    serveChild = spawn(HERMES, ['serve', '--skip-build', '--port', String(SERVE_PORT)], {
      env: hermesEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    weSpawned = true;
    serveChild.stdout.on('data', (d) => { const s = String(d).trim(); if (s) log(s.slice(0, 200)); });
    serveChild.stderr.on('data', (d) => { const s = String(d).trim(); if (s) warn(s.slice(0, 200)); });
    serveChild.on('exit', (code, sig) => {
      warn(`serve 子进程退出 code=${code} sig=${sig}（下次请求会尝试重新拉起）`);
      serveChild = null;
      ensurePromise = null;
      resetClient('serve 进程退出');
    });
    // 等端口起来（后端 ready 通常 <12s）
    const deadline = Date.now() + 40000;
    while (Date.now() < deadline) {
      if (await portOpen(500)) { log('后端就绪 ✅'); return { ok: true, reused: false, pid: serveChild && serveChild.pid }; }
      await new Promise((r) => setTimeout(r, 500));
    }
    warn('后端在规定时间内未就绪');
    return { ok: false, reused: false, reason: 'serve 启动超时' };
  })().catch((e) => {
    warn(`拉起失败：${e.message}`);
    ensurePromise = null;
    return { ok: false, reused: false, reason: e.message };
  });
  return ensurePromise;
}

/** 只清理"我们自己拉起的"后端。用户手动起的不能被我们杀掉。 */
function shutdown() {
  if (weSpawned && serveChild) {
    try { serveChild.kill('SIGTERM'); log('已停止自身拉起的 serve'); } catch { /* 已退出 */ }
  }
}

/* ============================ 共享 WS 客户端 ============================ */
class ServeClient {
  constructor(queue = []) {
    this.ws = null;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Set();       // (frame) => void
    this.downListeners = new Set();   // (reason) => void
    this.generation = 0;              // 每建立一次连接 +1：用来作废旧的 runtime sid 映射
    this.closed = true;
  }

  /** 建立连接（含 token 获取）。失败抛错。 */
  async connect(timeoutMs = 15000) {
    const token = await getToken(true);
    await new Promise((resolve, reject) => {
      // Node 内置 WebSocket 不发 Origin 头；serve 侧对"无 Origin"是放行的（已核实）
      const ws = new WebSocket(`${WS_URL}?token=${encodeURIComponent(token)}`);
      this.ws = ws;
      const timer = setTimeout(() => { try { ws.close(); } catch { /* 忽略 */ } reject(new Error('WS 连接超时')); }, timeoutMs);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('WS 连接错误')); }, { once: true });
    });

    this.generation += 1;
    this.closed = false;

    this.ws.addEventListener('message', (ev) => {
      const raw = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8');
      let obj;
      try { obj = JSON.parse(raw); } catch { return; }
      if (obj.method === 'event') {
        for (const fn of this.listeners) { try { fn(obj); } catch (e) { warn(`事件监听器抛错：${e.message}`); } }
        return;
      }
      if (obj.id != null && this.pending.has(obj.id)) {
        const p = this.pending.get(obj.id);
        this.pending.delete(obj.id);
        clearTimeout(p.timer);
        if (obj.error) p.reject(new Error(`RPC ${p.method}: ${JSON.stringify(obj.error)}`));
        else p.resolve(obj.result);
      }
    });

    this.ws.addEventListener('close', () => {
      this.closed = true;
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('WS 已关闭')); }
      this.pending.clear();
      for (const fn of this.downListeners) { try { fn('WS 关闭'); } catch { /* 忽略 */ } }
    });

    await new Promise((r) => setTimeout(r, 200));   // 排掉 gateway.ready
    return this;
  }

  rpc(method, params = {}, timeoutMs = 60000) {
    if (this.closed || !this.ws) return Promise.reject(new Error('serve 连接不可用'));
    const id = `s${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC ${method} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  onEvent(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  onDown(fn) { this.downListeners.add(fn); return () => this.downListeners.delete(fn); }

  close() {
    this.closed = true;
    try { this.ws && this.ws.close(); } catch { /* 已关 */ }
  }
}

/* ============================ 单例 + 会话映射 ============================ */
let client = null;
let connectPromise = null;
/** stored id -> { sid: runtime sid, gen: 连接代次 } */
const liveSessions = new Map();

function resetClient(reason) {
  if (client) { try { client.close(); } catch { /* 忽略 */ } }
  client = null;
  connectPromise = null;
  liveSessions.clear();     // runtime sid 随连接失效，映射整体作废
  if (reason) warn(`连接重置：${reason}`);
}

/** 拿到可用连接（不存在则建立）。失败返回 null —— 调用方据此回退。 */
async function ensureClient() {
  if (client && !client.closed) return client;
  if (connectPromise) return connectPromise;
  connectPromise = (async () => {
    if (typeof WebSocket === 'undefined') throw new Error('当前 Node 无内置 WebSocket（需 Node 21+）');
    const ensured = await ensureServe();
    if (!ensured.ok) throw new Error(ensured.reason || 'serve 不可用');
    const c = new ServeClient();
    c.onDown((r) => { if (client === c) resetClient(r); });
    await c.connect();
    client = c;
    log(`已连接共享 WS（代次 ${c.generation}）`);
    return c;
  })().catch((e) => {
    warn(`连接失败：${e.message}（本轮将回退 -z 路径）`);
    connectPromise = null;
    return null;
  });
  return connectPromise;
}

/** 当前是否可用（供健康检查/路由分支用，不发起连接） */
function available() { return !!(client && !client.closed); }

/* ---------- 会话建立 / 复用 ---------- */

/** 新会话：session.create。返回 stored id（DB 里的会话 id，前端与 DB 轮询都用它）。 */
async function createSession({ cwd, model, provider, title, allowDangerous } = {}) {
  const c = await ensureClient();
  if (!c) throw new Error('serve 不可用');
  const params = { cols: 80, source: 'hermes-ui', cwd, close_on_disconnect: false };
  if (model) params.model = model;
  if (provider) params.provider = provider;
  if (title) params.title = title;
  const r = await c.rpc('session.create', params, 60000);
  const storedId = r.stored_session_id;
  const runtimeSid = r.session_id;
  if (!storedId || !runtimeSid) throw new Error('session.create 返回缺少 session_id');
  liveSessions.set(storedId, { sid: runtimeSid, gen: c.generation });
  // D4: 会话级 yolo（关掉 Hermes 自身的审批弹窗）。
  // 注意：yolo **不**绕过我们自己的 pre_tool_call hook —— 那条线由 approveSession 负责。
  if (allowDangerous) {
    try { await c.rpc('config.set', { key: 'yolo', value: true, session_id: runtimeSid }, 20000); }
    catch (e) { warn(`config.set yolo 失败（不影响本轮）：${e.message}`); }
    approveSession(storedId);
  }
  log(`新建会话 stored=${storedId} runtime=${runtimeSid}`);
  return { storedId, runtimeSid, info: r.info || {} };
}

/** 已有会话：命中内存映射即复用（快）；否则 resume（首次打开要付一次冷 prefill，实测可达 ~93s）。 */
async function resolveSession(storedId, { allowDangerous } = {}) {
  const c = await ensureClient();
  if (!c) throw new Error('serve 不可用');
  const hit = liveSessions.get(storedId);
  if (hit && hit.gen === c.generation) {
    if (allowDangerous) { approveSession(storedId); }
    return { runtimeSid: hit.sid, storedId, reused: true };
  }
  const r = await c.rpc('session.resume', { session_id: storedId, eager_build: true }, 300000);
  const runtimeSid = r.session_id || (r.info && r.info.session_id);
  if (!runtimeSid) throw new Error('session.resume 未返回 session_id');
  liveSessions.set(storedId, { sid: runtimeSid, gen: c.generation });
  if (allowDangerous) {
    try { await c.rpc('config.set', { key: 'yolo', value: true, session_id: runtimeSid }, 20000); }
    catch (e) { warn(`config.set yolo 失败（不影响本轮）：${e.message}`); }
    approveSession(storedId);
  }
  log(`复用会话 stored=${storedId} runtime=${runtimeSid}`);
  return { runtimeSid, storedId, reused: false, info: r.info || {} };
}

/* ---------- 提交 / 中断 / 订阅 ---------- */
async function submit(runtimeSid, text) {
  const c = await ensureClient();
  if (!c) throw new Error('serve 不可用');
  return c.rpc('prompt.submit', { session_id: runtimeSid, text }, 60000);
}

async function interrupt(runtimeSid) {
  if (!client || client.closed) return false;
  try { await client.rpc('session.interrupt', { session_id: runtimeSid }, 15000); return true; }
  catch (e) { warn(`interrupt 失败：${e.message}`); return false; }
}

/** 订阅某个 runtime 会话的事件流。返回取消函数。 */
function subscribe(runtimeSid, fn) {
  if (!client) return () => {};
  return client.onEvent((frame) => {
    const p = frame.params || {};
    if (p.session_id === runtimeSid) fn(p);
  });
}

/** 自动应答审批：R3 兜底。
 *  前端不认识 approval.request，若不管它会一直等 → 表现为"危险命令静默卡死"。
 *  所以后端统一拒绝并告知用户。 */
async function denyApproval(runtimeSid, requestId) {
  if (!client || client.closed) return false;
  try {
    await client.rpc('approval.respond', { session_id: runtimeSid, choice: 'deny', all: false, request_id: requestId }, 20000);
    return true;
  } catch (e) { warn(`approval.respond 失败：${e.message}`); return false; }
}

/* ============================ 会话级放行（R8） ============================ */
/** 把某个会话标记为"用户已批准危险操作"。
 *  为什么不是 env：serve 常驻，env 在 spawn 时固定；常开 bypass 等于永久关闭安全拦截。
 *  为什么带 TTL：把「本次请求放行」的语义尽量贴近原实现，避免一次批准变成永久免检。 */
function approveSession(storedId, ttlMs = BYPASS_TTL_MS) {
  try {
    let data = { sessions: {} };
    try { data = JSON.parse(fs.readFileSync(BYPASS_FILE, 'utf8')) || data; } catch { /* 首次写入 / 文件损坏 → 重建 */ }
    const nowSec = Math.floor(Date.now() / 1000);
    const sessions = {};
    // 顺手清掉过期条目，文件不会无限膨胀
    for (const [k, v] of Object.entries(data.sessions || {})) if (Number(v) > nowSec) sessions[k] = v;
    // ⚠️ 单位必须是**秒**：hook 侧用 python time.time()（秒）比较。
    //    写成毫秒会让过期时间变成公元 5 万年后 —— 放行永久生效，且过期清理永不触发。
    sessions[storedId] = nowSec + Math.round(ttlMs / 1000);
    fs.writeFileSync(BYPASS_FILE, JSON.stringify({ sessions }, null, 0), { mode: 0o600 });
    log(`会话 ${storedId} 已获危险操作放行，有效期 ${Math.round(ttlMs / 60000)} 分钟`);
    return true;
  } catch (e) {
    warn(`写入放行文件失败（高危命令仍会被拦截）：${e.message}`);
    return false;
  }
}

module.exports = {
  SERVE_PORT,
  ensureServe,
  ensureClient,
  available,
  createSession,
  resolveSession,
  submit,
  interrupt,
  subscribe,
  denyApproval,
  approveSession,
  liveSessions,
  shutdown,
  _internal: { ServeClient, portOpen, getToken, resetClient, BYPASS_FILE, BYPASS_TTL_MS },
};
