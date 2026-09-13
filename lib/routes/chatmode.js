'use strict';
/*
 * lib/routes/chatmode.js —— 「对话模式」路由（侧栏 对话/工作 分段开关的对话侧）。
 *
 * 与工作模式的差异：绕过 Hermes 引擎（gateway/-z），直连 Ollama /api/chat 流式——
 * 没有引擎的 system prompt / 工具定义 / KB 召回 / autonomy 前导，prefill 只有
 * 一小段人设 + 最近 CHAT_HISTORY_MAX 条消息，首字延迟从 ~18s 降到 ~1-2s。
 * 无工具：模型拿不到 terminal/write_file，闲聊模式天然安全，无需 safety hook。
 *
 * SSE 事件契约与 lib/routes/chat.js 完全一致（ready/session/token/msg/done/error），
 * 前端 handleFrame 无需区分后端。
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const { HOME, OLLAMA, CHAT_MODEL, CHAT_HISTORY_MAX, CHAT_HISTORY_BUDGET, KEEP_ALIVE, PROMPT_LIMIT } = require('../config');
const { sendJSON, sse, readBody } = require('../http');
const { active } = require('../state');
const { recallContext } = require('../knowledge');
const store = require('../chatstore');

/* KB 召回开关：标记文件存在 = 对话模式启用轻量知识库召回（默认关）。
 * 开启方式：touch ~/.hermes/chat_kb_recall.on；关闭：删除该文件。 */
const KB_RECALL_FLAG = `${HOME}/.hermes/chat_kb_recall.on`;

const CHAT_SYSTEM =
  '你是赫尔墨斯，用户的日常对话伙伴。用简体中文回答，口语化、简洁友好。' +
  '你没有工具可用，不要尝试调用工具或执行任何操作。' +
  '除非用户要求详细展开，回答保持简短。';

/* SSE 响应头（与 chat.js sseOpen 一致；独立一份避免两条路径互相牵连） */
function sseOpen(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('retry: 3000\n\n');
}

/* ---------- 会话管理（对话模式独立存储，与引擎会话天然分列） ---------- */
function register(router) {

  router.add('GET', '/api/chat/sessions', (req, res) => {
    return sendJSON(res, 200, { sessions: store.list() });
  });

  router.add('GET', '/api/chat/history', (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const sid = (u.searchParams.get('session') || '').trim();
    const msgs = store.history(sid);
    if (!msgs) return sendJSON(res, 404, { error: 'session not found' });
    return sendJSON(res, 200, { sessionId: sid, messages: msgs });
  });

  router.add('POST', '/api/chat/session/rename', async (req, res) => {
    const b = JSON.parse(await readBody(req) || '{}');
    const title = String(b.title || '').trim();
    if (!store.ID_RE.test(String(b.id || ''))) return sendJSON(res, 400, { error: 'bad session id' });
    if (!title || title.length > 80) return sendJSON(res, 400, { error: '标题需 1-80 字符' });
    const ok = store.rename(b.id, title);
    return sendJSON(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'session not found' });
  });

  router.add('POST', '/api/chat/session/delete', async (req, res) => {
    const b = JSON.parse(await readBody(req) || '{}');
    if (!store.ID_RE.test(String(b.id || ''))) return sendJSON(res, 400, { error: 'bad session id' });
    const ok = store.remove(b.id);
    return sendJSON(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'session not found' });
  });
}

/* ---------- 直连 Ollama 的对话流（/api/chat 带 mode:'chat' 时进入） ---------- */
async function handleChatDirect(req, res, body) {
  // 与工作模式同规则切片（PROMPT_LIMIT=8000）：对话模型 num_ctx=8192，
  // 不切片的超长 prompt 会把上下文撑爆——实测 9000 字符跑了 34s 且尾部被截。
  let prompt = (body.prompt || '').trim();
  if (prompt.length > PROMPT_LIMIT) {
    prompt = prompt.slice(0, PROMPT_LIMIT) + '…（超长部分已截断，完整内容请用工作模式处理）';
  }
  const runId = crypto.randomUUID();

  sseOpen(res);
  sse(res, 'ready', { runId, sessionId: null, allowDangerous: false, model: CHAT_MODEL, cloud: false, backend: 'chat-direct' });

  // 会话：新对话落 chatstore（标题取自首条 prompt），续聊校验存在性
  let sessionId = body.sessionId || null;
  if (sessionId && !store.get(sessionId)) sessionId = null;   // 坏/已删 id → 当作新对话，不 500
  if (!sessionId) {
    sessionId = store.create(prompt).id;
    sse(res, 'session', { sessionId });
  }

  // 落盘用户消息 → 组装窗口消息（人设 + 最近若干轮）。
  // 条数上限之外还有字符预算：20 条长消息理论上可到 16 万字符，8k ctx 照样爆。
  // 超预算时从最旧的一侧丢弃，本轮 prompt 永远保留且必须位于末尾。
  store.appendMessage(sessionId, 'user', prompt);

  // 可选 KB 召回（v0.4-#8）：标记文件 ~/.hermes/chat_kb_recall.on 存在时，
  // 把知识库召回的相关经验并入 system（默认关——保住对话模式 0.2~0.4s 首字基线）。
  let systemContent = CHAT_SYSTEM;
  if (fs.existsSync(KB_RECALL_FLAG)) {
    try {
      const recall = await recallContext(prompt);
      if (recall) systemContent += '\n\n' + recall;
    } catch (e) { /* 召回失败静默降级：闲聊不该被 KB 故障拖垮 */ }
  }

  const hist = store.history(sessionId);
  const window = [hist[hist.length - 1]];          // 最后一条 = 本轮 prompt，必带
  let used = prompt.length;
  for (let i = hist.length - 2; i >= 0 && window.length < CHAT_HISTORY_MAX; i--) {
    const len = hist[i].content.length;
    if (used + len > CHAT_HISTORY_BUDGET) break;
    window.unshift(hist[i]);
    used += len;
  }
  const messages = [{ role: 'system', content: systemContent },
    ...window.map(m => ({ role: m.role, content: m.content }))];

  // 中断：/api/stop 与客户端断开都会 abort 到 Ollama 的请求（与 gateway fakeChild 同型）
  const controller = new AbortController();
  const fakeChild = { kill: () => { try { controller.abort(); } catch (e) { /* 已结束 */ } } };
  active.set(runId, fakeChild);
  active.set(sessionId, fakeChild);
  req.on('close', () => { try { controller.abort(); } catch (e) { /* 已断开 */ } });

  const t0 = Date.now();
  let firstTokenMs = null;
  let answer = '';

  const finish = (ok, errMsg) => {
    active.delete(runId);
    active.delete(sessionId);
    if (ok) {
      store.appendMessage(sessionId, 'assistant', answer);
      sse(res, 'msg', { id: 0, role: 'assistant', toolName: null, content: answer, toolCalls: null, displayKind: null, reasoning: null, ts: Date.now() });
      sse(res, 'done', { elapsed: String((Date.now() - t0) / 1000), sessionId, firstTokenMs: firstTokenMs == null ? null : String(firstTokenMs / 1000), backend: 'chat-direct' });
    } else {
      sse(res, 'error', { message: errMsg || '对话模式请求失败' });
    }
    try { res.end(); } catch (e) { /* 已结束 */ }
  };

  const payload = JSON.stringify({
    model: CHAT_MODEL, messages, stream: true, keep_alive: KEEP_ALIVE,
    think: false, options: { temperature: 0.7 },
  });
  const r = http.request(OLLAMA + '/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    signal: controller.signal,
  }, (up) => {
    if (up.statusCode !== 200) {
      let buf = '';
      up.on('data', d => buf += d);
      up.on('end', () => finish(false, `Ollama 返回 ${up.statusCode}: ${buf.slice(0, 160)}`));
      return;
    }
    let buf = '';
    up.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        let obj; try { obj = JSON.parse(line); } catch (e) { continue; }
        const piece = (obj.message || {}).content || '';
        if (piece) {
          if (firstTokenMs === null) firstTokenMs = Date.now() - t0;
          answer += piece;
          sse(res, 'token', { text: piece });
        }
        if (obj.done) finish(true);
      }
    });
    up.on('end', () => { if (active.has(runId)) finish(true); });   // 无 done 帧的兜底
  });
  r.on('error', (e) => {
    if (controller.signal.aborted) finish(true, undefined);          // 用户主动中断：按已产出内容收尾
    else finish(false, 'Ollama 请求失败: ' + e.message);
  });
  r.on('close', () => { if (active.has(runId)) finish(true); });
  r.write(payload);
  r.end();
}

module.exports = { register, handleChatDirect };
