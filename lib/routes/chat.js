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
const { prewarmOllama, summarizeHistory, isModelResident } = require('../ollama');
// 选项 B 常驻后端（gateway）：安全等效于 -z 且首回合后全热；详见 lib/gateway.js 头部。
const { gatewayEnabled, gatewayUp, createSession, chatStream } = require('../gateway');
// 会话级危险操作放行（gateway 常驻进程 env 固定，只能走文件，不能走 env）
const { approveSession, BYPASS_TTL_MIN } = require('../safety');
// 自主执行模式：按需把三色权限/检查点/摘要格式前导拼进用户 prompt（不动 system prompt，护住 cache 前缀）
const { withAutonomy } = require('../autonomy');
// 停止条件裁判：服务端检测"原地打转/卡死"（提示词层只能请求，这层是强制观测）
const { createJudge } = require('../stopjudge');
// 会话压缩：摘要存取（一次性注入）+ 前缀拼接
const { setPendingSummary, takePendingSummary, withSummary } = require('../context');
// 压缩/回退边界按需 flush 一次记忆捕获（OpenClaw Auto Memory Flush 借鉴；只捕获不蒸馏，见 lib/kbflush.js）
const { flushMemory } = require('../kbflush');
// ⑥ 模型 stall 降级决策（默认关，见 lib/stall.js 头部：16G 下"降到一个冷的备用模型"会更糟）
const { stallConfig, failoverPlan } = require('../stall');
// dsh 式工作区：新会话首轮按前端传来的 workspace 归类（独立 JSON，见 lib/workspace.js）
const wsStore = require('../workspace');
// 对话模式（侧栏 对话/工作 分段开关）：瘦 prompt 直连 Ollama，绕过引擎（见 lib/routes/chatmode.js）
const chatMode = require('./chatmode');

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
    toolCallCount: 0, firstTokenMs: null, lastTokenAt: null, tokenChars: 0,
    judge: createJudge()                                 // 停止条件裁判（本 run 独占）
  };
}

/* 裁判命中「hard」时是否要强制中断本轮。默认关：长任务里"看起来在重复"是常态，
 * 裁判的价值是让用户及时看见，不是替用户做决定。要强制中断设 HERMES_JUDGE_ABORT=1。 */
function judgeAbortEnabled() { return process.env.HERMES_JUDGE_ABORT === '1'; }

// DB 轮询 → SSE `msg`（tool 调用 / reasoning 的权威呈现；两个 backend 完全一致）
function pollMessages(res, sessionId, stats) {
  if (!sessionId) return;
  const rows = newMessages(sessionId, stats.lastMsgId);
  if (rows.length && stats.judge) {
    const { transitions } = stats.judge.observe(rows);
    for (const t of transitions) {
      // 独立事件（而非 notice）：前端要按级别渲染（warn 提示 / hard 警示）
      sse(res, 'judge', { level: t.level, code: t.code, message: t.message, evidence: t.evidence });
      if (t.level === 'hard' && judgeAbortEnabled() && typeof stats.abort === 'function') {
        sse(res, 'notice', { message: '⚖️ 停止条件裁判已中止本轮：' + t.message });
        try { stats.abort(t); } catch { /* 已结束/已 abort → 忽略 */ }
      }
    }
  }
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
    charsPerSec,
    // 停止条件裁判结论：只在命中时下发（ok 不带字段，避免前端多一个永远为空的判断）
    ...(stats.judge && stats.judge.result().level !== 'ok' ? { judge: stats.judge.result() } : {})
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

      // ② 会话车道（2026-09-13）：同一会话已有在跑的 run 时拒绝并发。
      // 无此守卫时，第二条请求的 active.set(sessionId, child) 会覆盖第一条的映射 ——
      // 前者子进程变孤儿无人追踪，且 /api/stop?session= 只能命中最新那条，旧任务杀不掉。
      // 新会话（body.sessionId 为空）天然无冲突。续轮 + 本地模型路径在「检查」与「登记」
      // 之间无 await（唯一的 await 是云端健康检查 / 新会话 recallContext），故无 check-then-act 竞态。
      const laneKey = String(body.sessionId || '').trim();
      if (laneKey && active.has(laneKey)) {
        sendJSON(res, 409, { error: 'session busy', message: '该会话正在执行中：请等待本轮结束，或先点停止。' });
        return;
      }

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
      // C1 工作目录前导（NEXT-STEPS C1）：-z 的 --in 不约束 terminal.cwd，显式声明
      // 工作目录防止任务落 $HOME；每条注入（-z 每轮新进程，无缓存前缀可保）。
      finalPrompt = `工作目录：${WORKSPACE}\n\n` + finalPrompt;
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
      // 裁判「hard」+ HERMES_JUDGE_ABORT=1 时的中断入口（默认不接）
      stats.abort = () => { try { child.kill('SIGTERM'); } catch { /* 已退出 → ESRCH，正常竞态 */ } };

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

      // ② 会话车道：与 -z 路径完全同规则（两条后端行为必须一致）。
      // 续轮 + 本地模型在此点到 active.set(sessionId, fakeChild) 之间无 await，无竞态窗口。
      const laneKey = String(body.sessionId || '').trim();
      if (laneKey && active.has(laneKey)) {
        sendJSON(res, 409, { error: 'session busy', message: '该会话正在执行中：请等待本轮结束，或先点停止。' });
        return;
      }

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
      // 裁判「hard」+ HERMES_JUDGE_ABORT=1 时的中断入口（默认不接）；abort 即 gateway 侧 interrupt
      stats.abort = () => { try { controller.abort(); } catch { /* 已结束 */ } };

      sse(res, 'ready', {
        runId, sessionId, allowDangerous, model, cloud: false, backend: 'gateway',
        // F②：文件放行有 TTL，随 ready 下发供前端提示有效期；-z 是按轮 env 放行，无该字段。
        ...(allowDangerous ? { bypassTtlMin: BYPASS_TTL_MIN } : {})
      });

      // B2 缓解（审计 2026-09-13）：目标模型未驻留则尽早提示，避免冷加载期间界面静默转圈。
      // 非阻塞：不耽误建会话，2s 内判定；模型已热则跳过，正常路径零额外延迟。
      isModelResident(model).then((r) => {
        if (!r && !res.writableEnded) sse(res, 'notice', { message: '模型加载中…（首次冷加载约 20–60s，请稍候）' });
      }).catch(() => {});

      const finish = () => {
        active.delete(runId);
        if (sessionId) active.delete(sessionId);
        if (firstTokenNoticeTimer) clearTimeout(firstTokenNoticeTimer);   // B2：释放首 token 看门狗
      };
      // loop 在 createSession 等 await 期间可能尚未建立，stopLoop 统一做空值保护
      let loop = null;
      // 首 token 看门狗（B2 缓解）：冷加载/provider 卡住时 30s 内无任何输出则主动提示，
      // 填补「ready 之后到首个 token」之间的静默窗口（此前仅有 5 分钟空闲看门狗，过长，
      // 实测同机显存争抢时曾静默挂起 200s 无 token/done/error）。
      let firstTokenNoticeTimer = setTimeout(() => {
        if (stats.firstTokenMs == null && !res.writableEnded) {
          sse(res, 'notice', { message: '模型仍在加载或生成尚未开始（冷加载通常 20–60s；若长时间无输出，可能是同机其他模型占用显存导致换载争抢）' });
        }
      }, 30000);
      const stopLoop = () => { if (loop) loop.stop(); };
      // 客户端断开 → 中断 gateway run（api_server 会据此 interrupt 活体 agent）
      req.on('close', () => { try { controller.abort(); } catch { /* 已结束 */ } stopLoop(); finish(); try { res.end(); } catch { /* 已结束 */ } });

      try {
        let finalPrompt = prompt;
        if (!sessionId) {
          // 新会话：自动召回相关历史经验（续轮由 gateway 自带上下文承载，不重复注入）
          const ctxKB = await recallContext(prompt);
          if (ctxKB) finalPrompt = ctxKB + '\n\n' + prompt;
        }
        // 自主执行模式：与 -z 路径同规则注入（两条后端行为必须一致）
        finalPrompt = withAutonomy(finalPrompt, body.autonomous === true);
        // 压缩续聊：压缩会话的首条消息注入上一会话摘要（一次性，取后即焚；与 -z 行为一致）。
        // ⚠️ 必须在下面重试循环**之前**取出：取后即焚，若放进循环第二次就取不到了；
        //    且降级换会话后可复用同一个 finalPrompt（摘要已拼在首部）。
        const pendSum = sessionId ? takePendingSummary(sessionId) : null;
        if (pendSum) finalPrompt = withSummary(finalPrompt, pendSum);

        // ⚠️ 轮询循环只启一次：getSessionId 是活闭包（() => sessionId），⑥ 降级换会话时自动跟随。
        loop = startPollLoop({
          res, runId, logTag: 'chat-gw', finish, stats,
          isExited: () => exited,
          getSessionId: () => sessionId,
          finalize: () => finalizeRun(res, {
            getSessionId: () => sessionId, model, cloud: false, t0, stats, finish,
            prewarm: true, prompt   // gateway 路径 model 恒本地（chosen.cloud=false）
          }),
        });

        /* ⑥ 模型 stall 降级（默认关）。循环最多跑两次：正常一次；开启降级且首 token
         * 超时 → 换备用模型再跑一次。详见 lib/stall.js 头部的两条硬边界
         * （只在首 token 前 / 备用模型必须已驻留）。 */
        const stall = stallConfig();
        let curModel = model;
        let attempts = 0;
        for (;;) {
          if (!sessionId) {
            // ⚠️ 标题必须唯一（gateway 强制）：降级重跑时带上 attempts 后缀，
            //    否则与第一次同标题 → 400 invalid_title（该坑已在主路径踩过一次）。
            const title = `${prompt.slice(0, 32)} #${runId.slice(0, 8)}${attempts ? '-' + attempts : ''}`;
            sessionId = await createSession({ title, model: curModel });
            sse(res, 'session', { sessionId });
            // ⚠️ 必须补登记 sessionId 到 active：ready 事件发出时会话还没建出来（createSession 是异步的），
            // 此刻若不排进去，前端拿 sessionId 调 /api/stop 会命中不到（stop 契约测试用例4 捕获）。
            // -z 路径同理（见上面的轮询补登记），两条后端行为必须一致。
            active.set(sessionId, fakeChild);
            // 换会话时把 DB 轮询游标归零：新会话消息 id 由低位起算，沿用旧游标会整段跳过。
            stats.lastMsgId = 0;
            if (wsName) wsStore.assignIfNew(sessionId, wsName);   // dsh 式：新会话按当前工作区归类（不覆盖已有归属）
          }
          // 用户批准危险操作：写会话级放行文件（hook 读取）。gateway 常驻，env 无法按请求改。
          if (allowDangerous) approveSession(sessionId);

          // 每次尝试独立的 AbortController，并转发外层中断（/api/stop、客户端断开）。
          // 为什么要独立：stall 只该掐掉**这一次**流；若直接 abort 外层 controller，
          // 就把整轮标记成了用户中断，重试逻辑再也无从判断。
          const attemptCtrl = new AbortController();
          const relayAbort = () => { try { attemptCtrl.abort(); } catch { /* 已结束 */ } };
          controller.signal.addEventListener('abort', relayAbort, { once: true });

          let firstTokenSeen = false;
          let stalled = false;
          const stallGuard = stall.sec > 0 ? setTimeout(() => {
            if (!firstTokenSeen && !res.writableEnded) {
              stalled = true;
              try { attemptCtrl.abort(); } catch { /* 已结束 */ }
            }
          }, stall.sec * 1000) : null;

          await chatStream(sessionId, finalPrompt, {
            signal: attemptCtrl.signal,
            onToken: (text) => {
              firstTokenSeen = true;
              if (stallGuard) clearTimeout(stallGuard);
              if (stats.firstTokenMs == null) { stats.firstTokenMs = Date.now() - t0; if (firstTokenNoticeTimer) { clearTimeout(firstTokenNoticeTimer); firstTokenNoticeTimer = null; } }
              stats.lastTokenAt = Date.now();
              stats.tokenChars += text.length;
              sse(res, 'token', { text });
            },
            // ⚠️ stall 掐流同样会走到 onDone（gateway 的 AbortError 分支只回调 onDone，不回调 onError）
            //    —— 必须区分开：stall 不算本轮结束，否则轮询循环会立刻 finalize 掉这一轮。
            onError: (msg) => { if (stalled) return; sse(res, 'error', { message: msg }); stopLoop(); finish(); try { res.end(); } catch { /* 已结束 */ } },
            onDone: () => { if (stalled) return; exited = true; },
          }).finally(() => {
            if (stallGuard) clearTimeout(stallGuard);
            controller.signal.removeEventListener('abort', relayAbort);
          });

          if (!stalled) break;            // 正常结束 / 用户中断 / 真错误 → 一轮到底
          if (res.writableEnded) break;   // 客户端已走，不再重试

          // 备用模型是否已驻留（唯一决定"降级是否划算"的外部事实，见 lib/stall.js 头部）
          let fallbackResident = false;
          if (stall.fallback) { try { fallbackResident = await isModelResident(stall.fallback); } catch { fallbackResident = false; } }
          const plan = failoverPlan({
            firstTokenSeen: stats.firstTokenMs != null, attempts,
            sec: stall.sec, model: curModel, fallback: stall.fallback, fallbackResident,
          });
          if (plan.action !== 'retry') {
            // 无路可退时明确告知，而不是继续静默等 5 分钟空闲看门狗
            sse(res, 'notice', { message: `主模型 ${curModel} 首 token 超时（>${stall.sec}s），未降级（${plan.reason}）。可点停止后改用更小的模型。` });
            break;
          }
          sse(res, 'notice', { message: `⚠️ 主模型 ${curModel} 首 token 超时（>${stall.sec}s），已自动降级到 ${plan.model} 重跑本轮` });
          // 丢弃被放弃的会话的 active 映射 —— 否则它会永远挂在 active 里，
          // 之后任何发往该会话的请求都会被 ② 的会话车道判为「忙」而 409。
          if (sessionId) active.delete(sessionId);
          curModel = plan.model;
          attempts++;
          sessionId = null;   // 下一轮新建会话（挂备用模型）
        }
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
      // 对话模式：瘦 prompt 直连 Ollama，无工具无引擎（首字 ~1-2s，闲聊专用）
      if (body.mode === 'chat') return chatMode.handleChatDirect(req, res, body);
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
      // 压缩边界 flush：这条会话刚被读完、马上要「翻篇」，正是沉淀它的自然时机。
      // 只捕获（秒级、不调模型），蒸馏交给 30min 定时器 —— 详见 lib/kbflush.js 头部。
      flushMemory('compact');
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
