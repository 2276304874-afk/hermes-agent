# 赫尔墨斯特工 · 长期项目记忆

## 架构与服务
- UI `server.js`(零依赖,node22)由 launchd `com.hermes-agent.ui` 托管,端口4173,绑127.0.0.1;`launchd/com.hermes-agent.ui.plist`真源;`bash setup.sh`部署/自检。Bearer token `~/.hermes/ui_token`(0600)。
- launchd边界:`bootstrap/load` 在我 shell必EIO5 → 用户须先在Terminal.app跑一次`setup.sh`;注册后`launchctl kickstart`我可用。
- 引擎 Hermes CLI(`~/.hermes/venvs/hermes/bin/hermes`)调用必`env -u PYTHONPATH`+`NO_PROXY=127.0.0.1,localhost`。进度:`server.js`每150ms轮询`~/.hermes/state.db`+流式补丁。

## chat后端:gateway(选项B)
- `hermes gateway run`常驻+`api_server`适配器(OpenAI兼容)。⛔禁`hermes serve`(静默不注册safety hook)。配置`~/.hermes/config.yaml`:`gateway.platforms.api_server.{enabled:true, extra:{host:127.0.0.1, port:8642, key:≥16位}}`,key=Bearer。`host`禁0.0.0.0。
- Node`lib/gateway.js`:`POST .../api/sessions`(顶层非/v1)→`chat/stream` SSE。state.db轮询`newMessages()`权威。gateway标题全局唯一→`prompt.slice(0,32)+' #'+runId.slice(0,8)`;错误须带body抛出。空闲看门狗默认5min(`HERMES_STREAM_IDLE_MIN`)。
- 危险命令放行:`lib/safety.js`写`ui_bypass_sessions.json`(秒级时间戳,仅`allowDangerous`时);单位秒,写毫秒=永久放行。浏览器不得直连:8642。

## 技能加载(渐进式,勿造轮子)
- 索引只注入`- name: description`,全文靠`skill_view(name)`命中后读。SKILL.md正文0.91MB/192技能,注入~3750 token(占system 24%)。索引字节一变⇒prompt cache前缀失效;命中率瓶颈是description质量。自建检索层门槛>500技能。

## 上下文预算红线★★★
- 主模型`hermes-local-gemma4`(gemma4:e4b,num_ctx 32768)。窗口真源=六处(context_length/extra_body.num_ctx×model&provider+model_overrides)全对齐32768。system27K+tools37K+索引14K≈17K tok起步,32K仅够用。关`micro_compact`(每回合破cache)。改system prompt前必算预算。

## 检查点回退+停止裁判★★★
- `checkpoints.enabled:true`唤醒(官方默认关);影子库`~/.hermes/checkpoints/store`(跨项目去重,不碰项目.git)。`/rollback`在Web链路到不了(gateway api_server不派发斜杠命令)→Node自实现。
- 两道守卫缺一不可:workdir须已注册项目 + 提交须在该项目ref历史(merge-base)。`terminal.cwd`是触发前置(默认落$HOME→永不快照);config钉`terminal: cwd: <项目路径>`。
- 停止裁判=确定性判据(非LLM冷裁判):D1同调用重复≥3→warn;D2同调用同结果≥2→hard;D3工具调用>40→hard。只报告不中断(`HERMES_JUDGE_ABORT=1`才abort);高精度低召回。
- 配置真源在仓库外`~/.hermes/config.yaml`→换机不自动复现;已加`setup.sh`[2c]段幂等补写`checkpoints`/`terminal.cwd`(缺才写,先备份),healthcheck§10从报警变自愈。A2待用户Terminal跑`bash setup.sh`实测。

## 性能
- 首字延迟冷态~75s(物理成本=输入÷prefill),热态~24s。杠杆=cache命中率(关micro_compact 75.6→23.7s,3.2×)。测TTFT抓首个token事件,顶层早发占位msg(~240ms)不算。avgTokPerSec~17.5。

## 工程纪律(血泪)
- 前台Bash~120s硬SIGKILL(timeout无效)→>2min命令必`run_in_background`+日志重定向;`process.stdout.write`管道时块缓冲→长任务用`fs.writeSync(1,…)`。判活看进程`pgrep -f`+文件日志。
- 崩溃根因:catch二次写头→`ERR_HTTP_HEADERS_SENT`→退出。加固:sendJSON/sse前置`headersSent/writableEnded`;req/res挂error监听。
- 永不并行Edit同文件;plist禁XML注释;本shellbash`grep`可能静默空→用Grep工具;含中文bash`${VAR}`勿接全角。

## 备份与镜像
- `npm run backup:all`=项目bundle(落`WorkBuddy/_hermes-backups/`,非仓库内)+引擎`~/.hermes/state-snapshots/`。顺序:先commit再backup。
- `npm run mirror`=GitHub `2276304874-afk/hermes-agent`(private,REST API,因github.com:443阻)。每次整体重推~8min/~750调用,判据只看根树sha(提交sha两边必不同,因UTC归一)。别频繁推。

## 测试七张网(全绿才commit)
- test195/smoke54/ui66/health33/safety6/stop9/chat6。`npm run check`退出0。本地`node --test test/*.test.js`。`npm run ui`依赖`$HOME/.hermes/ui_token`,手敲漏传假报401。

## OpenClaw 借鉴清单落地(2026-09-13)
- ①技能 eligibility:实测前提不成立(194技能0平台门控/过滤仅省~17token)。真缺口=UI`scanLocalSkills()`未镜像引擎门控+**只扫一层**(漏64%嵌套技能),已递归+门控对齐。
- ②会话车道:两 backend 入口加409「会话忙」;前端必须补`resp.ok`检查(否则409被当流读→永久自旋)。
- ③KB混合检索:`recallHits` FTS5+向量(bge-m3,复用skills.js)文本去重取高分;阈值0.50(相关≈0.65/无关≈0.20)。
- ③性能坑(已修):`embedTexts`把整批塞进**一个**HTTP请求(超时120s),KB~1200块→指纹一变就全量重嵌=单请求阻塞数十秒;而`recallContext`在**每个新会话**都跑→"KB一变下次新会话首token被拖住"(实测症状:路由冒烟`/api/kb/search`+`/api/kb`双双15s超时52/2)。修法=`lib/knowledge.js`向量按**块内容哈希**缓存(KB_EMBED_FILE v2格式`{v:2,key,byHash}`),只嵌新块;含v1→v2自动迁移+并发去重+保存时按当前块剪枝。新增`test/kb-embed-incremental.test.js`。
- ④记忆沉淀:`state.db`持久化→**数据本不丢**,缺的只是时效(最坏30min)。新增`lib/kbflush.js`在compact/restore边界拉`kb/sync.sh --capture-only`(纯规则不调模型,免抢16G内存);sync.sh加原子mkdir单实例锁。⚠️含中文bash`${VAR}`勿接全角(锁竞争日志行曾因此unbound)。
- ⑤渠道契约:`lib/channel.js`=契约+注册表+参考适配器,**未接任何live路径**。安全决策编码进`assertAdapter`注册期校验:拒①非出站拉取(webhook)②`mayGrantDangerous:true`③缺任一必需闸门(allowlist/firstPairing/dangerousNotRelaxed/sessionLaneGuard/attachmentIsolation)。详见`docs/CHANNEL-STRATEGY.md`。
- ⑥stall降级:`lib/stall.js`纯函数(`stallConfig`/`failoverPlan`)+`handleChatGateway`重试循环。**默认关**:`HERMES_STALL_SEC`未设=不生效;`HERMES_FALLBACK_MODEL`备用模型。两硬边界=仅首token前降 + 备用模型必须已驻留(16G降冷模型代价更大)。文档`docs/gateway.md`§4.6。
- ⑥接线踩坑:轮询循环只启一次(getSessionId活闭包);换会话`stats.lastMsgId`归零;重跑标题带attempts后缀(gateway标题唯一);**必须`active.delete(旧sessionId)`**(否则永久409);每次尝试独立AbortController;stall掐流也走onDone须区分(否则轮询立刻finalize)。

## 持续项
- hermes升级复查:技能改名复原/原生能力仍成立/num_ctx六处对齐。KB:`/api/kb/*`全需Bearer。原生`curator`需`adopt`才管我们的技能(agent-created仍=0)。

## 本地模型内存画像(16GB Mac实测 2026-09-13)
- 常驻SIZE:qwen3:8b 7.4GB / gemma4:e4b 9.5GB / qwen2.5:14b & qwen3:14b 12GB(磁盘更小,含KV cache等运行时开销)。
- 16GB统一内存结论:8B单跑安全甜点(余量~4.6GB);14B单驻临界但实测可跑完(首token14-45s,总39-45s,不OOM);gemma4 9.5GB安全;**双≥8B同驻≈19GB>16GB→swap/OOM**,同一时刻只留一个≥8B常驻(Ollama自动驱逐最久未用)。
- function calling适配:四模型单轮均成功生成tool_call(✅),但单轮探针不回传工具结果→无法区分多轮编码质量;OpenCode式多轮需喂回结果再测。

## 跨 Agent 经验沉淀规范（2026-09-13 约定）
完成重要工作（修 bug/新功能/性能调优/重大决策）后，主动把可复用的行为模式按以下格式追加到 .workbuddy/kb_inbox.md 并运行 `python3 kb/kb.py build` 重建索引：
`### [zcode·行为模式] <时间戳> · <标题>` + 来源Agent / 工作目录 / 适用场景 / 标签(#标签) / 任务 / 关键行为模式（编号列表）。
这是用户的明确要求：调用其他 Agent 完成任务后，自动沉淀经验进知识库。
