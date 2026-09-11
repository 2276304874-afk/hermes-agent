#!/usr/bin/env node
'use strict';

/* ---------- 全局崩溃日志（防止静默死） ----------
 * 之前进程多次崩溃但 stdout/err 无任何错误信息，无法定位原因。
 * 捕获所有未处理异常和 Promise 拒绝，打印完整堆栈到 stderr 再退出。 */
process.on('uncaughtException', (e) => {
  console.error('[FATAL uncaughtException]', e.message);
  console.error(e.stack);
  // 给 stderr 时间刷新再退出（launchd 的 StandardErrorPath 是延迟写入的）
  setTimeout(() => process.exit(1), 100);
});
process.on('unhandledRejection', (reason, p) => {
  console.error('[FATAL unhandledRejection]', p, 'reason:', reason);
  if (reason && reason.stack) console.error(reason.stack);
});

/* ---------- 生命周期归因（P0-2：让"进程为什么没了"可判定） ----------
 * 之前的困境是：进程消失但日志里什么都没有，无法区分「代码崩了」和「被杀了」。
 * 补上这几行之后，任何一次消失都能读出来：
 *
 *   [lifecycle] 收到 SIGTERM   → 外部要求停止（launchctl stop / kill）
 *   [lifecycle] 进程退出 code= → 正常退出或崩溃（崩溃另有 [FATAL] 堆栈）
 *   日志里【什么都没有】        → 只可能是 SIGKILL（例如 launchctl kickstart -k）
 *                                或被系统回收 → 方向转为查"谁发的 kill"，不是查代码
 *
 * 收到信号后先记录，再 removeAllListeners + 重新发给自己，恢复默认处置 ——
 * 这样退出码/退出方式与不加处理器时完全一致，不改变 launchd 的 KeepAlive 语义。 */
console.error(`[lifecycle] 启动 pid=${process.pid} node=${process.version}`);
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(sig, () => {
    console.error(`[lifecycle] 收到 ${sig}，按默认行为退出`);
    process.removeAllListeners(sig);
    process.kill(process.pid, sig);
  });
}
process.on('exit', (code) => {
  console.error(`[lifecycle] 进程退出，code=${code}，已运行 ${Math.round(process.uptime())}s`);
});

/*
 * 赫尔墨斯特工 · Hermes Web UI 后端 (L3)
 * 无第三方依赖。通过 spawn 调用本地 Hermes CLI 作为引擎，并以 SSE 把
 * Hermes 运行时的「思考 / 工具调用 / 工具结果 / 逐 token 回答」实时推给前端。
 *
 * 本文件只做三件事：**启动自检 → 装配路由 → listen**。
 * 实现分散在 lib/ 下（每个文件一个关注点，依赖写在文件头的 require 里）：
 *   lib/config.js       常量与路径（单一真源）
 *   lib/parse.js        纯解析层（零副作用，可单测）
 *   lib/http.js         sendJSON / sse / readBody / serveStatic / tailStreamFile
 *   lib/auth.js         Bearer token
 *   lib/state.js        active（在跑的子进程）/ usageLog（单例可变状态）
 *   lib/db.js           state.db 只读轮询
 *   lib/hermes.js       Hermes CLI 调用 + oneshot 流式补丁自愈
 *   lib/ollama.js       Ollama 状态 / 多模态 / 预热门 / 追问生成
 *   lib/cloud.js        云端 provider（可选增强层）
 *   lib/knowledge.js    本地知识库检索与列举
 *   lib/skills.js       技能扫描 + 语义索引
 *   lib/maintenance.js  日志截断 / 上传清扫
 *   lib/router.js       极简路由表（保持前缀匹配语义）
 *   lib/routes/*.js     各领域路由（kb / session / system / provider / media / chat / toolbox）
 *
 * 实时进度来源（双通道）：
 *   1. token 流（L3 真流式）：oneshot.py 打了补丁 —— 当 HERMES_STREAM_FILE 存在时，
 *      agent.stream_delta_callback 把 assistant 文本 delta 逐块追加到该文件；
 *      本服务 tail 该文件，以 SSE `token` 事件流出。
 *   2. DB 轮询：Hermes 把每条消息写入 ~/.hermes/state.db 的 messages 表，
 *      node:sqlite 只读长连接 + WAL 模式，把新增行作为 SSE `msg` 事件流出。
 *
 * 云端 API 后端（L3）：Hermes 内置 provider 注册表（deepseek/alibaba/zai/kimi/...），
 * API key 走环境变量注入，无需改 config.yaml。模型名格式 `cloud:<providerId>/<model>`；
 * 发起对话前做健康检查（chat/completions max_tokens=1），失败自动降级本地 hermes-local。
 *
 * 安全模型：
 *   1. 所有 /api/* 请求需 Bearer token（启动时生成/读取，存 ~/.hermes/ui_token）。
 *   2. Hermes 高风险命令由 pre_tool_call hook（hooks/safety_check.py）拦截。
 *      用户在前端批准后，本次请求带 allowDangerous=true → 注入 HERMES_UI_BYPASS_SAFETY=1。
 *   3. 静态文件用 path.resolve + path.relative 防路径穿越。
 *   4. 请求体上限 100KB，prompt 截断到 8000 字符。
 *   5. 云端 key 明文存 ~/.hermes/cloud_providers.json（0600），API 返回时打码。
 *
 * 关键约束（来自部署实践）：
 *   - 必须删除 PYTHONPATH —— WorkBuddy 注入的 sitecustomize 会劫持 mkdir。
 *   - 本地请求必须 NO_PROXY=127.0.0.1,localhost，否则被代理拦截返回 502。
 *   - -z（oneshot）模式内部强制 yolo，故 --yolo 标志本身无意义；安全靠 hook。
 */

const http = require('http');
const fs = require('fs');
const { PORT, HOST, KB_PYTHON, TOKEN_FILE } = require('./lib/config');
const { createRouter } = require('./lib/router');
const { sendJSON, serveStatic } = require('./lib/http');
const { TOKEN, checkAuth } = require('./lib/auth');
const { patchState } = require('./lib/hermes');          // require 期即完成补丁自愈
const { runStartupMaintenance, startHeartbeat } = require('./lib/maintenance');
const { active } = require('./lib/state');               // 在跑的子进程表（心跳靠它判泄漏）

const KbRoutes = require('./lib/routes/kb');
const SessionRoutes = require('./lib/routes/session');
const SystemRoutes = require('./lib/routes/system');
const ProviderRoutes = require('./lib/routes/provider');
const MediaRoutes = require('./lib/routes/media');
const ChatRoutes = require('./lib/routes/chat');
const ToolboxRoutes = require('./lib/routes/toolbox');

/* ---------- 启动自检 ----------
 * 顺序固定：流式补丁（已在 require './lib/hermes' 时自愈）→ 日志截断 → 上传清扫 + 24h 周期。
 * 维护动作放在这里而不是 lib/config.js，是为了让「常量层」保持无副作用、可安全 require。 */
runStartupMaintenance();

/* ---------- 路由装配（P1-3 第二步：原约 420 行 if 链 → 路由表 + 领域模块） ----------
 * 匹配语义与原实现完全一致：顺序遍历、首个命中即处理、前缀匹配（见 lib/router.js）。
 * 装配顺序逐条对应原 if 链，改动时请保持：
 *   公开组（认证前）→ 静态文件 → 认证闸门 → 认证组 → 404
 *
 * P1-3 第三步起各路由模块自持依赖（直接 require lib/*），不再透传 ctx。 */
const publicRouter = createRouter('public');
const apiRouter = createRouter('api');

// 公开组：KB 查看器 + 只读接口（必须早于静态文件，否则 /kb 会被 serveStatic 拦成 404）
KbRoutes.registerPublic(publicRouter);

// 认证组：顺序对应原 if 链
SessionRoutes.register(apiRouter);
SystemRoutes.register(apiRouter);
ProviderRoutes.register(apiRouter);
MediaRoutes.register(apiRouter);
KbRoutes.registerAuthed(apiRouter);   // GET /api/kb?q= 必须排在公开 KB 路由之后
ChatRoutes.register(apiRouter);
ToolboxRoutes.register(apiRouter);

const server = http.createServer(async (req, res) => {
  /* ---------- 请求/响应流错误隔离（P0-2） ----------
   * EventEmitter 语义：'error' 事件若没有监听者，Node 直接把它升格为未捕获异常。
   * 实测证实：res.emit('error') 无人监听 → 进程立刻退出。
   * 真实来源是客户端 RST、或响应流在写回调中失败 —— 都是正常运维会遇到的事，
   * 不该让整个服务陪葬。这里统一记一行日志并吞掉。 */
  res.on('error', e => console.error(`[http] 响应流错误 ${req.method} ${req.url}: ${e && (e.code || e.message)}`));
  req.on('error', e => console.error(`[http] 请求流错误 ${req.method} ${req.url}: ${e && (e.code || e.message)}`));

  try {
    if (await publicRouter.dispatch(req, res)) return;
    // 静态文件无需认证（登录页要能加载）
    if (req.method === 'GET' && !req.url.startsWith('/api/')) return serveStatic(req, res);
    // 所有 /api/* 必须带 token
    if (!checkAuth(req)) return sendJSON(res, 401, { error: 'unauthorized' });
    if (await apiRouter.dispatch(req, res)) return;
    sendJSON(res, 404, { error: 'not found' });
  } catch (e) {
    /* ---------- 兜底错误处理（P0-2 崩溃根因） ----------
     * 这里曾经是裸的 sendJSON(res, 500, ...)，是个致命写法：
     * handler 已经发出响应头后抛错（SSE 路径在第 41 行就 writeHead 了），
     * sendJSON 里的 writeHead 会抛 ERR_HTTP_HEADERS_SENT，二次异常逃出 catch →
     * unhandledRejection → 进程退出。已用最小实验复现确认。
     *
     * 现在：先记日志（此前 handler 异常是完全静默的，无法排查），再只在「还没写响应」
     * 时才回 500；已经开写就只把流失掉，不再试图纠正状态。 */
    console.error(`[handler] ${req.method} ${req.url} 抛错：${e && e.message}`);
    if (e && e.stack) console.error(e.stack);
    if (!res.headersSent && !res.writableEnded) {
      sendJSON(res, 500, { error: e.message });
    } else {
      try { res.end(); } catch { /* 响应已结束，忽略 */ }
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`赫尔墨斯特工 UI → http://${HOST}:${PORT}`);
  // 安全：令牌不落日志（launchd 捕获的日志是明文的）。只给前 4 位便于核对是哪一把，
  // 完整令牌用 `cat ~/.hermes/ui_token` 取。
  console.log(`访问令牌 → ${String(TOKEN).slice(0, 4)}…（完整值见 ${TOKEN_FILE}，勿外传）`);
  console.log(`（令牌已存 ${TOKEN_FILE}，重启不变；可用 HERMES_TOKEN 环境变量覆盖）`);
  if (patchState.ok) {
    console.log(patchState.applied ? '流式补丁：已自动重新注入 oneshot.py ✅' : '流式补丁：oneshot.py 补丁在位 ✅');
  } else {
    console.log(`流式补丁：⚠️ ${patchState.reason}（真流式将不可用，工具调用轮询不受影响）`);
  }
  // P2-9: 打印实际选中的解释器，便于发现"路径腐烂"（托管目录改名/删除）
  if (!fs.existsSync(KB_PYTHON)) {
    console.log(`KB 解释器：⚠️ 不存在 ${KB_PYTHON}（自动召回将降级为无 KB）`);
  } else {
    console.log(`KB 解释器：${KB_PYTHON}`);
  }
  // P1-3: 打印路由登记数 —— 拆分后若某条路由漏登记，这一行会立刻对不上
  console.log(`路由登记：公开 ${publicRouter.list().length} 条 / 认证 ${apiRouter.list().length} 条`);
  // P0-2: 运行时心跳（基线在此打点，之后每 30 分钟一行；HERMES_HB_MS 可覆盖）
  startHeartbeat(active);
});
