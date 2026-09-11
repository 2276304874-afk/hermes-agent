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
- **测试四步曲**(改完代码的标准流程):
  1. `npm test` —— `test/parse.test.js` 22 例 + `test/cloud.test.js` 7 例 = **29 例**,node:test 零依赖。fixture 必须标 `[真实]`(抄自本机 CLI 实际输出)/`[合成]`(按已知格式构造)。
     - ⚠️ 本机 node 22.22.2 的 `node --test <目录>` 会被当成模块路径 → 必须写 `node --test test/*.test.js`。
     - `cloud.test.js` 的重点是**回退语义**:未知本地模型名 → `DEFAULT_MODEL`;不完整 `cloud:` 串 → 回落本地(否则拿空 model 请求云端)。这两条回归后现象是"选某模型就失败",日志看不出根因。
  2. `bash test/routes.smoke.sh` —— **44 项路由清单冒烟**(`npm run smoke`)。判据不是 200 而是**命中**:400/401/404(业务) 都算通过,只有落到兜底 `not found` 才说明路由丢了。全部请求走参数校验分支,**零副作用**(不建 cron/不装技能/不写记忆/不删会话)。支持 `HERMES_TOKEN=x bash test/routes.smoke.sh 4199` 打备用端口。
  3. `node test/ui.smoke.js [port] [token]` —— **前端浏览器冒烟(22 项)**(`npm run ui`)。无头 Chrome 实际加载页面,四层判据:L1 传输(200+MIME) / L2 执行(看版本戳是否被服务端替换,证明 app.js 真跑了) / L3 渲染(CSS 变量可读、关键 DOM 非零尺寸、注入 token 后登录遮罩隐藏) / L4 健康(零 pageerror、零 console.error、零 4xx)。
     - 实现关键:**用 `playwright-core` + `executablePath` 指本机已装 Chrome**,不下载浏览器。playwright-core 在 `~/.workbuddy/binaries/node/workspace/node_modules`(脚本内有多路兜底,不依赖 NODE_PATH)。二者缺一时打 SKIP 退 0,但明确标注"前端未经验证"。
     - 踩坑:资源类 console.error 的**文本里不含 URL**(只有 `Failed to load resource ... 404`),只按文本做 favicon 白名单会误判 → 必须同时取 `m.location().url`。
  4. `bash healthcheck.sh` —— 19 项服务级自检(`npm run health`),退出码 0/1。
  最后 `git commit`;需要生效时 `launchctl kickstart -k gui/$(id -u)/com.hermes-agent.ui`(前端三文件实时读盘 + no-cache,改完刷新即可,无需重启;只有改 `lib/` 才需 kickstart)。
- **启动日志可核对项**:`路由登记:公开 N 条 / 认证 M 条`(漏登记立刻可见)、`KB 解释器:<path>`(路径腐烂可见)、`流式补丁:…`(oneshot 自愈状态)。

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

## 知识库(KB)集成
- 统一入口=主服务 4173:`GET /kb`(托管 `kb/viewer.html`)、`GET /api/kb/list?cat=inbox|distilled|memory|all`(**返回纯数组**)、`GET /api/kb/search?q=`(复用 recallHits)、`GET /api/kb/status`。均为公开只读(仅 127.0.0.1)。
- 数据源:`kb_inbox.md` / `kb_distilled.md` / `~/.hermes/memories/MEMORY.md`(实测 19/23/1 = 43 条)。
- 智能体主动调用路径:`~/.hermes/skills/kb-query/SKILL.md`(对话中需要历史经验时调 `kb.py recall` 或 `curl /api/kb/search`)。
- `kb/serve.py`(4174)已标弃用 → 降级为离线兜底;无 plist/cron/代码引用它。设计文档:`KB_INTEGRATION.md`。

## 路线图现状(2026-09-11)
- ✅ launchd 守护已装成功(state=running,RunAtLoad+KeepAlive);kickstart 可自重启。
- ✅ KB 集成落地(viewer.html 同源化 + `/api/kb/*` + 顶栏入口 + kb-query 技能)。
- ✅ P2-7 残留脚本归档到 `archive/one-off-fix-scripts-20260911/`;P2-8 serve.py 标弃用;P2-9 `resolvePython()` + sync.sh 动态解析 + `warnIfParseEmpty` 格式保鲜告警。
- ✅ **git 建库完成**(5 次提交 `f5d8a7b` → `9f93aa2` → `7f31a07` → `6b3b0da` → `a2e8c7c`);**P1-6 测试基线完成**(29 例单测 + 44 项路由冒烟 + **22 项浏览器冒烟** + 19 项健康自检);**P1-3 四步全部完成**:lib/parse.js → lib/router.js + lib/routes/*(1341→848) → lib/ 12 个域模块(849→141) → 前端 html/css/js 三分(1864→151)。
- ✅ **全局崩溃日志已证明有用**:`server.js` 头部的 `uncaughtException`/`unhandledRejection` 处理器 + `[FATAL ...]` 输出,在前端拆分时实测抓到过一次启动期 `ReferenceError`(并行编辑丢更新导致),把"静默死"变成了带完整堆栈的定位。P0-2「崩溃根因未定」由此降级为「已有捕获手段,等复现」。
- ⏳ 待办:P0-2 崩溃根因(等复现) / P2-10 KB 认证决策 / `parseSkillsList` 死代码待清 / 前端 `app.js` 1422 行可考虑按域再分(现在至少已有语法网 + 浏览器冒烟网兜底,比此前安全得多)。
- ✅ **离机备份 + 异地镜像已建立**(2026-09-11):`npm run backup`(本地 bundle,可还原)+ `npm run mirror`(GitHub 私有库 `2276304874-afk/hermes-agent`)。详见上方「备份与异地镜像」段。此前"提交只存在本地 .git"的单点风险已消除。
- 📌 **标准验收命令一次跑全**:`npm test && npm run smoke && npm run ui && npm run health`;`npm run check` 覆盖 server.js + lib/** + public/app.js + scripts/**。
- 小隐患(未修,不紧急):`POST /api/memory/save` 的「只允许写固定路径」防御是**恒真的死代码**(`which` 三元只可能落在两个常量上),安全性没问题但注释有误导。
- 改进清单见 `IMPROVEMENT_PLAN.md`;历史路线图见 `UPGRADE_ROADMAP.md` 与 daily logs。
