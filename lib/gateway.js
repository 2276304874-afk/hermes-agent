'use strict';
/* =============================================================================
 * lib/gateway.js —— hermes gateway 常驻后端客户端（选项 B 的聊天后端）
 *
 * 为什么是 gateway 而不是 serve：serve 启动时**不注册** pre_tool_call 安全 hook
 * （hermes 源码 main.py:2732 对 serve 提前 return，web_server_sessions.py:205 明示
 * "serve runs neither CLI nor gateway startup hooks"），切过去会静默关掉高危命令拦截。
 * gateway run 会在 run_startup.py:831 注册该 hook（已实测 rm -rf 被拦截），且同样是
 * 常驻进程、单进程多会话复用、首回合之后全热。详见评估记录。
 *
 * 线协议：gateway 内置 OpenAI 兼容 HTTP API（gateway/platforms/api_server.py）。
 *   - 建会话：POST /api/sessions            → { session: { id: "api-xxxx" } }
 *   - 流式对话：POST /api/sessions/{id}/chat/stream  （Hermes 原生 SSE，带 tool/审批事件）
 *   - 鉴权：Bearer API_SERVER_KEY（config.yaml gateway.platforms.api_server.extra.key）
 *   - 绑定：默认 127.0.0.1:8642（loopback）
 *
 * 双通道复用 -z 的设计：
 *   - 真流式文本：来自 /chat/stream 的 `assistant.delta` 事件 → SSE `token`
 *   - 权威消息（含 tool 调用 / reasoning）：来自 state.db 轮询（gateway 把 api-* 会话
 *     的 messages 写入 state.db，列与 newMessages() 完全一致，已验证）
 *
 * ⚠️ 安全边界（R2）：8642 只从本 Node 进程发起（无任何 Origin 头 → gateway 放行）；
 *   api_server 的 CORS 是 origin-gated（未知源返回 403），浏览器从其他源直连会被拒。
 *   绝不把 8642 暴露给浏览器直连，放行信号一律走文件（lib/safety.js），不用 env。
 * ========================================================================== */

const fs = require('fs');
const { HOME, DEFAULT_MODEL } = require('./config');

const GATEWAY_BASE = (process.env.HERMES_GATEWAY_URL || 'http://127.0.0.1:8642').replace(/\/$/, '');
const GATEWAY_V1 = `${GATEWAY_BASE}/v1`;

/* ---------- key：config.yaml 为单一真源（缓存于模块加载期） ---------- */
let _key = null;
function gatewayKey() {
  if (_key !== null) return _key;
  if (process.env.HERMES_GATEWAY_KEY) { _key = process.env.HERMES_GATEWAY_KEY; return _key; }
  try {
    const txt = fs.readFileSync(`${HOME}/.hermes/config.yaml`, 'utf8');
    const m = txt.match(/gateway:[\s\S]*?api_server:[\s\S]*?extra:[\s\S]*?key:\s*(\S+)/);
    _key = m ? m[1] : '';
  } catch { _key = ''; }
  return _key;
}

function authHeaders(extra = {}) {
  const h = { 'Content-Type': 'application/json', ...extra };
  const k = gatewayKey();
  if (k) h.Authorization = 'Bearer ' + k;
  return h;
}

const log = (...a) => console.log('[gateway]', ...a);
const warn = (...a) => console.warn('[gateway]', ...a);

/* ---------- 可用性（短缓存，避免每请求一次 health 探测） ---------- */
let _upCache = { at: 0, val: false };
async function gatewayUp() {
  const now = Date.now();
  if (now - _upCache.at < 2000) return _upCache.val;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const r = await fetch(`${GATEWAY_BASE}/health`, { signal: ctrl.signal, headers: authHeaders() });
    clearTimeout(t);
    _upCache = { at: now, val: r.ok };
    return r.ok;
  } catch { _upCache = { at: now, val: false }; return false; }
}

/** 是否启用 gateway 路径（默认开；HERMES_USE_GATEWAY=0 回退 -z）。 */
function gatewayEnabled() { return process.env.HERMES_USE_GATEWAY !== '0'; }

/* ---------- 建会话 ---------- */
async function createSession({ title, model } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(`${GATEWAY_BASE}/api/sessions`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: authHeaders(),
      body: JSON.stringify({ title: title || 'Hermes UI', model: model || DEFAULT_MODEL, source: 'hermes-ui' }),
    });
    if (!r.ok) {
      // 必须带响应体片段：400 invalid_title（"Title already in use"，gateway 强制标题唯一）
      // 这类业务错误没有 body 根本查不动（排查实录：UI 路径只见 400，body 才见真因）
      const txt = await r.text().catch(() => '');
      throw new Error(`POST /api/sessions -> HTTP ${r.status} ${txt.slice(0, 200)}`);
    }
    const j = await r.json();
    const id = j && j.session && j.session.id;
    if (!id) throw new Error('createSession 未返回 session.id');
    return id;
  } finally { clearTimeout(t); }
}

/* ---------- 流式对话 ----------
 * 解析 Hermes 原生 SSE（event: <name>\ndata: <json>），回调：
 *   onToken(text)         assistant.delta
 *   onDone({sessionId})   done
 *   onError(message)      error / 异常
 * 返回 Promise，在 done 或 error 时 resolve；调用方可传 signal 中断（→ gateway 自动 abort 该 run）。
 * tool.started/completed/progress 不在此转发 —— 它们由 state.db 轮询以 `msg` 事件权威呈现，
 * 避免与 DB 行重复。reasoning 同样由 DB messages.reasoning 列承载。
 *
 * E: 空闲看门狗 —— agent 卡死时不能让这条连接与 UI 轮询永久挂起（active 泄漏）。
 * 用「空闲超时」而非「总时长超时」：长 agent run 期间事件持续到达会不断续期，
 * 只有真正无输出的挂起（默认 5 分钟，HERMES_STREAM_IDLE_MIN 可覆盖）才触发 abort。
 * 看门狗触发的 abort 以 error 收尾（区别于外部 signal 的 aborted 正常收尾）。 */
function chatStream(sessionId, message, { signal, onToken, onDone, onError } = {}) {
  const url = `${GATEWAY_BASE}/api/sessions/${encodeURIComponent(sessionId)}/chat/stream`;
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });

  const IDLE_MS = Number(process.env.HERMES_STREAM_IDLE_MIN || 5) * 60 * 1000;
  let idleTimer = null, idleFired = false;
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { idleFired = true; try { ac.abort(); } catch { /* 已结束 */ } }, IDLE_MS);
  };
  armIdle();   // fetch 建连阶段也受看门狗保护（gateway 假死时不会无限等响应头）

  const p = fetch(url, {
    method: 'POST',
    signal: ac.signal,
    headers: authHeaders(),
    body: JSON.stringify({ message }),
  }).then(async (r) => {
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw new Error(`POST chat/stream -> HTTP ${r.status} ${txt.slice(0, 200)}`);
    }
    if (!r.body || typeof r.body.getReader !== 'function') throw new Error('响应非流式');
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let evtName = '';
    let evtData = '';
    const dispatch = () => {
      const name = evtName, data = evtData;
      evtName = ''; evtData = '';
      if (!name) return;
      let obj = null;
      try { obj = data ? JSON.parse(data) : {}; } catch { return; }
      if (name === 'assistant.delta') {
        const d = obj && obj.delta;
        if (d) onToken && onToken(d);
      } else if (name === 'done') {
        onDone && onDone({});
      } else if (name === 'error') {
        onError && onError((obj && obj.message) || 'gateway error');
      }
      // run.completed / tool.* 等忽略（DB 轮询权威呈现）
    };
    for (;;) {
      const { value, done: eof } = await reader.read();
      if (eof) break;
      armIdle();   // 有字节到达 → 看门狗续期
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line === '') { dispatch(); continue; }       // 空行 = 一帧结束
        if (line.startsWith('event:')) evtName = line.slice(6).trim();
        else if (line.startsWith('data:')) evtData += line.slice(5).trim();
        // 其它头（id:/retry:）忽略
      }
    }
    // 尾部可能残留未以空行结尾的帧
    if (evtName || evtData) dispatch();
  });

  return p.catch((e) => {
    if (e.name === 'AbortError') {
      if (idleFired) { onError && onError(`gateway 流空闲超时（>${Math.round(IDLE_MS / 60000)} 分钟无输出），已中断本轮`); return; }
      onDone && onDone({ aborted: true }); return;
    }
    onError && onError(e.message || String(e));
  }).finally(() => {
    if (idleTimer) clearTimeout(idleTimer);
    if (signal) signal.removeEventListener('abort', onAbort);
  });
}

module.exports = {
  GATEWAY_BASE, GATEWAY_V1,
  gatewayEnabled, gatewayUp, createSession, chatStream, gatewayKey,
};
