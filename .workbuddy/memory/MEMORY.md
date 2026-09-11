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
- **分层现状**(2026-09-11 第二步后,提交 `7f31a07`):
  - `server.js` 848 行 —— 只剩 helper 定义 + 启动自检 + **路由装配** + listen。
  - `lib/router.js`(约 60 行)—— 极简路由表。**刻意保留原语义:顺序遍历、首个命中即处理、前缀匹配**。禁止换成精确匹配路由(会静默改行为,如 /api/health 要吃掉 query string)。
  - `lib/parse.js`(177 行,纯解析层,零副作用)。
  - `lib/routes/*.js` 7 个模块:`kb`(公开4+认证1) / `session`(5) / `system`(5) / `provider`(5) / `media`(4) / `chat`(2,含 handleChat) / `toolbox`(13) = **认证 35 + 公开 4 = 39 条,与原 if 链分支数逐条对上**。
  - `ctx` 显式依赖袋:路由模块只允许用登记在案的东西。**新增 helper 供路由用 → 必须同时加进 ctx,否则运行期 ReferenceError**(踩过:`warnIfParseEmpty` 留在 server.js 供 `runSessionsList` 用,却从 require 里删了)。
  - 装配顺序即匹配优先级,**改动必须保持**:公开组 → 静态文件 → 认证闸门(`/api/*` 无 token 401) → 认证组 → 兜底 404。`patchState` 必须定义在 ctx 之前(否则 /api/health 踩 const TDZ)。
  - **下一步(第三步)**:把 helper 按域拆进 lib/ —— config / http(sendJSON,sse,readBody,serveStatic) / auth / hermes(runHermes,hermesEnv,oneshot补丁) / db / ollama(含多模态) / cloud(resolveModel,providerHealth) / kb。拆完 ctx 可退场。
- **测试三步曲**(改完代码的标准流程):
  1. `npm test` —— `test/parse.test.js` 22 例,node:test 零依赖。fixture 必须标 `[真实]`(抄自本机 CLI 实际输出)/`[合成]`(按已知格式构造)。
     - ⚠️ 本机 node 22.22.2 的 `node --test <目录>` 会被当成模块路径 → 必须写 `node --test test/*.test.js`。
  2. `bash test/routes.smoke.sh` —— **44 项路由清单冒烟**(`npm run smoke`)。判据不是 200 而是**命中**:400/401/404(业务) 都算通过,只有落到兜底 `not found` 才说明路由丢了。全部请求走参数校验分支,**零副作用**(不建 cron/不装技能/不写记忆/不删会话)。支持 `HERMES_TOKEN=x bash test/routes.smoke.sh 4199` 打备用端口。
  3. `bash healthcheck.sh` —— 19 项服务级自检(`npm run health`),退出码 0/1。
  最后 `git commit`;需要生效时 `launchctl kickstart -k gui/$(id -u)/com.hermes-agent.ui`。
- **启动日志可核对项**:`路由登记:公开 N 条 / 认证 M 条`(漏登记立刻可见)、`KB 解释器:<path>`(路径腐烂可见)、`流式补丁:…`(oneshot 自愈状态)。

## 模型与 Ollama
- **主模型(2026-09-10 起):`hermes-local-gemma4`**(base `gemma4:e4b`,PLE 稀疏激活,9.6GB 盘 / ~3.3GB 驻留,128K ctx,原生 tools+vision+audio)。**一个模型同时扛对话/工具/视觉/音频**,已不再需要 llava 换载。
- Ollama.app(GUI)托管,max_loaded_models 默认 1。
- ⚠️ **绝不给工具型 agent 关 CoT**:在 Hermes `/v1` 上 `think:false` 被忽略,只有 `reasoning_effort:"none"` 生效;而关掉后小模型会**只说不做**(嘴上"已记录",`messages.tool_calls` 实为空)→ 记忆功能假死。曾踩过并回滚。
- Vision:`/api/vision`(llava:7b 为旧路径),请求级 keep_alive 30m。llava 冷加载/换载 12s~4min 波动(page cache 决定)。
- 16G 内存:多模型同驻被 macOS 权限挡(`launchctl setenv` Not privileged);GUI Ollama 菜单设置或 root 可解。

## 工程纪律(血泪教训)
- **永不并行 Edit 同一文件**(竞态丢更新)。
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
- ✅ P2-7 残留脚本归档到 `archive/one-off-fix-scripts-20260911/`;
- ✅ P2-8 serve.py 标弃用;P2-9 `resolvePython()` + sync.sh 动态解析 + `warnIfParseEmpty` 格式保鲜告警。
- ✅ **git 建库完成**(3 次提交 `f5d8a7b` → `9f93aa2` → `7f31a07`);**P1-6 测试基线完成**(22 例 + 44 项路由冒烟);**P1-3 第一步完成**(lib/parse.js)、**第二步完成**(lib/router.js + lib/routes/*,server.js 1341→848 行)。
- ⏳ 待办:**P1-3 第三步**(helper 按域拆 lib/) / P0-2 崩溃根因(等复现) / P2-10 KB 认证决策 / `index.html` 抽 app.js / `parseSkillsList` 死代码待清。
- 小隐患(未修,不紧急):`POST /api/memory/save` 的「只允许写固定路径」防御是**恒真的死代码**(`which` 三元只可能落在两个常量上),安全性没问题但注释有误导。
- 改进清单见 `IMPROVEMENT_PLAN.md`;历史路线图见 `UPGRADE_ROADMAP.md` 与 daily logs。
