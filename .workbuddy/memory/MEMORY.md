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
- test173/smoke53/ui62/health31/safety6/stop9/chat6。`npm run check`退出0。本地`node --test test/*.test.js`。`npm run ui`依赖`$HOME/.hermes/ui_token`,手敲漏传假报401。

## 持续项
- hermes升级复查:技能改名复原/原生能力仍成立/num_ctx六处对齐。KB:`/api/kb/*`全需Bearer。原生`curator`需`adopt`才管我们的技能(agent-created仍=0)。
