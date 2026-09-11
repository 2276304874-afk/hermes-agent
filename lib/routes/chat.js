'use strict';
/*
 * 对话路由（SSE）+ 中断。
 *
 * 这是全项目最热也最纠缠的一条路径，拆分时保持逻辑零改动，只把外部依赖
 * 从"模块级自由变量"改成显式 ctx 注入（依赖一眼可见，便于后续再往 handler 下沉）。
 *
 * 双通道进度来源保持不变：
 *   1. token 流文件 tail（oneshot.py 补丁写入）→ SSE `token`
 *   2. state.db messages 表轮询 → SSE `msg`
 */

module.exports = {
  register(router, ctx) {
    const {
      sendJSON, sse, readBody, spawn, crypto, os, path, fs,
      HERMES, WORKSPACE, PROMPT_LIMIT, POLL_MS,
      resolveModel, loadCloudProviders, PROVIDER_PRESETS, providerHealth, DEFAULT_MODEL,
      recallContext, hermesEnv, active, tailStreamFile,
      latestSessionId, maxMessageId, newMessages, recordUsage, prewarmOllama,
    } = ctx;

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
        try { fs.unlink(streamFile, () => {}); } catch {}
      };
      child.on('close', () => { exited = true; });
      child.on('error', e => { exited = true; sse(res, 'error', { message: e.message }); });

      const timer = setInterval(() => {
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
        } catch (e) { /* 忽略单次轮询异常 */ }
      }, POLL_MS);

      req.on('close', () => {
        clearInterval(timer);
        if (!exited) { try { child.kill('SIGTERM'); } catch {} }
        try { fs.unlink(streamFile, () => {}); } catch {}
        try { res.end(); } catch {}
      });
    }

    router.add('POST', '/api/chat', async (req, res) => {
      req.bodyText = await readBody(req);
      return handleChat(req, res);
    });

    router.add('POST', '/api/stop', async (req, res) => {
      const body = JSON.parse(await readBody(req) || '{}');
      const child = (body.runId && active.get(body.runId)) || (body.sessionId && active.get(body.sessionId));
      if (child) { try { child.kill('SIGTERM'); } catch {} return sendJSON(res, 200, { ok: true }); }
      return sendJSON(res, 200, { ok: false, error: 'no active session' });
    });
  },
};
