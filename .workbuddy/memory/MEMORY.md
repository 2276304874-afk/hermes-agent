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

## 技能加载机制(2026-09-12 实测)★★
- **Hermes 已是渐进式加载(progressive disclosure),勿重复造"按需加载"轮子**。
  `~/.hermes/hermes-agent/agent/prompt_builder.py:1183 build_skills_system_prompt()`
  docstring 原文 "Compact skill index for the system prompt";`_render_skills_index()`
  只注入 `- name: description` 索引,全文靠 **skill_view(name)** 命中后读(tools/skills_tool.py,
  重复加载由 skills_tool_dedup.py 去重;已有 compact_categories 降级 + `[SKILL_PRUNED]` 重载)。
- 量化:`~/.hermes/skills` 磁盘 **43.8MB / 192 个叶子技能**(顶层目录 100)→ 其中 SKILL.md 正文
  仅 **0.91MB**,97.9% 是脚本/LaTeX/pdf 资源**永不进上下文**;实际注入的是 **15,000 字符 ≈ 3,750 token**
  (占 system prompt 15612 的 **24%**)。每技能成本:索引 ~20 token vs 全量 ~1,250 token ≈ **60:1**。
- ⚠️ 两条反直觉铁律:① **索引字节一变 ⇒ prompt cache 前缀失效**(实测 cache 100%→6.5s / 97%→34.7s),
  故任何"动态索引"必须保证字节稳定,否则反向劣化;② 命中率瓶颈是 **description 质量**不是检索算法(模型即路由器)。
- 孤儿文件 `~/.hermes/.skill_embeddings.json`(853KB,1024 维×66 条)**源码无消费者**、覆盖仅 34.4%,清理候选。
- 自建检索层的门槛是 **>500 技能**;本机 192,远未到。

## 性能基线(2026-09-12 02:00,`/api/usage` summary)
- **avgFirstTokenSec24h ≈ 45.25s**(最大体验痛点)· avgTokPerSec 17.5 · avgElapsed 28.5s · 18 轮全本地 · toolCallsTotal 仅 3。
- 模型**常驻**(hermes-local-gemma4 3.1GB,expires ~2h)→ **45s 不是推理冷加载**,延迟来自 Hermes agent 侧(createSession / 工具注册 / gateway 编排),需专门打点定位。

## 功能完备性盘点(2026-09-12)
- **多模态已闭环**(勿重复列为缺口):`/api/vision`(base64 图)/`/api/transcribe`(前端重采样 16k WAV)/`/api/upload`(JSON `{name,data:base64}`,非 multipart!)/`/api/suggest` 均接线可用,已 curl 实测通过。入口:`#imgBtn`/`#fileBtn`/`#micBtn`。
- **工作区模块已闭环**:list/create/**rename**/delete/assign + 会话侧 📁 移动选择器。
- ⚠️ **模式开关「快速/思考」是纯 UI 折叠**,`chatMode` 只控制 `.reason` 展开与否,**不下传给模型**(刻意如此:关 CoT 会让小模型只说不做)。存在语义误导风险——需要产品决策而非顺手接线。

## 代码结构与工程化
- git on `main`。`.gitignore` 忽略 kb.db/kb_*_state.json 等;**kb_inbox.md/kb_distilled.md/memory/ 必须入库**。
- **异地镜像已通(2026-09-12 22:34 首次完整推送)**：`npm run mirror`(REST API,因本机 github.com:443 被阻断)。远端 `2276304874-afk/hermes-agent`(私有)HEAD=`565f41c`,根树 sha `8c520852` 与本地**逐字节一致**,57/57 提交树一致。⚠️ **提交 sha 两边必然不同**(GitHub 把提交时间归一 UTC,本地是 +0800,且差异沿 parent 链级联)→ **判断镜像是否最新只能比「根树 sha」**;`git status`/`branch -vv`/`origin/main..main` 全是结构性噪声(本地没有该 tracking ref,`fetch` 需要被阻断的 github.com:443)。判据写在 `scripts/push-via-api.js` 头部。
- `lib/` 域模块:config(单一真源,`WORKSPACE=path.resolve(__dirname,'..')`)/state(单例,**禁 new Map**)/http/auth/db/hermes/ollama/cloud/knowledge/skills/maintenance/parse/router/gateway/safety/usage/**checkpoints/stopjudge**。`lib/routes/*` **52 端点**。KB 检索逻辑=`lib/knowledge.js`(非 kb.js)。
- 前端三不变量:①head 内联主题+版本戳(不可外移);②`/app.js` 在 body 末不加 defer/async;③不改 ES module。`npm run check` 覆盖全部。
- **测试七张网**(全绿才可 `git commit`,2026-09-12 22:05 实测):`npm test`(node:test,**166**)/`npm run smoke`(路由 **53**)/`npm run ui`(浏览器 **62**)/`npm run health`(**31**)/`npm run test:safety`(hook **6**)/`npm run test:stop`(**9**)/`npm run test:chat`(契约 **6**)。⚠️ 本机 `node --test` 须写 `node --test test/*.test.js`(目录被当模块路径)。⚠️ `npm run ui` 依赖 `$HOME/.hermes/ui_token`;**手敲 `node test/ui.smoke.js` 漏传 token 会假报一片 401**,必须用 npm script。

## 模型与 Ollama
- 主模型 `hermes-local-gemma4`(base gemma4:e4b,128K ctx)。⚠️ 工具型 agent 勿关 CoT:仅 `reasoning_effort:"none"` 生效,`think:false` 被忽略;关后小模型只说不做→记忆假死。

## 工程纪律(血泪)
- **永不并行 Edit 同文件**(竞态丢更新;success 但内容没变=过期快照)。一消息块一文件一 Edit。
- ⚠️ **前台 Bash 有 ~120 秒硬上限**:超过即 SIGKILL(exit 137,输出丢失),工具参数里的 `timeout` **不生效**。任何预计 >2min 的命令(推送/备份/全量构建)一律 `run_in_background: true` + 输出重定向到文件,再读文件看进度。监控用的 `sleep N` 也受同一上限约束(实测 `sleep 120` 被杀,`sleep 95` 安全)。
- ⚠️ **进程无声消失先怀疑「日志缓冲」而不是「逻辑卡死」**:stdout 被重定向/管道时是块缓冲,最后几十行不落盘 → 看起来"卡在某一步"。长任务脚本用 `fs.writeSync(1, …)`;判活要看**进程是否还在**(`pgrep -f`)+ 文件日志,不能只看日志末行。
- 进程存活查 `lsof -nP -iTCP:4173 -sTCP:LISTEN` + `/api/health` uptimeSec 递增;`launchctl print gui/$(id -u)/<label>` 核验注册(非 `launchctl list`)。
- 旧实例占端口→测新代码前务必重启(kickstart 愈孤儿 SSE 子进程)。
- plist 内 `<array>/<dict>` 禁 XML 注释(plutil 过,launchd EX_CONFIG)。
- 含中文 bash:`${VAR}` 勿写 `$VAR` 后接全角;`grep -c` 无匹配退出码 1,用 `F=$(grep -c x f 2>/dev/null); F="${F:-0}"`。
- ⚠️ **本 shell 里直接调 `grep`/`rg` 可能静默返回空**(实测同一文件同一模式,工具版 Grep 有命中、bash `grep` 却输出为空)——排查内容用 Grep 工具,别用 bash grep。另:`cat -A` 在 macOS BSD 不存在(只有 `-benstuv`)。
- ⚠️ zsh 里 `PIPESTATUS` 无效(应为小写数组 `pipestatus`);要拿退出码就别接管道,或 `cmd > f 2>&1; echo $?`。

## 崩溃归因(P0-2)
根因:catch 二次写头→`ERR_HTTP_HEADERS_SENT`→unhandledRejection→退出。加固:sendJSON/sse 前置 `headersSent/writableEnded` 检查;req/res 挂 error 监听;readBody 处理 aborted/close;active 清理单出口。死亡归因看 stderr `[lifecycle]` 行。

## KB 认证
`/kb` 页壳公开;`/api/kb/*` 全需 Bearer(同主令牌)。list 返回数组 / search 返回对象(形状不同,改时两边看)。

## 备份与镜像
`npm run backup`(本地 bundle,`git clone <bundle>` 还原);`npm run mirror`(GitHub `2276304874-afk/hermes-agent`,经 REST API 非 git push——本机 github.com:443 被阻断)。非 ASCII 路径用 `git ls-tree -r -z`。
- **镜像推送的成本与时长**:**每次整体重推,无增量**(提交 sha 不对齐,增量在 Git Data API 上无从谈起)——实测 723 次 API 调用、**约 8 分钟**(317 个去重 blob + 57 次提交建树)。所以别频繁推;改完一批再推一次。
- ⚠️ **别在前台跑**:执行环境对前台 Bash 有 **~120 秒硬上限**,超了直接 SIGKILL(输出还会丢),`timeout` 参数**不生效**。必须 `run_in_background: true` 且把日志**重定向到文件**,然后读文件看进度。
- ⚠️ **日志静默死亡陷阱**:`process.stdout.write` 在被重定向/管道时是**块缓冲**,进程中途死掉会表现为"日志停在某一行"→ 把「已死」伪装成「卡住」,排查方向全错。长任务脚本的日志一律用 `fs.writeSync(1, …)`。详见 `scripts/push-via-api.js` 头部。
- 本机 api.github.com 往返实测 **0.6s / 最慢 2.7s**(30 次序列探针,直连与走环境代理均 30/30 成功);环境有沙箱透明代理(`HTTP(S)_PROXY=127.0.0.1:54xxx`),但 **node 的 `fetch`(undici) 默认不读代理变量**,`gh`/`curl` 会读——排查网络时别把两者的行为混为一谈。

## agent 能力三件套（2026-09-12）
- selfcheck.js（网页自检：截图+console 错误，ok:true 才交付）/ repomap.js（仓库地图：目录+符号索引）/ code-review 技能（🔴🟡🟢结构化报告）——三个技能都在 ~/.hermes/skills/，脚本在项目 scripts/。
- 压缩续聊：/api/session/compact → lib/context.js pendingSummary 一次性注入；UI 入口在会话顶栏 #compactBtn。
- 项目上传：/api/upload 项目模式（防穿越、2MB/文件、16MB/项目）；前端 #projBtn webkitdirectory；后缀提示 hermes 跑 repomap。

## 上下文预算红线（2026-09-12 血泪）★★★
- 生产模型 hermes-local-gemma4 已重建为 **num_ctx 32768**（原 16384 被静态 prompt 吃满 → 工具结果一到用户任务就被逐出窗口 → 模型失忆写 hello-world/factorial 原型 demo，跨模型确定性复现）。加新工具/扩 system prompt 前必算预算：system 27K 字符+tools schema 37K+技能索引 14K ≈ 17K tok 起步，32K 只是够用，长会话仍需压缩续聊。
- hermes 的 HERMES_AGENT_HELP_GUIDANCE 会在技能索引含 "- hermes-agent:" 时注入「先 skill_view 加载元技能」指引——小模型会误触发。已改技能 frontmatter name 为 hermes-agent-docs 规避；hermes 升级后需检查是否复原（skills/autonomous-ai-agents/hermes-agent/SKILL.md，备份 .bak-hermes-meta）。
- launchd 服务的 PATH 不含 /opt/homebrew/bin：两个 plist 已显式注入 PATH，装新 CLI 工具（rg 等）后 agent 即可用。

## 原生能力审计清单（2026-09-12 实测，hermes 升级后需复查）★
- 给方案前先查原生子命令，勿重造轮子：hermes checkpoints（影子 git + /rollback，**2026-09-12 晚已唤醒并接进 UI**）/ curator（技能治理，需 adopt 才管我们的技能，agent-created 仍=0）/ backup（引擎侧 zip，不含项目源码）/ journey / usage / insights。
- 项目侧备份 = bash backup.sh（本地 bundle，同盘不防磁盘故障）；异地 = npm run mirror（REST API 推 GitHub；本机 github.com:443 阻、api.github.com 通）。**镜像已于 2026-09-12 晚首次推通**（远端 HEAD `565f41c`，57 提交）。

## 检查点回退 + 停止条件裁判（2026-09-12 晚落地）★★★
> 真源文档 `docs/checkpoints.md`；代码 `lib/checkpoints.js` / `lib/stopjudge.js` / `lib/routes/checkpoints.js`。
- **休眠真因是「官方默认关闭」**，不是坏了：`checkpoints_enabled: bool = False`（`run_agent.py:269` 构造默认），v2 起 opt-in。配 `checkpoints.enabled: true` 即唤醒（影子库落 `~/.hermes/checkpoints/store`，单个共享 bare git 库，跨项目按内容去重，不碰项目自己的 `.git`）。
- ⛔ **`/rollback` 在 Web UI 链路到不了**：gateway 的 `api_server` 适配器**不做斜杠命令分发**——发 `/version` 会被当**普通消息喂给模型**（模型还编了身份）。`/rollback` 只在 `_IDLE_COMMANDS` 里由平台管线派发（`run_busy.py:704`→`slash_commands.py:669`）。故 Node 侧自实现，**不要试图转发斜杠命令**。
- ★★ **两道守卫，缺一不可**（一次真实事故换来）：共享裸库让 store 里任何提交对**任何 workdir** 都 `cat-file` 可见，只检查"提交存在"就会把整个项目树 checkout 进无关目录（实测：对未注册的 `/tmp` 调 restore → 118 个文件写进 `/private/tmp`）。① workdir 必须是**已注册项目**；② 提交必须在**该项目自己的 ref 历史**里（`git merge-base --is-ancestor`）。
- ★★ **`terminal.cwd` 是检查点能触发的前置条件**（隐蔽耦合）：`$HOME` 与 `/` 是检查点**硬护栏**（永不快照），而 gateway 模式 agent cwd 默认落 `$HOME` → **快照永不触发**，同时还会往家目录乱写。已在 `config.yaml` 钉 `terminal: cwd: <项目绝对路径>`。⚠️ `-z --in` 不约束 terminal cwd → cwd 真源现在**有两处**。
- ⚠️ 路由必须**精确匹配**：`lib/router.js` 是前缀匹配 + 首命中即处理，`router.add('GET','/api/checkpoints',…)` 会吞掉 `/list` `/plan` `/diff` → 用 `(req) => req.url.split('?')[0] === '/api/checkpoints'`。
- ⚠️ 影子库 git 调用一律 `GIT_CONFIG_GLOBAL/SYSTEM=/dev/null` + `GIT_CONFIG_NOSYSTEM=1` + 清 `GIT_*` 泄漏——**不让使用者 gitconfig（gpg/hooks/credential helper）介入后台快照**。
- **停止条件裁判用的是确定性判据，不是审计推荐的 LLM 冷裁判**（诚实记录）：D1 同工具调用重复≥3→warn；D2 同调用且**返回正文完全相同**≥2→hard；D3 单 run 工具调用>40→hard。零额外模型调用/零额外延迟。换方案理由：① 本地 4B 自评不可靠，冷裁判可能一样乐观；② 每次 run 多几秒~几十秒，而首字延迟 45s 已是最大痛点；③ 可单测可复现。冷裁判作为独立"复盘"入口**未关闭**。
- **只报告不中断**（`HERMES_JUDGE_ABORT=1` 才 abort）；判据**高精度低召回**——误报会让提示失去信任（狼来了），故测试多数在验"不该报的都不能报"。严重度单调只升不降；同 code 只报一次。⚠️ 结果归因必须用 `lastSig`（Map 保插入序，重复调用老签名时它不在末尾）。
- **配置真源在仓库外**：`checkpoints.*` 与 `terminal.cwd` 写在 `~/.hermes/config.yaml`（含 gateway key，本就不该入库）→ **换机器重装不会自动复现**。防漂移 = `npm run health` §10 三条断言（terminal.cwd / checkpoints.enabled / 模块导出）+ hermes `state-snapshots`。"重装即复现"需在 `setup.sh` 加幂等补写，**尚未做**。

## 上下文预算的第二处坑（2026-09-12 晚实测）★★
- 改 Ollama 模型的 num_ctx 只解决一半：hermes 侧上下文窗口键若不同步，引擎仍按旧窗口算预算（tools/budget_config.py: budget_for_context_window，turn_budget = 窗口 30%，floor 16K 字符）。**实际是六处**（见文末「阶段一」章节）——原写「四处」有漏。改完必须用引擎解析路径复核，不能只看 config。
- `compression.micro_compact` 官方默认 False，源码注释明确「每回合重写历史、每回合破坏 prompt-cache 前缀」。我们的 prompt cache 命中率直接决定首字延迟（100%→6.5s / 97%→34.7s），故该键应保持关闭或 every_n_turns≥5。改这个键前先看 hermes_cli/config_defaults.py 的注释。
- 工程纪律新增：**配置写完必须验证产物存在**（文件/目录大小/行数）。checkpoints 0 B、curator agent-created=0、~/.hermes/backups 空目录、skills.preload 疑似无解析 —— 全是「写了配置没验产物」。

## 阶段一落地：配置真源 / 备份落点 / 断言（2026-09-12 21:35）★★★
- **上下文窗口真源 = 六处**（不是四处）：`model.context_length` + `model.extra_body.num_ctx` + `providers.<p>.context_length` + `providers.<p>.extra_body.num_ctx` + `model_overrides.<p>.<model>.context_window`（每个模型一条）。已全部对齐 32768。
- **验证必须打到引擎解析路径**，不能读配置：`get_model_context_length()`（gateway/run.py:2260 的解析口径）→ 返回 32768；`budget_for_context_window()` → 单条工具结果阈值 9,830→**19,660** 字符、单回合预算 19,660→**39,321**（各 2.0×）。healthcheck [9] 已加一致性断言防回退。
- **备份两轨的真实落点**（极易查错，审计就栽在这）：
  · 项目 bundle → **仓库的上级目录** `WorkBuddy/_hermes-backups/`，**不在仓库内**！在仓库根 `ls *.bundle` 会误判为「从未备份」。
  · 引擎侧 → `~/.hermes/state-snapshots/<ts>/`（含 state.db/config/auth/cron）。⚠️ `hermes backup --quick` **静默忽略 `-o` 参数**（无报错、无产物）。
  · 一键 `npm run backup:all`（scripts/backup-all.sh）：两轨 + 快照轮转（hermes 自身**不轮转**，会无限堆积，脚本默认留 5 份）。
- **config 里的 `cron:` 表不执行** —— 它由 hermes **常驻主进程**调度，而我们常驻的是 gateway（非 serve，安全红线）→ cron 表从不运行。凡依赖 hermes cron 的机制一律视为不生效（`daily_backup` 零产物即此因）。
- ⚠️ 顺序铁律：**先 commit 再 backup** —— bundle 只含已提交内容，未提交改动不进备份。
- 待用户确认（红区）：`npm run mirror` 推异地（github.com:443 阻，走 api.github.com REST）。
- **首字延迟有两个截然不同的态，别混为一谈**：冷态 ≈75s = 输入 token ÷ prefill 速率（gemma4 271 tok/s × ~20K 输入 ≈ 74s）—— **这是物理成本不是故障**，排查时勿误判；热态 ≈24s（prompt cache 部分命中）。唯一杠杆是 cache 命中率（关闭 micro_compact 后实测 75.6s → 23.7s，3.2×）。
- ⚠️ 测 TTFT 要抓第一个 `token` 事件时间；顶层会**早发一个占位 msg**（约 240ms），拿它当首字会得出错误结论。
