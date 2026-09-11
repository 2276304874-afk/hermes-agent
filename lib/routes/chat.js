'use strict';
/*
 * 对话路由（SSE）+ 中断。
 *
 * 这是全项目最热也最纠缠的一条路径，拆分时保持逻辑零改动。
 * 依赖改写为文件头的直接 require（P1-3 第三步前是 server.js 里的 ctx 依赖袋，
 * 现已退场——读文件头即知这条路由依赖什么）。
 *
 * 双通道进度来源保持不变：
 *   1. token 流文件 tail（oneshot.py 补丁写入）→ SSE `token`
 *   2. state.db messages 表轮询 → SSE `msg`
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
const { latestSessionId, maxMessageId, newMessages } = require('../db');
const { prewarmOllama } = require('../ollama');
// 选项 B 常驻后端（gateway）：安全等效于 -z 且首回合后全热；详见 lib/gateway.js 头部。
const { gatewayEnabled, gatewayUp, createSession, chatStream } = require('../gateway');
// 会话级危险操作放行（gateway 常驻进程 env 固定，只能走文件，不能走 env）
const { approveSession } = require('../safety');

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

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      res.write('retry: 3000\n\n');

      // ---- 模型解析 + 云端健康检查 + 自动降级 ----
      const chosen = resolveModel(body.model);
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
      // 注意：-z 模式内部强制 yolo，--yolo 标志多余已移除；安全由 pre_tool_call hook 负责。
      args.push('-z', finalPrompt, '--cli', '--in', WORKSPACE);
      args.push('-m', model, ...providerArgs);

      const streamFile = path.join(os.tmpdir(), `hermes-stream-${runId}.txt`);
      const t0 = Date.now();
      const baseline = latestSessionId();           // 用于识别「本次新建」的会话
      let lastMsgId = sessionId ? maxMessageId(sessionId) : 0; // 续轮只推新增消息
      let exited = false;
      let firstTokenMs = null, tokenChars = 0, lastTokenAt = null, toolCallCount = 0;
      const streamOffset = { pos: 0 };

      const child = spawn(HERMES, args, { env: hermesEnv({ allowDangerous, streamFile, extraEnv }), cwd: WORKSPACE });
      active.set(runId, child);
      if (sessionId) active.set(sessionId, child);

      sse(res, 'ready', { runId, sessionId, allowDangerous, model, cloud: chosen.cloud });

      const finish = () => {
        clearInterval(timer);
        if (sessionId) active.delete(sessionId);
        active.delete(runId);
        try { fs.unlink(streamFile, () => {}); } catch { /* 临时流文件可能已被清走；删不掉也只是留个 tmp，无害 */ }
      };
      child.on('close', () => { exited = true; });
      child.on('error', e => { exited = true; sse(res, 'error', { message: e.message }); });

      let loggedErr = false;   // R4：轮询异常首错记日志、限频，不再零痕迹吞
      const timer = setInterval(() => {
        // 客户端已断开或本轮已结束 → 停止轮询并摘除 active 条目（清理统一走 finish）
        if (res.writableEnded || res.destroyed) { finish(); return; }
        try {
          // 1) token 流（真流式，仅本地模型跑 Hermes 引擎时有效）
          tailStreamFile(streamFile, streamOffset, (text) => {
            if (firstTokenMs == null) firstTokenMs = Date.now() - t0;
            lastTokenAt = Date.now();
            tokenChars += text.length;
            sse(res, 'token', { text });
          });
          // 2) DB 轮询（消息行 = 权威记录）
          if (!sessionId) {
            const cur = latestSessionId();
            if (cur && cur !== baseline) { sessionId = cur; sse(res, 'session', { sessionId }); active.set(sessionId, child); }
          }
          if (sessionId) {
            const rows = newMessages(sessionId, lastMsgId);
            for (const r of rows) {
              lastMsgId = r.id;
              if (r.role === 'tool') toolCallCount++;
              sse(res, 'msg', {
                id: r.id, role: r.role, toolName: r.tool_name,
                content: r.content, toolCalls: r.tool_calls,
                displayKind: r.display_kind, reasoning: r.reasoning, ts: r.timestamp
              });
            }
          }
          if (exited) {
            const elapsed = (Date.now() - t0) / 1000;
            // 粗略 tokens/sec：只按生成窗口（首 token → 末 token）计，排除 Hermes 启动耗时
            // 中文 ≈ 1 字/token，英文 ≈ 4 字符/token，取 2.5 折中
            const genWindowSec = firstTokenMs != null && lastTokenAt ? (lastTokenAt - t0 - firstTokenMs) / 1000 : 0;
            const charsPerSec = genWindowSec > 0.5 && tokenChars > 0 ? Math.round(tokenChars / genWindowSec / 2.5) : null;
            sse(res, 'done', {
              elapsed: elapsed.toFixed(1), sessionId,
              firstTokenMs: firstTokenMs != null ? (firstTokenMs / 1000).toFixed(1) : null,
              charsPerSec
            });
            recordUsage({
              sessionId, model, cloud: !!chosen.cloud,
              elapsedSec: Math.round(elapsed * 10) / 10,
              firstTokenSec: firstTokenMs != null ? Math.round(firstTokenMs / 100) / 10 : null,
              tokPerSec: charsPerSec, toolCalls: toolCallCount,
              prompt: prompt.slice(0, 60)
            });
            finish();
            res.end();
            // 本地模型保活：运行结束后把驻留时间续到 2h
            if (!chosen.cloud) prewarmOllama(model);
          }
        } catch (e) {
          // R4：首错记日志（含堆栈），后续错误静默限频，避免 150ms 一次的刷屏。
          // 之前这里零痕迹吞异常，导致 handler 逻辑错误表现为"消息推送静默中断"无法排查。
          if (!loggedErr) {
            loggedErr = true;
            console.error(`[chat] 轮询异常 runId=${runId}: ${e && e.message}`);
            if (e && e.stack) console.error(e.stack);
          }
        }
      }, POLL_MS);

      /* 客户端断开（关标签页 / 刷新 / 断网 / curl 超时）。
       * 旧写法自己 clearInterval + unlink，但**漏了 active.delete** —— 每次中断都会在
       * active 里留下一条指向已死子进程的映射，只增不减：既泄漏内存，也让 /api/stop
       * 能"查到"早就没了的进程。现在统一走 finish()，它是本轮所有清理的唯一出口。 */
      req.on('close', () => {
        if (!exited) { try { child.kill('SIGTERM'); } catch { /* 子进程已退出 → kill 抛 ESRCH，属正常竞态 */ } }
        finish();
        try { res.end(); } catch { /* 已结束，忽略 */ }
      });
    }

    /* ---------- gateway 常驻后端（选项 B） ----------
     * 与 -z 共用「双通道」设计：gateway SSE 的 assistant.delta → token（真流式）；
     * state.db 轮询 newMessages() → msg（tool 调用 / reasoning 权威呈现，gateway 把
     * api-* 会话写入 state.db，列与解析完全一致，已验证）。
     * 安全：gateway 注册并执行 pre_tool_call hook；allowDangerous 走文件放行
     * （lib/safety.approveSession），不碰 env（常驻进程 env 固定）。 */
    async function handleChatGateway(req, res) {
      let body;
      try { body = JSON.parse(req.bodyText || ''); } catch { body = {}; }
      const rawPrompt = (body.prompt || '').trim();
      if (!rawPrompt) { sendJSON(res, 400, { error: 'empty prompt' }); return; }
      const prompt = rawPrompt.length > PROMPT_LIMIT ? rawPrompt.slice(0, PROMPT_LIMIT) + '…' : rawPrompt;
      const allowDangerous = body.allowDangerous === true;
      const runId = crypto.randomUUID();

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      res.write('retry: 3000\n\n');

      const chosen = resolveModel(body.model);
      const model = chosen.model;
      const t0 = Date.now();
      let sessionId = body.sessionId || null;
      let lastMsgId = sessionId ? maxMessageId(sessionId) : 0;
      let firstTokenMs = null, lastTokenAt = null, tokenChars = 0, toolCallCount = 0, loggedErr = false;
      let exited = false;
      let timer = null;
      const controller = new AbortController();
      // gateway 无独立子进程：用 fakeChild 让 /api/stop 与客户端断开都能 abort 本轮 run
      const fakeChild = { kill: () => { try { controller.abort(); } catch { /* 已结束 */ } } };
      active.set(runId, fakeChild);
      if (sessionId) active.set(sessionId, fakeChild);

      sse(res, 'ready', { runId, sessionId, allowDangerous, model, cloud: false, backend: 'gateway' });

      const finish = () => {
        if (timer) clearInterval(timer);
        active.delete(runId);
        if (sessionId) active.delete(sessionId);
      };
      // 客户端断开 → 中断 gateway run（api_server 会据此 interrupt 活体 agent）
      req.on('close', () => { try { controller.abort(); } catch { /* 已结束 */ } finish(); try { res.end(); } catch { /* 已结束 */ } });

      let finalPrompt = prompt;
      try {
        if (!sessionId) {
          // 新会话：自动召回相关历史经验（续轮由 gateway 自带上下文承载，不重复注入）
          const ctxKB = await recallContext(prompt);
          if (ctxKB) finalPrompt = ctxKB + '\n\n' + prompt;
          sessionId = await createSession({ title: prompt.slice(0, 40), model });
          sse(res, 'session', { sessionId });
        }
        // 用户批准危险操作：写会话级放行文件（hook 读取）。gateway 常驻，env 无法按请求改。
        if (allowDangerous) approveSession(sessionId);

        const streamP = chatStream(sessionId, finalPrompt, {
          signal: controller.signal,
          onToken: (text) => {
            if (firstTokenMs == null) firstTokenMs = Date.now() - t0;
            lastTokenAt = Date.now();
            tokenChars += text.length;
            sse(res, 'token', { text });
          },
          onError: (msg) => { sse(res, 'error', { message: msg }); finish(); try { res.end(); } catch { /* 已结束 */ } },
          onDone: () => { exited = true; },
        });

        timer = setInterval(() => {
          if (res.writableEnded || res.destroyed) { finish(); return; }
          try {
            if (sessionId) {
              const rows = newMessages(sessionId, lastMsgId);
              for (const r of rows) {
                lastMsgId = r.id;
                if (r.role === 'tool') toolCallCount++;
                sse(res, 'msg', {
                  id: r.id, role: r.role, toolName: r.tool_name,
                  content: r.content, toolCalls: r.tool_calls,
                  displayKind: r.display_kind, reasoning: r.reasoning, ts: r.timestamp
                });
              }
            }
            if (exited) {
              const elapsed = (Date.now() - t0) / 1000;
              const genWindowSec = firstTokenMs != null && lastTokenAt ? (lastTokenAt - t0 - firstTokenMs) / 1000 : 0;
              const charsPerSec = genWindowSec > 0.5 && tokenChars > 0 ? Math.round(tokenChars / genWindowSec / 2.5) : null;
              sse(res, 'done', {
                elapsed: elapsed.toFixed(1), sessionId,
                firstTokenMs: firstTokenMs != null ? (firstTokenMs / 1000).toFixed(1) : null,
                charsPerSec
              });
              recordUsage({
                sessionId, model, cloud: false,
                elapsedSec: Math.round(elapsed * 10) / 10,
                firstTokenSec: firstTokenMs != null ? Math.round(firstTokenMs / 100) / 10 : null,
                tokPerSec: charsPerSec, toolCalls: toolCallCount,
                prompt: prompt.slice(0, 60)
              });
              finish();
              res.end();
              // 本地模型保活：gateway 对话结束后把驻留时间续上，避免被 Ollama（max_loaded_models=1）
              // 换载导致下一轮首字延迟回弹。gateway 路径 model 恒本地（chosen.cloud=false）。
              if (!chosen.cloud) prewarmOllama(model);
            }
          } catch (e) {
            // R4：首错记日志（含堆栈），后续错误静默限频
            if (!loggedErr) {
              loggedErr = true;
              console.error(`[chat-gw] 轮询异常 runId=${runId}: ${e && e.message}`);
              if (e && e.stack) console.error(e.stack);
            }
          }
        }, POLL_MS);

        await streamP;   // 流自然结束（done/error 已置 exited 或 finish）
      } catch (e) {
        sse(res, 'error', { message: e.message });
        finish();
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

    router.add('POST', '/api/stop', async (req, res) => {
      const body = JSON.parse(await readBody(req) || '{}');
      const child = (body.runId && active.get(body.runId)) || (body.sessionId && active.get(body.sessionId));
      if (child) { try { child.kill('SIGTERM'); } catch { /* 同上：进程已退出时 kill 抛 ESRCH，正常竞态 */ } return sendJSON(res, 200, { ok: true }); }
      return sendJSON(res, 200, { ok: false, error: 'no active session' });
    });
  },
};
