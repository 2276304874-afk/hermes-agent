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
const CONFIG_PATH = `${HOME}/.hermes/config.yaml`;
/* 为什么是 16：api_server 侧对过短的 key 直接判无效（实测 <16 位握手被拒），
 * 与其让使用者在 chat/stream 处看到一个没头没尾的 401，不如在源头说清。 */
const MIN_KEY_LEN = 16;
let _key = null;

/** 去行内注释：` # ...`（引号内的 # 不算注释） */
function stripInlineComment(s) {
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i);
  }
  return s;
}

/** YAML 标量清洗：去注释 → 去配对引号 → trim */
function cleanScalar(v) {
  let s = stripInlineComment(String(v)).trim();
  if (s.length >= 2) {
    const q = s[0];
    if ((q === '"' || q === "'") && s.endsWith(q)) s = s.slice(1, -1);
  }
  return s.trim();
}

/**
 * 截取 `api_server:` 所在的缩进块（含其后所有缩进更深的兄弟/子行）。
 * 为什么不用一个正则搞定：JS 正则里 `\Z` 不是"串尾"（会被当成字母 Z 的身份转义），
 * 用它写 lookahead 会让整条匹配静默失败、悄悄退化成全文兜底从而抓错 key（单测捕获）。
 * 按缩进逐行扫描，语义直白且可预测。
 */
function apiServerScope(txt) {
  const lines = String(txt).split(/\r?\n/);
  const start = lines.findIndex((l) => /^[\t ]*api_server:[ \t]*(#.*)?$/.test(l));
  if (start === -1) return '';
  const out = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '') { out.push(l); continue; }        // 块内空行继续
    if (!/^[\t ]/.test(l)) break;                          // 缩进回退 = 块结束
    out.push(l);
  }
  return out.join('\n');
}

/**
 * 从 config.yaml 抠出 gateway.platforms.api_server.extra.key。
 * 两级取值：先在 api_server 块内找（避免抓到同文件里别的插件的 key），找不到再全文兜底。
 * 引号值与行内注释都要支持——手工编辑过的配置十有八九带这两个。
 */
function extractKey(txt) {
  const scope = apiServerScope(txt);
  for (const s of [scope, txt]) {
    const m = s && s.match(/^[\t ]*key:[ \t]*(.+?)[ \t]*$/m);
    if (m) { const v = cleanScalar(m[1]); if (v) return v; }
  }
  return '';
}

function gatewayKey() {
  if (_key !== null) return _key;
  let v = (process.env.HERMES_GATEWAY_KEY || '').trim();
  if (!v) {
    try { v = extractKey(fs.readFileSync(CONFIG_PATH, 'utf8')); }
    catch { v = ''; }   // 文件不可读 → 空串，由 describeKey 报原因
  }
  _key = v;
  return _key;
}

/** 仅供测试：丢弃 key 缓存（配置热改后重新解析） */
function resetKeyCache() { _key = null; }

/**
 * key 自检描述。⚠️ 只输出「有没有 / 长度够不够」，绝不回传 key 明文（会进 /api/health JSON）。
 */
function describeKey() {
  const k = gatewayKey();
  if (!k) return { configured: false, reason: '未从 config.yaml 读到 api_server.extra.key（也未设 HERMES_GATEWAY_KEY）' };
  if (k.length < MIN_KEY_LEN) return { configured: false, reason: `key 过短：${k.length} 位 < 要求 ${MIN_KEY_LEN} 位` };
  return { configured: true, length: k.length };
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

/** 面向 /api/health 的结构化健康快照（不含任何 key 明文）。 */
async function gatewayHealth() {
  const enabled = gatewayEnabled();
  const k = describeKey();
  const up = enabled ? await gatewayUp() : false;
  return {
    enabled,
    base: GATEWAY_BASE,
    up,
    keyConfigured: k.configured,
    reason: k.configured
      ? (enabled ? '' : 'HERMES_USE_GATEWAY=0：已强制回退 -z 保底')
      : (k.reason + '（UI 将回退 -z 保底）'),
    checkedAt: Date.now(),
  };
}

/* ---------- 看护进程（T6）：状态跃迁才打日志，不刷屏 ----------
 * 目的不是"把 gateway 拉起来"（那是 launchd 的活），而是：
 *   1) 让运维在一处看到 gateway 是活是死；
 *   2) 状态翻转时留痕——否则 UI 悄悄降级成 -z，使用者只会觉得"怎么变慢了"而不知为何。
 * unref 保证它不拖住进程退出。 */
const _watch = { timer: null, last: null };
function startWatchdog({ intervalMs = Number(process.env.HERMES_GATEWAY_WATCH_MS || 30000) } = {}) {
  if (!gatewayEnabled()) { log('watchdog 未启用：HERMES_USE_GATEWAY=0，全程走 -z 保底'); return null; }
  if (_watch.timer) return _watch.timer;   // 幂等：重复调用不叠多个定时器
  const tick = async () => {
    let up = false;
    try { up = await gatewayUp(); } catch { up = false; }
    const prev = _watch.last;
    if (prev === null) log(`初始探活：${up ? 'gateway 就绪' : 'gateway 不可达 → UI 走 -z 保底'}（${GATEWAY_BASE}）`);
    else if (up !== prev) warn(`gateway 状态跃迁：${prev ? '就绪' : '不可达'} → ${up ? '就绪' : '不可达'}${up ? '' : '，新请求将自动回退 -z 保底'}`);
    _watch.last = up;
  };
  _watch.timer = setInterval(() => { tick().catch(() => { /* 探活失败不影响主链路 */ }); }, intervalMs);
  if (_watch.timer.unref) _watch.timer.unref();
  tick().catch(() => {});
  return _watch.timer;
}
function stopWatchdog() {
  if (_watch.timer) { clearInterval(_watch.timer); _watch.timer = null; }
  _watch.last = null;
}

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

/* ---------- SSE 帧解析器（纯函数式，可脱离网络单测） ----------
 * 三件事必须做对，否则线上会出很隐蔽的故障：
 *   1) 行终结符不能只认 \n —— 服务端一旦用 CRLF，行尾残留 \r 会让"空行炸帧"永远不成立，
 *      整条流一帧都吐不出来（表现为 UI 永久转圈）。故 LF / CRLF / CR 全支持。
 *   2) 多行 data 要按 SSE 规范用 \n 连接，而不是简单拼接。
 *   3) 一个 chunk 可能含多帧（粘包），也可能半帧（一个 UTF-8 汉字被切成两半）：
 *      前者靠循环取帧处理，后者靠 TextDecoder({stream:true}) 在调用侧保证字节完整。
 */
function createSSEParser() {
  const LINE_RE = /\r\n|\r|\n/;
  let buf = '', name = '', data = '';
  const takeLine = (line) => {
    if (line.startsWith('event:')) { name = line.slice(6).trim(); return; }
    if (line.startsWith('data:')) {
      const piece = line.slice(5).trim();
      data = data ? data + '\n' + piece : piece;
      return;
    }
    // id: / retry: / :心跳注释 → 忽略（心跳注释不携带业务语义）
  };
  const settle = (out) => {
    const n = name, d = data;
    name = ''; data = '';
    if (n) out.push({ name: n, data: d });
  };
  return {
    /** push 一段文本，返回其中已完整的帧 [{name, data}] */
    push(chunk) {
      const out = [];
      buf += chunk;
      let m;
      while ((m = LINE_RE.exec(buf))) {
        const line = buf.slice(0, m.index);
        buf = buf.slice(m.index + m[0].length);
        if (line === '') { settle(out); continue; }   // 空行 = 一帧结束
        takeLine(line);
      }
      return out;
    },
    /** 流结束：处理没以空行收尾的残帧 */
    flush() {
      const out = [];
      if (buf.trim()) takeLine(buf.trim());
      buf = '';
      settle(out);
      return out;
    },
  };
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
    const parser = createSSEParser();
    const handle = (frames) => {
      for (const { name, data } of frames) {
        let obj = null;
        try { obj = data ? JSON.parse(data) : {}; } catch { continue; }   // 坏帧跳过，不中断整条流
        if (name === 'assistant.delta') {
          const d = obj && obj.delta;
          if (d) onToken && onToken(d);
        } else if (name === 'done') {
          onDone && onDone({});
        } else if (name === 'error') {
          onError && onError((obj && obj.message) || 'gateway error');
        }
        // run.completed / tool.* 等忽略（DB 轮询权威呈现）
      }
    };
    for (;;) {
      const { value, done: eof } = await reader.read();
      if (eof) break;
      armIdle();   // 有字节到达 → 看门狗续期
      handle(parser.push(decoder.decode(value, { stream: true })));
    }
    handle(parser.flush());   // 尾部可能残留未以空行结尾的帧
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
  GATEWAY_BASE, GATEWAY_V1, MIN_KEY_LEN,
  gatewayEnabled, gatewayUp, gatewayHealth, createSession, chatStream,
  gatewayKey, describeKey, resetKeyCache, createSSEParser,
  startWatchdog, stopWatchdog,
  // 内部实现导出仅为单测服务（extractKey / cleanScalar 是纯函数，不碰文件系统）
  _internal: { extractKey, cleanScalar, stripInlineComment, apiServerScope },
};
