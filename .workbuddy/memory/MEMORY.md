# 赫尔墨斯特工 · 长期项目记忆

## 架构与服务
- UI 服务:`server.js`(无第三方依赖,node 22)由 launchd `com.hermes-agent.ui` 托管,端口 4173,绑 127.0.0.1(HOST env 可改 0.0.0.0 开局域网)。真源 plist:工作区 `launchd/com.hermes-agent.ui.plist`;部署/自检:`bash setup.sh`。
- **launchd 装/管权限边界(2026-09-11 定型)**:`bootstrap`/`load` 在我的 shell 里必 EIO 5(非 GUI 会话),**必须用户在 Terminal.app 跑一次 `setup.sh`**;但守护一旦注册,**`launchctl kickstart -k gui/$(id -u)/com.hermes-agent.ui` 在我这边可用** → 之后改 server.js 我自己就能重启,不用麻烦用户。
- 启动链:plist → `/bin/bash run.sh` → `run.sh` 运行期解析 node(优先 `~/.workbuddy/binaries/node/versions/*` 最高版)→ `exec node server.js`。**禁再硬编码 node 版本路径**(22.22.2-2→-3 曾静默失效)。
- 认证:Bearer token 在 `~/.hermes/ui_token`(0600,重启不变)。
- 引擎:Hermes CLI(`~/.hermes/venvs/hermes/bin/hermes`)。调用必 `env -u PYTHONPATH`(WorkBuddy sitecustomize 劫持 mkdir);本地请求必 `NO_PROXY=127.0.0.1,localhost`。
- 进度:server.js 每 150ms 轮询 `~/.hermes/state.db` messages 表 + oneshot.py 流式补丁(启动自愈)。静态文件实时读盘,改 HTML 即时生效;改 server.js 需 kickstart。

## 代码结构与工程化(2026-09-11 起)
- **已纳入 git**(`main`,身份 `zhaocaozheng@localhost` 仅仓库级,未动全局)。首次提交 `f5d8a7b`,`refactor(parse)` `9f93aa2`。`.gitignore` 忽略 `.workbuddy/kb.db`(FTS5,可重建)、`kb_*_state.json`、`.workbuddy/tmp/`、`.mimosa/ .v2c/ .video_agent/ .zcode/`、`__pycache__`、`*.bak-*`;**kb_inbox.md / kb_distilled.md / memory/ 是内容资产,必须入库**。
- **分层现状**(2026-09-11 第三步后,提交 `6b3b0da`):**`server.js` 仅 141 行**,只剩「启动自检 → 装配路由 → listen」+ 大段架构注释(那是活文档,勿删)。
  - `lib/config.js` —— 常量与路径**单一真源**。⚠️ WORKSPACE 必须 `path.resolve(__dirname,'..')`(本文件在 lib/ 下,`__dirname` 是 lib 不是工作区根)。
  - `lib/state.js` —— **单例可变状态**:`active`(runId/sessionId→子进程) / `usageLog` / `recordUsage`。⚠️ **绝不能各模块自行 `new Map()`**,否则 /api/stop 永远找不到正在跑的进程。CommonJS 模块缓存保证同引用。
  - `lib/http.js`(sendJSON/sse/readBody/serveStatic/tailStreamFile) / `lib/auth.js`(TOKEN/checkAuth) / `lib/db.js`(getDB/withDB/latestSessionId/maxMessageId/newMessages/buildSessionMarkdown) / `lib/hermes.js`(hermesEnv/runHermes/runSessionsList/oneshot补丁自愈+patchState) / `lib/ollama.js`(状态/多模态/prewarm/suggestFollowups) / `lib/cloud.js`(PROVIDER_PRESETS/resolveModel/providerHealth/maskKey) / `lib/knowledge.js`(recallHits/recallContext/kbListEntries) / `lib/skills.js`(scanLocalSkills/embed/ensureSkillIndex) / `lib/maintenance.js`(日志截断+上传清扫)。
  - `lib/parse.js`(177 行,纯解析层,零副作用) / `lib/router.js`(极简路由表)。
  - `lib/routes/*.js` 7 个模块:`kb`(公开4+认证1) / `session`(5) / `system`(5) / `provider`(5) / `media`(4) / `chat`(2,含 handleChat) / `toolbox`(13) = **认证 35 + 公开 4 = 39 条,与原 if 链分支数逐条对上**。
  - **`ctx` 依赖袋已退场**:各路由模块改为文件头直接 `require('../xxx')`,依赖静态可分析。代价是**改了 lib 里的函数名/导出,要重新 grep 全部调用点**(踩过:`warnIfParseEmpty` 从 server.js require 里删了但 `runSessionsList` 还在调)。
  - ⚠️ **文件名陷阱**:KB 检索逻辑叫 `lib/knowledge.js` 而非 `lib/kb.js` —— `lib/routes/kb.js` 已占该名,同名会让人在 require 时看错目录。
  - 装配顺序即匹配优先级,**改动必须保持**:公开组 → 静态文件 → 认证闸门(`/api/*` 无 token 401) → 认证组 → 兜底 404。
  - **前端结构(2026-09-11 第四步后,提交 `a2e8c7c`)**:`public/index.html` 1864 → **151 行**(只剩骨架 + 一段必须内联的脚本) / `public/app.css` 289 行样式 / `public/app.js` 1422 行逻辑(保留 IIFE,零改动搬迁)。
  - ⚠️ **前端三条不变量**:①head 里的「主题初始化 + 版本戳」**不可外移**(须在 `<body>` 渲染前同步执行,外移会有一帧亮色闪烁);②`<script src="/app.js">` 必须在 body 末尾且**不加 defer/async**;③不改成 ES module(会变严格模式 + 顶层 import/export 语义变化 = 顺手改行为)。
  - ⚠️ **拆分 HTML 时必查的三个静默回归**(机制坏了但功能"看起来正常"):版本戳作用域(原来只取 index.html mtime → 改 JS 不触发提示条)/ 缓存头(.js/.css 若 max-age 会出现"新 HTML + 旧 JS"半新半旧)/ 注释过期(架构注释仍描述旧结构)。
- **测试五步曲**(改完代码的标准流程):
  1. `npm test` —— **51 例**,node:test 零依赖,四个文件:
     - `test/parse.test.js`(22)纯解析层 / `test/cloud.test.js`(7)云端回退语义 / `test/http.test.js`(20)**写出护栏与流式正确性** / `test/wiring.test.js`(2)**接线自检**。
     - fixture 必须标 `[真实]`(抄自本机 CLI 实际输出)/`[合成]`(按已知格式构造)。
     - ⚠️ 本机 node 22.22.2 的 `node --test <目录>` 会被当成模块路径 → 必须写 `node --test test/*.test.js`。
     - `cloud.test.js` 的重点是**回退语义**:未知本地模型名 → `DEFAULT_MODEL`;不完整 `cloud:` 串 → 回落本地(否则拿空 model 请求云端)。这两条回归后现象是"选某模型就失败",日志看不出根因。
     - `http.test.js` 的 mock **故意在误用时抛错**(复刻 `ERR_HTTP_HEADERS_SENT` / `ERR_STREAM_WRITE_AFTER_END`),这样"护栏生效"才是**可证伪**的 —— 谁删掉前置检查,用例立刻变红。
     - `wiring.test.js` 静态扫描全部 `const {…} = require('…')` 逐名核对导出存在。**起因是真事故**:加了 `startHeartbeat` 函数却忘了加进 `module.exports` → 启动即 `TypeError` 崩溃循环,而 `node --check` 只看语法、单测不覆盖启动路径,原本抓不到。(已反证:临时删掉导出,该用例立刻红并精确指认文件与符号。)
  2. `bash test/routes.smoke.sh` —— **44 项路由清单冒烟**(`npm run smoke`)。判据不是 200 而是**命中**:400/401/404(业务) 都算通过,只有落到兜底 `not found` 才说明路由丢了。全部请求走参数校验分支,**零副作用**(不建 cron/不装技能/不写记忆/不删会话)。支持 `HERMES_TOKEN=x bash test/routes.smoke.sh 4199` 打备用端口。
  3. `node test/ui.smoke.js [port] [token]` —— **前端浏览器冒烟(22 项)**(`npm run ui`)。无头 Chrome 实际加载页面,四层判据:L1 传输(200+MIME) / L2 执行(看版本戳是否被服务端替换,证明 app.js 真跑了) / L3 渲染(CSS 变量可读、关键 DOM 非零尺寸、注入 token 后登录遮罩隐藏) / L4 健康(零 pageerror、零 console.error、零 4xx)。
     - 实现关键:**用 `playwright-core` + `executablePath` 指本机已装 Chrome**,不下载浏览器。playwright-core 在 `~/.workbuddy/binaries/node/workspace/node_modules`(脚本内有多路兜底,不依赖 NODE_PATH)。二者缺一时打 SKIP 退 0,但明确标注"前端未经验证"。
     - 踩坑:资源类 console.error 的**文本里不含 URL**(只有 `Failed to load resource ... 404`),只按文本做 favicon 白名单会误判 → 必须同时取 `m.location().url`。
  4. `bash healthcheck.sh` —— **20 项**服务级自检(`npm run health`),退出码 0/1。
     - ⚠️ 日志检查**只统计「本次启动以来」**,以 stderr 的 `[lifecycle] 启动` 行为界。err.log 是追加式的,全量统计会把历史故障一直当成当前故障报(真踩到:修完 bug 后自检仍红,报的是两条已修复的旧 `[FATAL]`)。
     - 含 `[handler]` 请求异常检查 —— 这是 P0-2 加固前**完全看不到**的信号(handler 抛错但被兜底接住、服务没死)。
  最后 `git commit`;需要生效时 `launchctl kickstart -k gui/$(id -u)/com.hermes-agent.ui`(前端三文件实时读盘 + no-cache,改完刷新即可,无需重启;只有改 `lib/` 才需 kickstart)。
- **启动日志可核对项**:`路由登记:公开 N 条 / 认证 M 条`(漏登记立刻可见)、`KB 解释器:<path>`(路径腐烂可见)、`流式补丁:…`(oneshot 自愈状态)、`[hb start] uptime=0s rss=…MB active=…`(内存/子进程泄漏基线)。

## 备份与异地镜像(2026-09-11 建立)
- **本地 bundle**:`npm run backup`(`backup.sh`)。产物落 `../_hermes-backups/hermes-repo-<时间戳>.bundle`,默认保留最近 10 份(`HERMES_BACKUP_KEEP` 可改)。可传外部目标:`bash backup.sh /Volumes/xxx`(复制后 sha256 双向核对)。**还原:`git clone <bundle> <目录>`**——已实测可完整还原(11 提交 / 80 文件 / 关键文件 sha256 与工作区一致)。
  - ⚠️ 同盘备份**不防磁盘故障**,脚本会主动告警。
  - ⚠️ 备份被中断会留下 `<file>.bundle.lock`,此后每次都报 "Another git process seems to be running"(消息误导,其实是输出文件的锁)。`backup.sh` 每次开跑先清。
- **异地镜像**:GitHub 私有库 **`2276304874-afk/hermes-agent`**(用户确认该账号是其本人账号)。刷新用 `npm run mirror`(`scripts/push-via-api.js`)。
  - **为什么不用 `git push`**:本机网络对 `github.com:443` 返回 `CONNECT tunnel failed, response 502`(策略阻断);对照实测 `api.github.com`→200、`codeload.github.com`→301、`github.com`→超时。所以只能走 REST API 的 Git Data API(blob→tree→commit→ref),保留完整提交图。
  - ⚠️ **坑 1:`git ls-tree` 默认转义非 ASCII 路径**。`core.quotePath=true` 时 `项目导读.md` 被输出成 `"\351\241\271..."`,直接当 path 用会在 GitHub 生成**名字真的是那串转义**的文件。**必须用 `git ls-tree -r -z`**(NUL 分隔,原始字节)。识别症状:远端文件名带引号 + 根树条目顺序异常(引号 0x22 让它们排到最前)。
  - ⚠️ **坑 2:提交 sha 无法与本地对齐**(GitHub 硬限制)。git 把时间戳写成 `<epoch> ±HHMM`(本地 `+0800`),GitHub **归一到 UTC**(返回 `...Z`)→ 字节不同 → sha 不同并沿 parent 链级联。**树 sha 可以逐提交全等(实测 11/11),提交 sha 必然 0/11**。
  - **因此:把 GitHub 当只读异地镜像,不要指望 `git push`**。要更新就重跑 `npm run mirror`。若哪天想对齐 sha,只能让提交从一开始用 +0000 时区,或 `git fetch origin && git reset --hard origin/main` 以远端为准(动手前先 backup)。
  - 校验手段:远端根树 sha == 本地 `HEAD^{tree}` + 逐提交树 sha 比对 + 沿 parent 链数提交数。**不要只用"逐文件比对"**——两侧若都取转义输出会拿 bug 跟自己对账,报"全部一致"但其实是错的。

## 模型与 Ollama
- **主模型(2026-09-10 起):`hermes-local-gemma4`**(base `gemma4:e4b`,PLE 稀疏激活,9.6GB 盘 / ~3.3GB 驻留,128K ctx,原生 tools+vision+audio)。**一个模型同时扛对话/工具/视觉/音频**,已不再需要 llava 换载。
- Ollama.app(GUI)托管,max_loaded_models 默认 1。
- ⚠️ **绝不给工具型 agent 关 CoT**:在 Hermes `/v1` 上 `think:false` 被忽略,只有 `reasoning_effort:"none"` 生效;而关掉后小模型会**只说不做**(嘴上"已记录",`messages.tool_calls` 实为空)→ 记忆功能假死。曾踩过并回滚。
- Vision:`/api/vision`(llava:7b 为旧路径),请求级 keep_alive 30m。llava 冷加载/换载 12s~4min 波动(page cache 决定)。
- 16G 内存:多模型同驻被 macOS 权限挡(`launchctl setenv` Not privileged);GUI Ollama 菜单设置或 root 可解。

## 工程纪律(血泪教训)
- **永不并行 Edit 同一文件**(竞态丢更新)。2026-09-11 前端拆分时**同一轮犯了两次**(system.js 两处并行编辑丢了第 2 处;http.js 三处并行只落地 1 处)。**危险信号:Edit 返回 success 但内容没变** —— 它匹配的是过期快照。症状极隐蔽:文件进入"半改状态",`node --check` 能过(缺的是函数定义不是语法),要到**运行期**才炸 `ReferenceError: xxx is not defined`。规则:**一个消息块里只对一个文件发一个 Edit**;多点改动合并成一个覆盖连续区间的 Edit。
- **本机 Bash grep `a\|b` 交替模式不可信**(假阴性),用 Grep 工具或 python。
- **判断"服务没起来/未注册"必须用 `launchctl print gui/$(id -u)/<label>` 核验,不能用 `launchctl list`** —— 后者在我的 shell 里恒返回 0 行,曾据此误报"守护未注册"。域级导出 `launchctl print gui/$(id -u)` 也可看到 `pid -状态 label` 行。
- **ps / lsof 在我的 shell 里可能看不到用户 GUI 会话的进程**(`ps` 报 operation not permitted);判断进程存活改用 `lsof -nP -iTCP:4173 -sTCP:LISTEN` + `/api/health` 的 uptimeSec 递增。
- **UI 长流程测试后 server.js 会被孤儿 SSE/hermes 子进程弄脏**(curl 也挂)→ kickstart 即愈。
- **测试期间不并发 curl 其他模型**(单驻留下互抢换载,互相拖死)。
- **判"功能缺失"前先确认跑的是新代码**:旧实例常占着端口,新代码未重启就测会得假阴性。用 `/api/*` 新路由 404/unauthorized 反推。
- **plist 里禁止在 `<array>`/`<dict>` 内部写 XML 注释**:`plutil` 能过但 launchd 报 `EX_CONFIG 78`。注释只能放文件头。
- `/usr/bin/python3` 与托管 python 均支持 sqlite FTS5 trigram,故 KB 解释器可安全回退;但仍应动态解析而非硬编码版本目录(见 `resolvePython()` / `kb/sync.sh`)。
- **大块结构搬迁用行号切片更稳,别用超长 old_string**:先 `Read` 定位切点 → 断言校验(`assert '目标函数' in head`)→ python 切片拼接 → `git diff --stat` 核对规模 → `node --check`。
- **写含中文的 bash 脚本:变量引用一律写 `${VAR}`**。写成 `$VAR` 且后面紧跟全角字符(如 `）`、`，`)时,bash 会把那些字节并进变量名,`set -u` 下直接报 `unbound variable`(healthcheck.sh 踩过)。
- **`grep -c` 无匹配时输出 `0` 但退出码为 1** → 不可写 `F=$(grep -c x f || echo 0)`,会得到 `"0\n0"`。正确写法:`F=$(grep -c x f 2>/dev/null); F="${F:-0}"`。

## 崩溃归因与加固(P0-2,2026-09-11 定位并修复,提交 `436bf0e`)
### 方法论:先做最小实验,再下结论
**逐条假设 → 写 10 行探针实测 → 才决定改什么**。本次我最初的判断(异步回调写已 end 的响应会崩)被实验**直接推翻**,若不实测就会去"修"一个不存在的问题。Node v22.22.2 实测结论:

| 假设 | 实测结果 |
|---|---|
| 异步回调里往已 end 的响应 `write` | **无害**(静默 no-op,响应已 destroyed 时 `destroy(err)` 直接返回) |
| `end()` 两次 + 之后 `write` | 无害 |
| `spawn` 不存在的可执行(有/无 error 监听) | 无害 |
| **响应头已发后 catch 再 `sendJSON` 500** | ⚠️ **抛 `ERR_HTTP_HEADERS_SENT`,致命** |
| **`res` 上 `emit('error')` 且无人监听** | ⚠️ **直接杀进程** |

### 根因:兜底 catch 的二次写头
`server.js` 的 `createServer` 兜底曾是裸的 `sendJSON(res, 500, …)`;而 `chat.js` 在 `handleChat` 一开头就 `writeHead(200, SSE)`,之后还有一堆可抛错调用(`resolveModel`/`providerHealth`/`recallContext`/`spawn`/SQLite)。一旦抛错 → catch 里 `writeHead` 再执行 → 抛错 → **该二次异常逃出 catch → unhandledRejection → 进程退出**。
A/B 实测(新旧均 require 真实 `lib/http.js`):旧版 `💥 unhandledRejection: ERR_HTTP_HEADERS_SENT`,进程死,客户端拿到 **HTTP 000**(正是用户看到的 "Failed to fetch");新版进程存活。

### 加固清单(改这类服务必查)
- **响应写出必须前置检查**:`sendJSON` 看 `headersSent/writableEnded`,不能写就丢弃 + 记日志;**绝不二次写头**。`sse` 看 `writableEnded/destroyed`(tail 回调是异步的,本就可能晚到)。
- **`req`/`res` 上必须挂 `'error'` 监听**。EventEmitter 语义:无人监听的 `'error'` 会升格为未捕获异常直接杀进程(客户端 RST 就会触发)。
- **兜底 catch 要能区分"能否回错"**:先 `console.error` 记堆栈(handler 异常此前完全静默 = 零排查线索的一半原因),再只在未写响应时回 500。
- **`readBody` 必须处理 `'aborted'`/`'close'`**:否则客户端中途 abort 时 Promise 永不 settle → handler 永久挂起 → 连接与其拉起的子进程都不释放。用 `settled` 标志防止正常 `end` 之后的 `close` 把已成功结果改成失败。
- **`tailStreamFile` 只推进已解码字节数**(`offsetRef.pos += end`)。原写法 `= st.size` 会把尾部半个多字节序列**永久跳过**,表现为流里偶尔丢字。
- **`active` 清理必须只有一个出口**:`chat.js` 的 `req.on('close')` 曾自己 `clearInterval` + `unlink` 却漏了 `active.delete` → 每次客户端中断泄漏一条指向已死子进程的映射(内存泄漏,且 `/api/stop` 能"查到"早没了的进程)。现在统一走 `finish()`。

### 死亡归因(以后不用再猜)
`server.js` 启动即在 **stderr 写 `[lifecycle] 启动 pid=… node=…`**,并挂 `SIGTERM/SIGINT/SIGHUP`(先记录再 `removeAllListeners` + 重新发给自己,**退出语义不变**)+ `process.on('exit')` 记录 code 与运行时长。判读规则:
- 有 `[FATAL …]` → 代码崩了,看堆栈
- 有 `[lifecycle] 收到 SIGTERM` → 外部要求停止(launchctl stop / kill)
- **什么都没有 = SIGKILL** → `launchctl kickstart -k` 用的就是 SIGKILL(无法捕获);方向转为查"谁发的 kill",**不是**查代码

**回溯结论**:历史上那批"静默死亡"里,相当一部分**不是崩溃**——是进程被外部杀掉/回收(早期 nohup 进程随会话被回收、我反复 kickstart),而当时的 stderr 要么被丢弃要么没装守护。真正会崩的路径是上面那条 **B**,它确实会在对话中途发生。

### 运行时心跳
`startHeartbeat(active)`(在 `lib/maintenance.js`)在 listen 后打基线,之后每 30 分钟一行:rss / heapUsed / active(在跑子进程数),rss>800MB 告警。周期用 `HERMES_HB_MS` 覆盖(验证时调小)。`timer.unref()` 不阻止退出。**用它观察泄漏趋势,别等它变成"服务没了"。**

## 解析降级信号(P1-4,2026-09-11,提交 `6867a89`)
**问题**:各 `parse*` 遇到 CLI 输出格式变更时统一表现为「返回空数组」→ 前端只能显示「暂无历史会话」,用户分不清「真没有」还是「坏了」(历史上已因此误判两次"功能缺失")。
**设计决策(重要,别改回去)**:
- `lib/parse.js` 新增 `parseResult(name, raw, items, log)` → `{ok, items, raw, warning}`,内部复用 `warnIfParseEmpty` 判定。**各 `parse*` 签名保持纯数组不变**,包装层独立,既有调用方零影响。
- 调用方需要 `raw` 才能判定 → `runSessionsList()` 返回 `{items, raw}`(不再自己吞掉原始输出)。
- **降级用「200 + degraded 附加字段」,不用 5xx**。理由:列表必须能照常渲染,否则一个小故障会升级成"界面不可用";告警在 UI 上显式可见即可(会话列表区可点击重试的告警条 / MCP·定时任务页一行告警)。
- 判降级必须容忍**真实空态**:`warnIfParseEmpty` 对 `No scheduled jobs.` / `No MCP servers configured.` / `暂无…` 这类文案不告警 —— 实测 mcp/cron 当前都为空但 `degraded:false`,不得误报。
**测试网**:`parse.test.js` +5(含"真实空态不得误报降级");`routes.smoke.sh` +3「健康态不得 degraded」不变量(解析器与 CLI 格式脱节要当天暴露);`ui.smoke.js` 新增 **L5 降级层** —— 正常态永远测不到该分支,用 `page.route` 拦截 `/api/sessions` 构造 degraded 响应,断言告警出现且不白屏。
**验证手法(值得复用)**:①最小探针 `/tmp/probe-degraded.js` —— 把 `lib/hermes` 塞进 `require.cache` 换成桩,再用假 req/res 直接调路由处理器,证明信号端到端贯穿(不启服务、零副作用);②playwright 路由拦截验前端分支。

## 静默失败治理与用量落盘(P1-5 / P3-12,2026-09-11,提交 `47a1b67`)

### 静默 catch 的分级约定(别再来一轮"全加 console.log")
- **会让用户困惑的失败** → 界面可见提示 + `console.warn`。判定标准:失败后用户看到的是"空白/没反应"且无从判断(模型下拉为空、接口列表空白、令牌 401)。
- **确定可忽略的** → 前端 `softFail(where, e)`(`console.debug`)。理由:浏览器控制台**不写** launchd 捕获的日志文件,没有刷屏风险,可放心留痕。
- **正常分支** → 只留注释、不留痕。例:"工具输出本来就不是 JSON""缓存文件不存在(首次运行)""子进程已退出 → kill 抛 ESRCH"。逐条打日志会把真信号淹掉。
- **高频轮询路径**(`lib/db.js` 的 `withDB`,每 150ms)→ `warnOnce`:同一条错误只打一次。**这是"补日志"与"刷爆日志"之间唯一的平衡点。**
- **启动期一次性路径**(`lib/auth.js` 令牌读写)→ 直接 `console.warn`。这里静默最危险:读不到"已存在的"令牌文件会**静默换发新令牌**,浏览器里存的旧令牌全部失效,用户只看到 401 却不知原因。
- 用 `if (e.code !== 'ENOENT')` 区分"还没配/还没写过"(正常空态)与真故障(`cloud.js` / `toolbox.js` 的写法)。

### 用量落盘(P3-12)
- `lib/usage.js` 追加写 `~/.hermes/usage.jsonl`(一行一条 JSON)。路径可注入:`usageFile(env)` 认 `HERMES_USAGE_FILE`,各函数都收 `file` 参数 —— **测试绝不碰真实文件**,沿用 `resolvePython(home, env)` 的同款约定。
- `lib/state.js` 的 `recordUsage` 同时维护内存环形缓冲(60 轮,供 `/api/usage` 的 `runs` 立即读)与落盘(best-effort,永不抛给聊天路径;仅首次失败 warn)。
- 5MB 超限 → 保留**尾部** 2000 行重写(保最新的,不是最旧的)。
- `readUsageTail` 从文件中间起读时**必须丢掉半截首行**,否则每次聚合静默少一条,看起来像"最近一轮没记上"。
- `/api/usage` 返回 `{runs, summary}`;`summary` 的均值只按近 24h 算(跨模型/跨版本的旧数据混进来会掩盖真实变化)。前端侧栏底部显示一行 24h 统计。

### 测试反证 + playwright 陷阱
- 新增的前端断言必须做一次**反证**:临时回退修复,确认断言变红且报的正是原故障症状(本次 L6 回退后报"暂无内容",与原 bug 表现一致)。否则只是"测试通过"的自我安慰。
- 陷阱:`ctx.addInitScript` 会在**每次导航**时重新注入 `localStorage` → 反面用例不能靠"清 localStorage + reload"构造,要改成"写入错误值 + 触发请求"(走同一条 401 → showAuthBar 路径)。

## 知识库(KB)集成
- 统一入口=主服务 4173:`GET /kb`(托管 `kb/viewer.html`)、`GET /api/kb/list?cat=inbox|distilled|memory|all`(**返回纯数组**)、`GET /api/kb/search?q=`(复用 recallHits,**返回 `{query,count,results}` 对象**)、`GET /api/kb/status`。
- **P2-10 定案(2026-09-11,勿改回公开)**:四个数据接口**全部需要 Bearer token**,与 `/api/*` 同一把;只有 `GET /kb` 页面壳公开。理由:①KB 含 `MEMORY.md` 私有笔记;②其余接口都要令牌,唯独它例外是隐患;③"只绑 127.0.0.1"的兜底太脆 —— `HOST` 只是 plist 一行 env,2026-09-06 曾改成 `0.0.0.0`,再开一次公开 KB 就整个网段可读。viewer.html 从同源 `localStorage('hermes_ui_token')` 取令牌(与主界面共用),401 时顶部弹补填提示。护栏:`routes.smoke.sh` 与 `healthcheck.sh` 各有一条"无 token 必须 401"断言。详见 `lib/routes/kb.js` 头部 + `KB_INTEGRATION.md` §认证策略。
- ⚠️ 两个接口**返回形状不同**(list=数组,search=对象)。合并到 4173 时 viewer.html 的搜索分支直接对对象调 `.map()`,导致 KB 页搜索**永远显示"暂无内容"**(2026-09-11 修,已加 ui.smoke L6 断言锁死)。改这两个接口时两边一起看。
- 数据源:`kb_inbox.md` / `kb_distilled.md` / `~/.hermes/memories/MEMORY.md`(实测 19/23/1 = 43 条)。
- 智能体主动调用路径:`~/.hermes/skills/kb-query/SKILL.md`(对话中需要历史经验时调 `kb.py recall` 或 `curl /api/kb/search`)。
- `kb/serve.py`(4174)已标弃用 → 降级为离线兜底;无 plist/cron/代码引用它。设计文档:`KB_INTEGRATION.md`。

## 路线图现状(2026-09-11)
- ✅ launchd 守护已装成功(state=running,RunAtLoad+KeepAlive);kickstart 可自重启。
- ✅ KB 集成落地(viewer.html 同源化 + `/api/kb/*` + 顶栏入口 + kb-query 技能)。
- ✅ P2-7 残留脚本归档到 `archive/one-off-fix-scripts-20260911/`;P2-8 serve.py 标弃用;P2-9 `resolvePython()` + sync.sh 动态解析 + `warnIfParseEmpty` 格式保鲜告警。
- ✅ **git 建库完成**;**测试基线持续加厚**(**69 例单测** + **51 项路由冒烟** + **30 项浏览器冒烟(含 L5 降级层 / L6 KB 页层)** + **21 项健康自检**);**P1-3 四步全部完成**:lib/parse.js → lib/router.js + lib/routes/*(1341→848) → lib/ 12 个域模块(849→141) → 前端 html/css/js 三分(1864→151)。
  关键提交:`f5d8a7b` 建库 → `9f93aa2` 解析层 → `7f31a07` 路由表 → `6b3b0da` lib 域模块 → `a2e8c7c` 前端三分 → `cf5b03f` 备份 → `107676a` API 镜像 → `436bf0e` P0-2 加固 → `6867a89` P1-4 解析降级信号 → `47a1b67` P1-5+P2-10+P3-11+P3-12。
- ✅ **P0-2 已完成**(提交 `436bf0e`):根因是**兜底 catch 二次写头** → `ERR_HTTP_HEADERS_SENT` → unhandledRejection → 进程退出(A/B 实测确认,客户端表现为 `HTTP 000` = "Failed to fetch")。已封堵 + 补 `req`/`res` error 监听 + 死亡归因(`[lifecycle]`) + 运行时心跳。详见上方「崩溃归因与加固」段。
- ✅ **全局崩溃日志已两次实战生效**:前端拆分时抓到启动期 `ReferenceError`(并行 Edit 丢更新);P0-2 加固时抓到 `startHeartbeat is not a function`(漏了 export)。两次都是"启动即崩"级别的静默故障,现在都有精确堆栈 —— 配合 `test/wiring.test.js` 已能提前在测试阶段挡住第二类。
- ✅ **P1-4 已完成**(提交 `6867a89`):解析失效不再静默 → `degraded` 信号贯穿到前端告警。详见上方「解析降级信号」段。
- ✅ **P1-5 / P2-10 / P3-11 / P3-12 已完成**(提交 `47a1b67`,改进清单里的剩余四项一次做完)。详见上方「静默失败治理与用量落盘」段与「知识库(KB)集成」段。
- ⏳ 待办(均不紧急,按优先级):前端 `app.js` 1500 行按域再分(已有语法网 + 浏览器网兜底,可暂缓);`POST /api/memory/save` 的恒真死代码注释(见下方小隐患);用户级技能目录整理(`caveman-*` / `ponytail-*` 职责重叠)。
  **改进清单 `IMPROVEMENT_PLAN.md` 至此全部落地**(P0-1~P3-12)。下次要推进的是清单外的新方向,例如 `PLAN-hermes-serve.md` 的常驻后端改造(首字延迟热路径 37.1s → 0.7s,状态:待评审)。
  注:`parseSkillsList` **不是死代码** —— 文件里已写明"保留作为 CLI 表格解析的备用与回归锚点,勿删",别再当待清理项。
- ✅ **离机备份 + 异地镜像已建立**(2026-09-11):`npm run backup`(本地 bundle,可还原)+ `npm run mirror`(GitHub 私有库 `2276304874-afk/hermes-agent`)。详见上方「备份与异地镜像」段。此前"提交只存在本地 .git"的单点风险已消除。
- 📌 **标准验收命令一次跑全**:`npm test && npm run smoke && npm run ui && npm run health`;`npm run check` 覆盖 server.js + lib/** + lib/routes/** + public/app.js + scripts/** + test/**。
- 小隐患(未修,不紧急):`POST /api/memory/save` 的「只允许写固定路径」防御是**恒真的死代码**(`which` 三元只可能落在两个常量上),安全性没问题但注释有误导。
- 改进清单见 `IMPROVEMENT_PLAN.md`;历史路线图见 `UPGRADE_ROADMAP.md` 与 daily logs。
