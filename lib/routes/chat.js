'use strict';
/*
 * 对话路由（SSE）+ 中断。
 *
 * 这是全项目最热也最纠缠的一条路径。两个 backend（-z 子进程 / gateway 常驻）控制流不同，
 * 但轮询骨架完全同构 —— 已抽成下面的共享件（sseOpen/newStats/pollMessages/makeErrLogger/
 * finalizeRun/startPollLoop，C 去重 2026-09-11）：每 tick 的公共次序是
 *   客户端存活检查 → eachTick（backend 专属：token tail / 会话发现）→ DB msg 推送 → isExited 时结算。
 * 两边各自只保留「token 从哪来 / 会话从哪来 / finish 多做什么」的差异，行为改动只需落一处。
 *
 * 双通道进度来源保持不变：
 *   1. token 流（-z: 流文件 tail / gateway: assistant.delta SSE）→ SSE `token`
 *   2. state.db messages 表轮询 → SSE `msg`（tool 调用 / reasoning 权威呈现）
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { HERMES, WORKSPACE, PROMPT_LIMIT, POLL_MS, DEFAULT_MODEL } = require('../config');
const { sendJSON, sse, readBody, tailStreamFile } = require('../http');
const { hermesEnv } = require('../hermes');
const { recallContext } = require('../knowledge');
const { resolveModel, loadCloudProviders, PROVIDER_PRESETS, providerHealth } = require('../cloud');
const { active, recordUsage } = require('../state');
const { latestSessionId, maxMessageId, newMessages, buildSessionMarkdown } = require('../db');
const { prewarmOllama, summarizeHistory } = require('../ollama');
// 选项 B 常驻后端（gateway）：安全等效于 -z 且首回合后全热；详见 lib/gateway.js 头部。
const { gatewayEnabled, gatewayUp, createSession, chatStream } = require('../gateway');
// 会话级危险操作放行（gateway 常驻进程 env 固定，只能走文件，不能走 env）
const { approveSession, BYPASS_TTL_MIN } = require('../safety');
// 自主执行模式：按需把三色权限/检查点/摘要格式前导拼进用户 prompt（不动 system prompt，护住 cache 前缀）
const { withAutonomy } = require('../autonomy');
// 会话压缩：摘要存取（一次性注入）+ 前缀拼接
const { setPendingSummary, takePendingSummary, withSummary } = require('../context');
// dsh 式工作区：新会话首轮按前端传来的 workspace 归类（独立 JSON，见 lib/workspace.js）
const wsStore = require('../workspace');

/* ========== 两个 backend 共享件（C 去重） ========== */

// SSE 响应头（两个 backend 一致）
function sseOpen(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('retry: 3000\n\n');
}

// 一轮 run 的可变统计（集中一处，替代散落的 let 计数器）
function newStats(sessionId) {
  return {
    lastMsgId: sessionId ? maxMessageId(sessionId) : 0,  // 续轮只推新增消息
    toolCallCount: 0, firstTokenMs: null, lastTokenAt: null, tokenChars: 0
  };
}

// DB 轮询 → SSE `msg`（tool 调用 / reasoning 的权威呈现；两个 backend 完全一致）
function pollMessages(res, sessionId, stats) {
  if (!sessionId) return;
  const rows = newMessages(sessionId, stats.lastMsgId);
  for (const r of rows) {
    stats.lastMsgId = r.id;
    if (r.role === 'tool') stats.toolCallCount++;
    sse(res, 'msg', {
      id: r.id, role: r.role, toolName: r.tool_name,
      content: r.content, toolCalls: r.tool_calls,
      displayKind: r.display_kind, reasoning: r.reasoning, ts: r.timestamp
    });
  }
}

// R4：轮询异常首错记日志（含堆栈），后续静默限频 —— 之前零痕迹吞异常，
// 导致 handler 逻辑错误表现为"消息推送静默中断"无法排查。
function makeErrLogger(tag, runId) {
  let logged = false;
  return (e) => {
    if (logged) return;
    logged = true;
    console.error(`[${tag}] 轮询异常 runId=${runId}: ${e && e.message}`);
    if (e && e.stack) console.error(e.stack);
  };
}

// 结算：done 事件 + 用量落账 + finish 清理 + 本地模型保活（两个 backend 唯一差异是 cloud 标志）
function finalizeRun(res, { getSessionId, model, cloud, t0, stats, finish, prewarm, prompt }) {
  const sessionId = getSessionId();
  const elapsed = (Date.now() - t0) / 1000;
  // 粗略 tokens/sec：只按生成窗口（首 token → 末 token）计，排除启动耗时；
  // 中文 ≈ 1 字/token，英文 ≈ 4 字符/token，取 2.5 折中
  const genWindowSec = stats.firstTokenMs != null && stats.lastTokenAt ? (stats.lastTokenAt - t0 - stats.firstTokenMs) / 1000 : 0;
  const charsPerSec = genWindowSec > 0.5 && stats.tokenChars > 0 ? Math.round(stats.tokenChars / genWindowSec / 2.5) : null;
  sse(res, 'done', {
    elapsed: elapsed.toFixed(1), sessionId,
    firstTokenMs: stats.firstTokenMs != null ? (stats.firstTokenMs / 1000).toFixed(1) : null,
    charsPerSec
  });
  recordUsage({
    sessionId, model, cloud,
    elapsedSec: Math.round(elapsed * 10) / 10,
    firstTokenSec: stats.firstTokenMs != null ? Math.round(stats.firstTokenMs / 100) / 10 : null,
    tokPerSec: charsPerSec, toolCalls: stats.toolCallCount,
    prompt: prompt.slice(0, 60)
  });
  finish();
  res.end();
  // 本地模型保活：运行结束后把驻留时间续上，避免被 Ollama（max_loaded_models=1）换载
  if (prewarm) prewarmOllama(model);
}

// 共享轮询循环。stop() 幂等：停表后不再触发任何 tick / finish / finalize。
function startPollLoop(opts) {
  const logErr = makeErrLogger(opts.logTag, opts.runId);
  let stopped = false, timer = null;
  const stop = () => { if (timer) { clearInterval(timer); timer = null; } stopped = true; };
  timer = setInterval(() => {
    if (stopped) return;
    if (opts.res.writableEnded || opts.res.destroyed) { stop(); opts.finish(); return; }
    try {
      if (opts.eachTick) opts.eachTick();
      pollMessages(opts.res, opts.getSessionId(), opts.stats);
      if (opts.isExited()) { stop(); opts.finalize(); }
    } catch (e) { logErr(e); }
  }, POLL_MS);
  return { stop };
}

module.exports = {
  register(router) {

    async function handleChat(req, res) {
      let body;
      try { body = JSON.parse(req.bodyText || ''); } catch { body = {}; }
      const rawPrompt = (body.prompt || '').trim();
      if (!rawPrompt) { sendJSON(res, 400, { error: 'empty prompt' }); return; }
      // prompt 超长截断，避免把上下文撑爆或被用来打满内存
      const prompt = rawPrompt.length > PROMPT_LIMIT ? rawPrompt.slice(0, PROMPT_LIMIT) + '…' : rawPrompt;
      const allowDangerous = body.allowDangerous === true;
      const runId = crypto.randomUUID();

      sseOpen(res);

      // ---- 模型解析 + 云端健康检查 + 自动降级 ----
      const chosen = resolveModel(body.model);
      const wsName = typeof body.workspace === 'string' ? body.workspace.trim().slice(0, 40) : '';
      let model = chosen.model;
      let extraEnv = null;
      let providerArgs = [];
      if (chosen.cloud) {
        const providers = loadCloudProviders();
        const cfg = providers[chosen.providerId];
        const preset = PROVIDER_PRESETS[chosen.providerId];
        sse(res, 'notice', { message: `正在检测云端接口 ${preset.label} …` });
        if (!cfg || !cfg.apiKey) {
          sse(res, 'notice', { message: `云端 ${preset.label} 未配置 API key，已降级到本地 ${DEFAULT_MODEL}` });
        } else {
          const hc = await providerHealth(chosen.providerId, cfg);
          if (hc.ok) {
            extraEnv = { [preset.env]: cfg.apiKey };
            if (cfg.baseUrl && preset.baseEnv) extraEnv[preset.baseEnv] = cfg.baseUrl;
            providerArgs = ['--provider', chosen.providerId];
            model = chosen.model;
            sse(res, 'notice', { message: `云端 ${preset.label} 可达 (${hc.latencyMs}ms)，使用 ${chosen.model}` });
          } else {
            sse(res, 'notice', { message: `云端不可达（${hc.error}），已自动降级到本地 ${DEFAULT_MODEL}` });
          }
        }
        if (!providerArgs.length) { chosen.cloud = false; model = DEFAULT_MODEL; }
      }

      const args = [];
      let sessionId = body.sessionId || null;
      if (sessionId) args.push('--resume', sessionId);
      // 新会话：自动召回相关历史经验并前缀进 prompt；
      // 续轮（有 sessionId）已由 Hermes 自带上下文承载，不重复注入，避免噪声。
      let finalPrompt = prompt;
      if (!sessionId) {
        const ctxKB = await recallContext(prompt);
        if (ctxKB) finalPrompt = ctxKB + '\n\n' + prompt;
      }
      // 自主执行模式：开关由前端「自主执行」按钮控制；黄区放行走同一条 allowDangerous 链路
      finalPrompt = withAutonomy(finalPrompt, body.autonomous === true);
      // 压缩续聊：新会话首条消息携带上一会话摘要（一次性，取后即焚）
      const pendSum = sessionId ? takePendingSummary(sessionId) : null;
      if (pendSum) finalPrompt = withSummary(finalPrompt, pendSum);
      // 注意：-z 模式内部强制 yolo，--yolo 标志多余已移除；安全由 pre_tool_call hook 负责。
      args.push('-z', finalPrompt, '--cli', '--in', WORKSPACE);
      args.push('-m', model, ...providerArgs);

      const streamFile = path.join(os.tmpdir(), `hermes-stream-${runId}.txt`);
      const t0 = Date.now();
      const baseline = latestSessionId();           // 用于识别「本次新建」的会话
      const stats = newStats(sessionId);
      let exited = false;
      const streamOffset = { pos: 0 };

      const child = spawn(HERMES, args, { env: hermesEnv({ allowDangerous, streamFile, extraEnv }), cwd: WORKSPACE });
      active.set(runId, child);
      if (sessionId) active.set(sessionId, child);

      sse(res, 'ready', { runId, sessionId, allowDangerous, model, cloud: chosen.cloud });

      const finish = () => {
        active.delete(runId);
        if (sessionId) active.delete(sessionId);
        try { fs.unlink(streamFile, () => {}); } catch { /* 临时流文件可能已被清走；删不掉也只是留个 tmp，无害 */ }
      };
      child.on('close', () => { exited = true; });
      child.on('error', e => { exited = true; sse(res, 'error', { message: e.message }); });

      const loop = startPollLoop({
        res, runId, logTag: 'chat', finish, stats,
        isExited: () => exited,
        getSessionId: () => sessionId,
        eachTick: () => {
          // 1) token 流（真流式，仅本地模型跑 Hermes 引擎时有效）
          tailStreamFile(streamFile, streamOffset, (text) => {
            if (stats.firstTokenMs == null) stats.firstTokenMs = Date.now() - t0;
            stats.lastTokenAt = Date.now();
            stats.tokenChars += text.length;
            sse(res, 'token', { text });
          });
          // 2) 新会话 id 从 DB 发现（-z 首轮才有；gateway 在进流前已建好）
          if (!sessionId) {
            const cur = latestSessionId();
            if (cur && cur !== baseline) { sessionId = cur; sse(res, 'session', { sessionId }); active.set(sessionId, child); if (wsName) wsStore.assignIfNew(sessionId, wsName); }
          }
        },
        finalize: () => finalizeRun(res, {
          getSessionId: () => sessionId, model, cloud: !!chosen.cloud, t0, stats, finish,
          prewarm: !chosen.cloud, prompt
        }),
      });

      /* 客户端断开（关标签页 / 刷新 / 断网 / curl 超时）。
       * 旧写法自己 clearInterval + unlink，但**漏了 active.delete** —— 每次中断都会在
       * active 里留下一条指向已死子进程的映射，只增不减：既泄漏内存，也让 /api/stop
       * 能"查到"早就没了的进程。现在统一走 finish()，它是本轮所有清理的唯一出口。 */
      req.on('close', () => {
        if (!exited) { try { child.kill('SIGTERM'); } catch { /* 子进程已退出 → kill 抛 ESRCH，属正常竞态 */ } }
        loop.stop(); finish();
        try { res.end(); } catch { /* 已结束，忽略 */ }
      });
    }

    /* ---------- gateway 常驻后端（选项 B） ----------
     * 与 -z 共用「双通道」设计：gateway SSE 的 assistant.delta → token（真流式）；
     * state.db 轮询 newMessages() → msg（tool 调用 / reasoning 权威呈现，gateway 把
     * api-* 会话写入 state.db，列与解析完全一致，已验证）。
     * 安全：gateway 注册并执行 pre_tool_call hook；allowDangerous 走文件放行
     * （lib/safety.approveSession），不碰 env（常驻进程 env 固定）。
     * 轮询骨架（存活检查 / msg 推送 / 结算 / finish）与 -z 共用 startPollLoop / finalizeRun。 */
    async function handleChatGateway(req, res) {
      let body;
      try { body = JSON.parse(req.bodyText || ''); } catch { body = {}; }
      const rawPrompt = (body.prompt || '').trim();
      if (!rawPrompt) { sendJSON(res, 400, { error: 'empty prompt' }); return; }
      const prompt = rawPrompt.length > PROMPT_LIMIT ? rawPrompt.slice(0, PROMPT_LIMIT) + '…' : rawPrompt;
      const allowDangerous = body.allowDangerous === true;
      const wsName = typeof body.workspace === 'string' ? body.workspace.trim().slice(0, 40) : '';
      const runId = crypto.randomUUID();

      sseOpen(res);

      const chosen = resolveModel(body.model);
      const model = chosen.model;
      const t0 = Date.now();
      let sessionId = body.sessionId || null;
      const stats = newStats(sessionId);
      let exited = false;
      const controller = new AbortController();
      // gateway 无独立子进程：用 fakeChild 让 /api/stop 与客户端断开都能 abort 本轮 run
      const fakeChild = { kill: () => { try { controller.abort(); } catch { /* 已结束 */ } } };
      active.set(runId, fakeChild);
      if (sessionId) active.set(sessionId, fakeChild);

      sse(res, 'ready', {
        runId, sessionId, allowDangerous, model, cloud: false, backend: 'gateway',
        // F②：文件放行有 TTL，随 ready 下发供前端提示有效期；-z 是按轮 env 放行，无该字段。
        ...(allowDangerous ? { bypassTtlMin: BYPASS_TTL_MIN } : {})
      });

      const finish = () => {
        active.delete(runId);
        if (sessionId) active.delete(sessionId);
      };
      // loop 在 createSession 等 await 期间可能尚未建立，stopLoop 统一做空值保护
      let loop = null;
      const stopLoop = () => { if (loop) loop.stop(); };
      // 客户端断开 → 中断 gateway run（api_server 会据此 interrupt 活体 agent）
      req.on('close', () => { try { controller.abort(); } catch { /* 已结束 */ } stopLoop(); finish(); try { res.end(); } catch { /* 已结束 */ } });

      try {
        let finalPrompt = prompt;
        if (!sessionId) {
          // 新会话：自动召回相关历史经验（续轮由 gateway 自带上下文承载，不重复注入）
          const ctxKB = await recallContext(prompt);
          if (ctxKB) finalPrompt = ctxKB + '\n\n' + prompt;
          // ⚠️ gateway 强制会话标题全局唯一（重复标题 → 400 invalid_title，"Title already in use"）。
          // 同一句 prompt 问两次是常态，标题必须带 runId 片段保证唯一。
          // 该 bug 由契约测试复跑暴露：首轮过后所有复跑都在 createSession 处 400。
          sessionId = await createSession({ title: `${prompt.slice(0, 32)} #${runId.slice(0, 8)}`, model });
          sse(res, 'session', { sessionId });
          // ⚠️ 必须补登记 sessionId 到 active：ready 事件发出时会话还没建出来（createSession 是异步的），
          // 此刻若不排进去，前端拿 sessionId 调 /api/stop 会命中不到（stop 契约测试用例4 捕获）。
          // -z 路径同理（见上面的轮询补登记），两条后端行为必须一致。
          active.set(sessionId, fakeChild);
          if (wsName) wsStore.assignIfNew(sessionId, wsName);   // dsh 式：新会话按当前工作区归类（不覆盖已有归属）
        }
        // 用户批准危险操作：写会话级放行文件（hook 读取）。gateway 常驻，env 无法按请求改。
        if (allowDangerous) approveSession(sessionId);

        // 自主执行模式：与 -z 路径同规则注入（两条后端行为必须一致）
        finalPrompt = withAutonomy(finalPrompt, body.autonomous === true);
        // 压缩续聊：压缩会话的首条消息注入上一会话摘要（一次性，取后即焚；与 -z 行为一致）
        const pendSum = takePendingSummary(sessionId);
        if (pendSum) finalPrompt = withSummary(finalPrompt, pendSum);

        const streamP = chatStream(sessionId, finalPrompt, {
          signal: controller.signal,
          onToken: (text) => {
            if (stats.firstTokenMs == null) stats.firstTokenMs = Date.now() - t0;
            stats.lastTokenAt = Date.now();
            stats.tokenChars += text.length;
            sse(res, 'token', { text });
          },
          onError: (msg) => { sse(res, 'error', { message: msg }); stopLoop(); finish(); try { res.end(); } catch { /* 已结束 */ } },
          onDone: () => { exited = true; },
        });

        loop = startPollLoop({
          res, runId, logTag: 'chat-gw', finish, stats,
          isExited: () => exited,
          getSessionId: () => sessionId,
          finalize: () => finalizeRun(res, {
            getSessionId: () => sessionId, model, cloud: false, t0, stats, finish,
            prewarm: true, prompt   // gateway 路径 model 恒本地（chosen.cloud=false）
          }),
        });

        await streamP;   // 流自然结束（done/error 已置 exited 或 finish）
      } catch (e) {
        sse(res, 'error', { message: e.message });
        stopLoop(); finish();
        try { res.end(); } catch { /* 已结束 */ }
      }
    }

    router.add('POST', '/api/chat', async (req, res) => {
      req.bodyText = await readBody(req);
      let body; try { body = JSON.parse(req.bodyText || ''); } catch { body = {}; }
      if (!(body.prompt || '').trim()) { sendJSON(res, 400, { error: 'empty prompt' }); return; }
      // 默认走 gateway（常驻、安全等效、首回合后全热）；不可达时回退 -z 保底。
      if (gatewayEnabled() && await gatewayUp()) return handleChatGateway(req, res);
      return handleChat(req, res);
    });

    /* ---------- 压缩续聊（context compaction） ----------
     * 旧会话全文 → 本地模型要点摘要 → 预创建新 gateway 会话并挂摘要 →
     * 用户在新会话发首条消息时一次性注入（takePendingSummary）。
     * 仅 gateway 模式支持：-z 会话由 Hermes 引擎创建，无法预建。 */
    router.add('POST', '/api/session/compact', async (req, res) => {
      const body = JSON.parse(await readBody(req) || '{}');
      const sid = String(body.sessionId || '').trim();
      if (!sid) return sendJSON(res, 400, { error: 'sessionId required' });
      const rows = newMessages(sid, 0);
      if (!rows.length) return sendJSON(res, 400, { error: '该会话没有可压缩的消息' });
      const md = buildSessionMarkdown(sid, rows);
      const r = await summarizeHistory(md);
      if (!r.ok || !r.text) return sendJSON(res, 502, { error: r.error || '摘要为空' });
      if (gatewayEnabled() && await gatewayUp()) {
        const newSid = await createSession({ title: `压缩续聊 ${new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })} #${crypto.randomUUID().slice(0, 8)}`, model: resolveModel(body.model).model });
        setPendingSummary(newSid, r.text);
        return sendJSON(res, 200, { ok: true, newSessionId: newSid, summary: r.text.slice(0, 200) + (r.text.length > 200 ? '…' : '') });
      }
      return sendJSON(res, 503, { error: 'gateway 未运行，压缩续聊仅支持 gateway 模式' });
    });

    router.add('POST', '/api/stop', async (req, res) => {
      const body = JSON.parse(await readBody(req) || '{}');
      const child = (body.runId && active.get(body.runId)) || (body.sessionId && active.get(body.sessionId));
      if (child) { try { child.kill('SIGTERM'); } catch { /* 同上：进程已退出时 kill 抛 ESRCH，正常竞态 */ } return sendJSON(res, 200, { ok: true }); }
      return sendJSON(res, 200, { ok: false, error: 'no active session' });
    });
  },
};
