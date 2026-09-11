# 赫尔墨斯特工 · 长期项目记忆

## 架构与服务
- UI 服务 `server.js`(零依赖,node 22)由 launchd `com.hermes-agent.ui` 托管,端口 4173,绑 127.0.0.1。`launchd/com.hermes-agent.ui.plist` 真源;`bash setup.sh` 部署/自检。`run.sh` 运行期解析 node 最高版(禁硬编码版本路径)。认证 Bearer token 在 `~/.hermes/ui_token`(0600)。
- **launchd 权限边界**:`bootstrap`/`load` 在我的 shell 必 EIO 5 → **用户须先在 Terminal.app 跑一次 `setup.sh`**;注册后 `launchctl kickstart -k gui/$(id -u)/com.hermes-agent.ui` 我可用,改 server.js 自重启。
- 引擎 Hermes CLI(`~/.hermes/venvs/hermes/bin/hermes`):调用必 `env -u PYTHONPATH` + `NO_PROXY=127.0.0.1,localhost`。进度:`server.js` 每 150ms 轮询 `~/.hermes/state.db` + oneshot.py 流式补丁。静态文件实时读盘;改 lib/ 才需 kickstart。

## chat 后端:gateway(选项 B,已落地 2026-09-11)
- 用 `hermes gateway run` 常驻 + 其 `api_server` 适配器(OpenAI 兼容)。选 B 而非 serve,因 **serve 静默不注册 safety hook**(高危命令拦截失效);gateway 在 `run_startup.py:831` 注册 hook,安全不丢,且不碰 hermes 源码。
- 配置 `~/.hermes/config.yaml`:`gateway.platforms.api_server.{enabled:true, extra:{host:127.0.0.1, port:8642, key:<≥16位>}}`,key=Bearer `API_SERVER_KEY`。**host 禁 0.0.0.0**。
- launchd `com.hermes-agent.gateway.plist`(setup.sh [2b/6] 安装),env 含 `HERMES_ACCEPT_HOOKS=1` + `NO_PROXY=127.0.0.1,localhost` + 清空 `PYTHONPATH`。
- Node 客户端 `lib/gateway.js`:`POST ${GATEWAY_BASE}/api/sessions`(**顶层**非 /v1)→ `chat/stream` SSE(`assistant.delta`→token;`done`/`run.completed` 带 session_id)。state.db 轮询 `newMessages()`→`msg`(tool/reasoning 权威)。`handleChatGateway` 优先于 -z 保底(gatewayUp 判定)。
- ⚠️ **gateway 强制会话 title 全局唯一**(重复 → `400 invalid_title "Title already in use"`,响应体才见真因)。createSession 标题必须每轮唯一:`prompt.slice(0,32) + ' #' + runId.slice(0,8)`(2026-09-11 修,契约测试复跑暴露)。**gateway 错误必须带 body 片段抛出**,否则 400 无法排查。
- ⚠️ `chatStream` 有**空闲看门狗**(默认 5min 无输出 abort,`HERMES_STREAM_IDLE_MIN` 覆盖)——选空闲而非总时长,长 agent run 不误杀。放行 TTL 默认 5min(`HERMES_BYPASS_TTL_MIN`),gateway `ready` 带 `bypassTtlMin` 供前端提示。
- **危险命令放行**:`lib/safety.js` 的 `approveSession` 写 `ui_bypass_sessions.json`(秒级时间戳,hook 读);仅 `allowDangerous` 时 server 写入。⚠️ 单位秒,写毫秒=永久放行。

## 安全红线
- ⛔ 绝不把后端切 `hermes serve`:不注册安全 hook=静默关高危拦截。只用 gateway run / -z。
- api_server 调用**只留在 Node 端**,浏览器不得直连 :8642(CORS origin-gated:无 Origin 放行 / 跨站 403)。

## 服务现状(2026-09-12 02:00 实测)
- `com.hermes-agent.ui` 与 `com.hermes-agent.gateway` **均已 launchd 注册且 running**(此前"gateway 未注册"的待办已解决):UI pid→4173、gateway pid 2971→8642,均与端口监听一致。Ollama 11434 在跑,模型常驻。
- 测试基线(全绿):`npm test` **101** / `smoke` **51** / `ui` **38** / `health` **21** / `test:safety` **6** / `stop.smoke` **9** / `test:chat` **6**。

## 性能基线(2026-09-12 02:00,`/api/usage` summary)
- **avgFirstTokenSec24h ≈ 45.25s**(最大体验痛点)· avgTokPerSec 17.5 · avgElapsed 28.5s · 18 轮全本地 · toolCallsTotal 仅 3。
- 模型**常驻**(hermes-local-gemma4 3.1GB,expires ~2h)→ **45s 不是推理冷加载**,延迟来自 Hermes agent 侧(createSession / 工具注册 / gateway 编排),需专门打点定位。

## 功能完备性盘点(2026-09-12)
- **多模态已闭环**(勿重复列为缺口):`/api/vision`(base64 图)/`/api/transcribe`(前端重采样 16k WAV)/`/api/upload`(JSON `{name,data:base64}`,非 multipart!)/`/api/suggest` 均接线可用,已 curl 实测通过。入口:`#imgBtn`/`#fileBtn`/`#micBtn`。
- **工作区模块已闭环**:list/create/**rename**/delete/assign + 会话侧 📁 移动选择器。
- ⚠️ **模式开关「快速/思考」是纯 UI 折叠**,`chatMode` 只控制 `.reason` 展开与否,**不下传给模型**(刻意如此:关 CoT 会让小模型只说不做)。存在语义误导风险——需要产品决策而非顺手接线。

## 代码结构与工程化
- git on `main`。`.gitignore` 忽略 kb.db/kb_*_state.json 等;**kb_inbox.md/kb_distilled.md/memory/ 必须入库**。
- ⚠️ **无远端 tracking 分支**(`git rev-list --left-right origin/main...main` 失败)。`npm run mirror`(REST API,因本机 github.com:443 被阻断)/`npm run backup`(本地 bundle)均**未纳入常规流程**,有单点丢失风险。
- `lib/` 域模块:config(单一真源,`WORKSPACE=path.resolve(__dirname,'..')`)/state(单例,**禁 new Map**)/http/auth/db/hermes/ollama/cloud/knowledge/skills/maintenance/parse/router/gateway/safety/usage。`lib/routes/*` 39 端点。KB 检索逻辑=`lib/knowledge.js`(非 kb.js)。
- 前端三不变量:①head 内联主题+版本戳(不可外移);②`/app.js` 在 body 末不加 defer/async;③不改 ES module。`npm run check` 覆盖全部。
- **测试七张网**(全绿才可 `git commit`):`npm test`(node:test,101)/`npm run smoke`(路由 51)/`npm run ui`(浏览器 38)/`npm run health`(21)/`npm run test:safety`(hook 6)/`npm run test:stop`(9)/`npm run test:chat`(契约 6)。⚠️ 本机 `node --test` 须写 `node --test test/*.test.js`(目录被当模块路径)。

## 模型与 Ollama
- 主模型 `hermes-local-gemma4`(base gemma4:e4b,128K ctx)。⚠️ 工具型 agent 勿关 CoT:仅 `reasoning_effort:"none"` 生效,`think:false` 被忽略;关后小模型只说不做→记忆假死。

## 工程纪律(血泪)
- **永不并行 Edit 同文件**(竞态丢更新;success 但内容没变=过期快照)。一消息块一文件一 Edit。
- 进程存活查 `lsof -nP -iTCP:4173 -sTCP:LISTEN` + `/api/health` uptimeSec 递增;`launchctl print gui/$(id -u)/<label>` 核验注册(非 `launchctl list`)。
- 旧实例占端口→测新代码前务必重启(kickstart 愈孤儿 SSE 子进程)。
- plist 内 `<array>/<dict>` 禁 XML 注释(plutil 过,launchd EX_CONFIG)。
- 含中文 bash:`${VAR}` 勿写 `$VAR` 后接全角;`grep -c` 无匹配退出码 1,用 `F=$(grep -c x f 2>/dev/null); F="${F:-0}"`。

## 崩溃归因(P0-2)
根因:catch 二次写头→`ERR_HTTP_HEADERS_SENT`→unhandledRejection→退出。加固:sendJSON/sse 前置 `headersSent/writableEnded` 检查;req/res 挂 error 监听;readBody 处理 aborted/close;active 清理单出口。死亡归因看 stderr `[lifecycle]` 行。

## KB 认证
`/kb` 页壳公开;`/api/kb/*` 全需 Bearer(同主令牌)。list 返回数组 / search 返回对象(形状不同,改时两边看)。

## 备份与镜像
`npm run backup`(本地 bundle,`git clone <bundle>` 还原);`npm run mirror`(GitHub `2276304874-afk/hermes-agent`,经 REST API 非 git push——本机 github.com:443 被阻断)。非 ASCII 路径用 `git ls-tree -r -z`。
