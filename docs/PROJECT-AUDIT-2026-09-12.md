# 项目整体审计与 MiMo-Code 对照 · 2026-09-12

> 本文档回答一个问题：**赫尔墨斯特工现在到底是个什么东西、卡在哪、下一步该做什么。**
> 所有结论都锚定到实测（命令、源码行号、运行时输出），不做主观推测。
> 与代码冲突时以代码与测试为准。
>
> **⚠️ 阶段一进展（2026-09-12 21:30 更新）**：§0-1、§0-2 两条已修复并实测验证（见各条尾部 `[已修]` 注记）；
> §6 表格中第 1、2 条同已落地。此外**更正一处事实错误**：§6 第 4 条「项目 bundle 从未生成」**不成立** —— 详见该行更正说明。

---

## 0. 三条实测结论（先看这个）

1. **模型侧已经好了，引擎侧还按旧尺子量。** Ollama 实载 `CONTEXT 32768`（`ollama ps` 实测），但 hermes 配置里 `context_length` / `context_window` / `num_ctx` **三处仍是 16384** → 引擎按 16K 窗口给工具结果分配预算，**有一半窗口被自己浪费**。
   **[已修]** 六处（`model.context_length`、`model.extra_body.num_ctx`、`providers.ollama.context_length`、`providers.ollama.extra_body.num_ctx`、两个 `model_overrides.*.context_window`）全部改为 32768；实测引擎解析值 = 32768，工具结果阈值 9,830 → **19,660 字符**（2.0×）、单回合预算 19,660 → **39,321 字符**（2.0×）。healthcheck 已加不变量断言防回退。
2. **首字延迟有一个被官方文档点名的元凶。** `compression.micro_compact: true` + `every_n_turns: 1` —— 官方源码注释原文：*"every pass rewrites sent history and **breaks the prompt-cache prefix EVERY turn**"*，默认值是 `False`。这与我们独立实测的「前缀命中 100%→6.5s / 97%→34.7s」完全吻合。
   **[已修]** 改回官方默认 `micro_compact: false`；同时更正了配置里那段**错误注释**（原文误称「本地模型无缓存成本，可放心开启」）。healthcheck 已加断言防回退。
3. **「配置已写、机制未跑」是全项目的系统性模式。** 双轨备份、检查点回退、技能治理、定时备份——四项配置齐全，**产物全部为零**。项目缺的不是功能，是**产物存在性自检**。
   **[部分修正]** 其中「双轨备份」一轨其实**有产物**（见 §6 第 4 行更正）；其余三项目前仍成立。已落地的对策：healthcheck 新增 `[8] 备份产物` 与 `[9] 引擎配置不变量` 两段共 7 条断言。

---

## 1. 核心目标与定位

**一句话**：一个完全本地运行的 AI 智能体工作台——浏览器界面 + 零依赖 Node 中间层 + Hermes CLI 引擎 + 本地 Ollama 模型。

**三条不可破的红线**（决定了大量"看起来该做但不做"的取舍）：

| 红线 | 具体含义 | 代价 |
|---|---|---|
| 不接云端 API key | 推理必须走本地 Ollama | 模型量级锁死（~4B），复杂任务做不了 |
| 不接外部记忆系统 | 排除 mem0 / seahorse / OpenViking | 长期记忆靠 MEMORY.md + KB 自建 |
| 只绑 127.0.0.1 | 不暴露局域网 | 无法多设备/远程访问（除非 SSH 转发） |

**目标演进三阶段**：能聊天（已过）→ 能干活（已过）→ **能自主干活（进行中）**。

---

## 2. 架构总览

四层，进程边界清晰：

| 层 | 组成 | 端口 / 托管 | 备注 |
|---|---|---|---|
| **界面层** | `public/{index.html,app.js,app.css}` | 由 UI 服务托管 | app.js 是 IIFE，全部逻辑 1994 行 |
| **服务层** | `server.js` + `lib/`（19 模块 + 8 个路由文件，**45 个端点**） | `com.hermes-agent.ui` → **4173** | 零依赖 Node 22，Bearer 令牌认证 |
| **引擎层** | Hermes CLI v0.21.0 | `com.hermes-agent.gateway` → **8642** | gateway 常驻 + api_server 适配器（OpenAI 兼容） |
| **模型层** | Ollama（`hermes-local-gemma4`，gemma4:e4b 派生） | **11434**，常驻 | num_ctx 32768，100% GPU，3.4GB |

**为什么是 gateway 而不是 serve**：`hermes serve` 静默不注册 safety hook（高危命令拦截失效）；gateway 在启动期注册 hook，安全不破且不碰 hermes 源码。

**双通道进度**：gateway SSE（`assistant.delta` 出 token）+ `state.db` 轮询（tool/reasoning 权威）。

---

## 3. 模块清单与职责

| 模块 | 职责 | 关键约束 |
|---|---|---|
| `lib/config.js` | 单一真源（路径、常量） | `WORKSPACE = path.resolve(__dirname,'..')` |
| `lib/state.js` | 可变状态单例 | **禁 `new Map`**，集中管理 |
| `lib/router.js` | 路由匹配（顺序 + 前缀） | 不引框架是刻意决定 |
| `lib/http.js` | 请求/响应工具、sendJSON/SSE | 必须前置 `headersSent/writableEnded` 检查（崩溃归因 P0-2） |
| `lib/auth.js` | Bearer 校验 | 令牌在 `~/.hermes/ui_token`（0600） |
| `lib/hermes.js` | `hermes -z` 保底后端 | 必带 `env -u PYTHONPATH` + `NO_PROXY` |
| `lib/gateway.js` | 主聊天后端（会话 + SSE + 空闲看门狗） | 标题必须全局唯一（重复 → 400） |
| `lib/safety.js` | 危险命令放行名单 | ⚠️ 时间戳**单位秒**，写毫秒 = 永久放行（已修 7 天上限） |
| `lib/autonomy.js` | 自主执行前导 + META_GUARD | 拼在用户 prompt 首部，**不动 system prompt**（护 cache 前缀） |
| `lib/context.js` | 压缩续聊（pendingSummary 一次性注入） | 取后即焚 |
| `lib/ollama.js` | 模型直连（视觉/转写/摘要/优化提示词） | — |
| `lib/db.js` | state.db 只读查询 | — |
| `lib/knowledge.js` | KB 检索 | list 返回数组 / search 返回对象（形状不同） |
| `lib/skills.js` | 技能增删查 | — |
| `lib/workspace.js` | 会话分组 | ⚠️ **不约束 agent 工作目录** |
| `lib/usage.js` / `lib/maintenance.js` / `lib/cloud.js` / `lib/parse.js` | 用量统计 / 维护 / 云降级 / 纯函数解析 | parse 零 IO 可单测 |

**前端三不变量**（不可违反）：① head 内联主题与版本戳不可外移；② `/app.js` 在 body 末、不加 defer/async；③ 不改 ES module。

**外围**：`hooks/safety_check.py`（fail-closed）、`launchd/`（3 个 plist）、`scripts/`（repomap / selfcheck / model-bench / push-via-api / gateway-probe）、`test/`（14 个测试文件）、`docs/`。

---

## 4. 关键功能矩阵

| 能力 | 状态 | 判据 |
|---|---|---|
| 流式聊天 + 工具轨迹 | ✅ | gateway SSE + 折叠胶囊（`npm run ui` 55 项） |
| 自主执行模式（三色权限） | ✅ | `docs/AUTONOMY_POLICY.md` + `test/autonomy.test.js` 6 例 |
| 高危命令拦截 | ✅ | `hooks/safety_check.py` fail-closed，`npm run test:safety` 6 例 |
| 多模态（图/音/文件） | ✅ | `/api/vision` `/api/transcribe` `/api/upload` 实测通过 |
| 项目级上传 | ✅ | 防穿越 + 2MB/文件 + 16MB/项目，E2E 实测 |
| 仓库地图 / 自检闭环 | ✅ | `scripts/repomap.js` / `selfcheck.js` + 3 个技能 |
| 压缩续聊 | ✅ | `/api/session/compact` E2E 3.2s |
| 工具轨迹折叠 | ✅ | 汇总胶囊 + 计数，playwright 端到端验证 |
| 上下文预算正确对齐 | ✅ | 09-12 21:30 修复：六处 32768，引擎解析值实测 = 32768（曾为 ❌，见 §6-1） |
| 文件级回退 | ✅（09-12 晚唤醒） | `hermes checkpoints` 已 live + `/api/checkpoints/*` 6 端点 + UI 面板；曾为 ❌（能力休眠，见 §8 P1-1） |
| 结构化任务清单 | ❌ | 任务只是 prompt 里的一串字符串（停止条件裁判未依赖它，见 §8 P1-2 的路线修正） |
| 停止条件判定 | ✅（09-12 晚落地，非原方案） | `lib/stopjudge.js` 确定性三判据 D1/D2/D3，只报告不中断；原推荐的 LLM 冷裁判未做，理由见 §8 P1-3 |
| 双轨备份 | ✅ | 项目侧 bundle **一直存在**（审计误判，见 §6 第 4 行更正）；引擎侧快照已补；两轨断言已加进 healthcheck |

---

## 5. 量化现状

| 指标 | 数值 | 来源 |
|---|---|---|
| JS 代码量（含测试） | 10,143 行 | `wc -l server.js lib/**/*.js public/*.js scripts/*.js test/*.js` |
| 前端 app.js | 2,207 行（IIFE 单文件） | 同上 |
| HTTP 端点 | 52 个 | `grep -c router.add lib/routes/*.js` |
| 测试基线 | **166 单测全绿** + 53 端点冒烟 + 62 UI + 31 health + 6 safety + 9 stop + 6 chat | 09-12 22:05 实测 |
| 技能库 | 192 叶子技能 / 43.8MB（SKILL.md 正文仅 0.91MB） | `ls ~/.hermes/skills` |
| 静态 prompt 开销 | system 27K 字符 + 工具 schema 37K + 技能索引 14K ≈ **17K token** | 今日排障实测 |
| 首字延迟 | avgFirstTokenSec24h ≈ **45.25s** | `/api/usage` |
| 生成速度 | 17.5 tok/s | 同上 |
| 模型实载上下文 | **32768**（100% GPU） | `ollama ps` |

---

## 6. ★ 核心发现：配置已写、机制未跑

这是本项目**最值得记住的一条模式**——不是功能缺失，是**写了配置但没有校验产物存在**。

| # | 配置/机制 | 期望 | 实测状态 | 后果 |
|---|---|---|---|---|
| 1 | `model.context_length` / `providers.ollama.context_length` / `model_overrides.*.context_window` / `extra_body.num_ctx` | 反映真实窗口 32768 | **[已修] 六处全部 32768**（引擎实测解析值 = 32768）；原为四处 16384 | `tools/budget_config.py: budget_for_context_window()` 原按 16K 算 → 工具结果预算被砍半、proactive prune 提前触发。**一半窗口白扔**；现已翻倍取回 |
| 2 | `compression.micro_compact: true` + `every_n_turns: 1` | 降低卡顿 | **[已修] 改回官方默认 `false`**（原为开启且每回合一次） | 官方源码注释：*"breaks the prompt-cache prefix EVERY turn"*，默认 `False`；与实测 6.5s→34.7s 吻合 → 曾是**首字延迟主要元凶之一** |
| 3 | `cron: daily_backup`（每天 02:00 复制 state.db） | 引擎侧每日快照 | `~/.hermes/backups/` **空目录**（建目录时间 09-10，零文件） | 引擎侧状态无备份 |
| 4 | `bash backup.sh`（项目 bundle） | 项目离机还原点 | ⚠️ **更正：bundle 一直都在** —— 输出目录是仓库的**上级** `../_hermes-backups/`（审计时实有 5 份，最新 09-12 21:01）。初查在**仓库根**执行 `ls *.bundle` 查错了路径 | 项目侧备份**存在**；真正的问题是「有产物、但无流程无断言管它」——现已加 healthcheck 断言 + `npm run backup:all` 一键双轨 |
| 5 | `npm run mirror`（异地镜像） | GitHub 异地 | `main` **无 upstream**，从未推送 | 唯一异地通道闲置；`mirror:dry` 实测可跑（277 文件） |
| 6 | `hermes checkpoints`（影子 git + `/rollback`） | agent 改文件前自动快照 | **[已修] 已 live**（547 KB / 5 提交 / 1 项目）；原为 0 B / 0 项目 | 真因是**官方默认关闭**（v2 起 opt-in），不是坏了；另需 `terminal.cwd` 钉在项目里否则 cwd 落 `$HOME` 触发不了。已接 UI，见 `docs/checkpoints.md` |
| 7 | `hermes curator`（技能治理） | 定期剪枝/合并/归档 | ENABLED、每 7d，但 **agent-created=0**（124 技能全判为 bundled）→ **零作用** | 技能治理形同未开；需 `curator adopt` 才纳管 |
| 8 | `skills.preload: [三个技能]` | 预加载降延迟 | 源码中**未见该键的解析逻辑**（疑似空转） | 至少是无收益配置，需实测确认 |
| 9 | `monitoring: prometheus :9090` | 指标可观测 | 未见抓取端 | 空转 |

**结论**：新增一条工程纪律——**配置写完必须验证产物**（文件、目录大小、行数），否则一律视为未生效。这与我们已有的「不查状态凭据就改参数必出错」是同一类教训。

---

## 7. 与 MiMo-Code 的对照

MiMo-Code = 小米对 `opencode` 的深度 fork（MIT，Bun/TS，终端 TUI），配套 MiMo 模型家族（MIT 开源权重）。**它的实现搬不动，它的设计可对齐。**

| 能力域 | MiMo-Code 的做法 | 特工现状 | 差距性质 | 结论 |
|---|---|---|---|---|
| 停止条件 | `session/goal.ts`：`/goal` 设条件，**独立裁判模型**只读对话判 `ok/impossible`，`MAX_GOAL_REACT` 限重入 | **[已落地]** `lib/stopjudge.js` 确定性三判据（**未采用冷裁判模型**，理由见 §8-P1-3） | 工程（已补） | ✅ 唯一真缺口已补，方案更省 |
| 上下文压缩 | `session/overflow.ts`：按有效窗口 **90%** 触发，`COMPACTION_BUFFER 33K`、`OUTPUT_CAP 20K`，`compaction.max_context` 按模型调 | `micro_compact`（**已改回关闭**）+ 手动压缩续聊 | 工程（已具备，未调准） | ⚠️ 先调参，别重造 |
| 检查点/回退 | `src/snapshot` + `session/revert.ts`（文件级逐轮回滚） | hermes 原生 `checkpoints`（影子 git），**[已唤醒]** + 自建 Node 读写层接进 UI | 工程（已具备，已启用） | ✅ 已做；`/rollback` 在 Web UI 链路到不了，故未走斜杠命令 |
| 结构化状态 | `checkpoint.md` 快照 + validator / retry / progress-reconcile 三件套 | 无；压缩续聊是一次性散文摘要 | 工程 | 🟡 最小版够用，勿抄三件套（过度设计） |
| 任务追踪 | 树状任务 T1/T1.1，与检查点联动，恢复不丢进度 | 无结构化任务表 | 工程 | 🟡 停止条件裁判已用确定性判据落地，**不再阻塞**；只剩摘要/进度载体价值 |
| 技能检索 | `tool/skill-search.ts`：精确名/别名 + **BM25 相关度** + 阈值自动加载 + 多技能编排 | 索引常驻 + 手动 `skill_view` | 工程（我们**刻意不做**） | 🟡 192 技能以下收益有限；瓶颈在 description 质量，不在检索 |
| 技能治理 | 内置技能 + 覆盖机制 + `MIMOCODE_DISABLE_*` | `hermes curator`（**未纳管**） | 工程（已具备，未启用） | ✅ `curator adopt` 即可 |
| 记忆沉淀 | `/dream` 扫轨迹提炼记忆、`/distill` 把重复流程打包成技能 | 手动写 MEMORY.md / 日志 | 工程 | 🟡 可做小工具，优先级低于前几项 |
| 权限模型 | glob 规则（`external_directory`）、**deny 优先**、ask **60s 超时自动拒绝**并回模型可读反馈、`--dangerously-skip-permissions` 在用户规则**下方**注入 `*` | 三色权限 + TTL **静默放行** + 7 天上限 | 设计取舍 | ⚠️ **只取「可读反馈」那一半**，超时语义保持放行（见 §8-P2-1） |
| 确定性编排 | `src/workflow`：沙箱内跑固定阶段 JS 脚本，内置 compose / deep-research / fact-check / research-experiment | `selfcheck` 已是雏形 | 工程 | 🟡 先不建引擎 |
| 多智能体 | build / plan / compose 三模式 + 子代理并行 + worktree | 单流 | 工程 | ❌ 不做（先补单代理的判定与回滚） |
| 模型层 | MiMo 家族 MIT 开源（7B 端侧 → 309B MoE → 1T+） | gemma4:e4b 派生（~4B） | **模型量级** | 🟡 可试，但 4B→7B 是改善不是跃迁 |
| 平台能力 | 云语音（TenVAD+MiMo ASR）、桌面端、Smart 调度、会话分享/同步 | 无 | 主动放弃 | ❌ 违背 local-first，明确不做 |

**一句话**：MiMo 的强项里，**一半是我们已有但没启用**（checkpoints / curator / 压缩参数），**一半是我们该主动放弃的**（云语音 / 多代理 / 平台化）；真正缺的只有「可判定的停止条件 + 结构化任务」这一条线。
→ 09-12 晚更新：其中**检查点已唤醒、停止条件已补**（后者用了更省的确定性方案，未走 MiMo 的独立裁判模型）；「结构化任务」降为可选项。**唯一真缺口已闭合。**

---

## 8. 可借鉴设计（分层 + 利弊 + 前提）

### P0 · 止血与算准（零新功能，纯收益）
> **✅ 阶段一已于 2026-09-12 21:30 完成 P0-1 / P0-2 / P0-3（③ mirror 除外 —— 红区待确认）。** 下方保留原始方案与利弊分析。

**P0-1 把上下文预算对齐到 32K** ✅ 已完成
- 做什么：把 `context_length`、`providers.ollama.context_length`、`model_overrides.*.context_window`、`extra_body.num_ctx` **四处**改成 32768，同步修掉那段已经过期的注释（"Modelfile 固定 num_ctx=16384"）。
- 实战补充：实际要改的是**六处**（`model` 与 `providers.ollama` 各含 `context_length` + `extra_body.num_ctx`）。验证方式不是看配置文件，而是跑 `get_model_context_length()` 拿到**引擎解析值**（实测 32768），再看 `budget_for_context_window()` 的产物（阈值 9,830→19,660 字符）。
- 利：立即拿回一半窗口；工具结果不再被过度截断；proactive prune 不再提前触发。**这是当前性价比最高的一改。**
- 弊与前提：16G 内存下 32K 是「够用不富裕」，长会话仍需压缩续聊；必须实测确认改动生效（`hermes prompt-size` / 一次真实长任务）。

**P0-2 关闭或降频 micro_compact** ✅ 已完成
- 做什么：`micro_compact: false`（官方默认），或保留但 `every_n_turns: 5`。
- 实战补充：已设为官方默认 `false`，并**更正了配置里那段错误注释**（原文误称「本地模型无缓存成本，可放心开启」）。官方 `every_n_turns` 默认本就是 1（源码 `config_defaults.py:566`），我们此前的问题在于同时开了 `micro_compact: true`。
- 利：每回合不再重写历史 → prompt cache 前缀稳定 → 首字延迟回到「命中」档（我们实测 6.5s vs 34.7s 的差距）。
- **实测（2026-09-12 21:33，改动生效后）**：同 prompt 连发三次，首字延迟 **75.6s → 23.7s → 23.6s**（冷 → 热，**3.2× 加速**）。
  · 冷态 75.6s 可精确解释、并非故障：输入 ≈ 20K token（system ~7K + tools schema ~9.5K + 技能索引 ~3.6K），gemma4 prefill 271 tok/s → 20000 ÷ 271 ≈ **74s**，与实测吻合。即冷态延迟主要是 prefill 的**物理成本**。
  · 热态 23.6s（对应重算 ≈ 6.4K token）说明 cache **部分**命中：固定 system 前缀命中，仍有约 1/3 在重算。进一步压到 6.5s 水位属后续优化（见 P2 降本）。
- 弊与前提：窗口增长更快，长会话更容易触顶 → 与 P0-1 配套做（先扩窗、再关压缩），并保留压缩续聊作为手动兜底。

**P0-3 双轨备份 + 产物存在性自检** 🟡 已完成（③ mirror 待确认）
- 做什么：① `bash backup.sh` 生成项目 bundle；② 修 `~/.hermes/backups` 的 cron 为何空跑；③ `npm run mirror`（**红区，需用户确认**）；④ 在 `healthcheck.sh` 里加三条断言：bundle 存在、其 mtime < 7 天、`~/.hermes/backups` 非空。
- 实战结论（三条与原方案有出入，以实测为准）：
  1. **bundle 从来就有** —— 落在仓库**上级**的 `../_hermes-backups/`，审计初查路径错了。故 ① 不是「生成」而是「纳入流程」。
  2. **cron 空跑已查明原因**：该 cron 由 hermes **常驻主进程**调度，而我们的常驻入口是 `gateway`（不是 `serve`，安全红线）→ cron 表根本不执行。**对策**：不走 cron，改用 `hermes backup --quick`（产物落 `~/.hermes/state-snapshots/`，含 state.db/config/auth/cron）作为引擎侧轨道。
  3. **断言从 3 条扩到 7 条**，并新增 `[9] 引擎配置不变量` 段（上下文窗口一致性 / micro_compact 关闭 / 元技能未复原）—— 这三条各对应一次真实故障，防止静默回退。
  4. 新增 `npm run backup:all`（`scripts/backup-all.sh`）：一键跑完两轨 + 快照轮转（hermes 自身无保留策略，会无限堆积）。
- 利：把「配置写了」变成「产物在」。这是全项目最严重风险的直接解。
- 弊与前提：本地 bundle 与工作区同盘，**不防磁盘故障**（脚本自带此声明）；真正的异地只能靠 mirror（**仍待你确认**）。另：轨道 A 的 bundle 只含**已提交**内容，未提交改动不进备份 —— 所以正确顺序是**先 commit 再 backup**。

### P1 · 可回滚与可判定（补能力）

**P1-1 唤醒 `hermes checkpoints` 并接到 UI** —— ✅ **已落地（2026-09-12 晚）**
- 实际做法：**没有走 `/rollback`**。实测确认 gateway 的 `api_server` 适配器不走斜杠命令分发
  （发 `/version` 会被当普通消息喂给模型，模型还编了身份），`/rollback` 只在 `_IDLE_COMMANDS` 里由平台管线派发。
  改为 Node 侧直接读写影子库：`lib/checkpoints.js` + `lib/routes/checkpoints.js`（6 端点）+ header 时钟图标面板。
- 休眠真因：**官方默认关闭**（`checkpoints_enabled=False`，v2 起 opt-in），不是坏了。配 `checkpoints.enabled: true` 即唤醒。
- 关键前置：`terminal.cwd` 必须钉在项目里 —— 否则 agent cwd 落 `$HOME`，而 `$HOME` 是检查点硬护栏，**快照永不触发**。
- ⚠️ 事故记录：共享裸库让任意提交对任意 workdir `cat-file` 可见，初期只检查"提交存在"就回退，
  实测把整个项目树 checkout 进了 `/private/tmp`（118 文件）。已加**双重守卫**（须为已注册项目 + 提交须在该项目 ref 历史内）。
- 详见 `docs/checkpoints.md`。判据：`node --test test/checkpoints.test.js`（14 例）+ `npm run ui` 的 L11 层。

**P1-2 结构化任务清单** —— ⏸ **未做，且路线已修正**
- 原定位是「停止条件裁判的**前置**」。本轮 P1-3 改用**确定性判据**（见下），
  不依赖结构化任务表即可工作，故该前置关系**不再成立**。
- 仍然值得做的理由（与裁判无关）：交付摘要、进度显示、压缩续聊都缺一个可靠的进度载体。
- 弊与前提不变：需要约束模型稳定输出结构（小模型易漂），建议固定模板 + 单测覆盖解析。

**P1-3 停止条件裁判** —— ✅ **已落地，但换了方案（2026-09-12 晚）**
- 原方案：run 结束前用同模型跑**冷裁判**（只读对话、无工具，判 `{ok|impossible|reason}`，限重入）。
- 实际方案：`lib/stopjudge.js` **确定性三判据**，零额外模型调用、零额外延迟：
  D1 同一工具调用重复 ≥3 → `warn`；D2 **同一调用且返回正文完全相同** ≥2 → `hard`；D3 单 run 工具调用 >40 → `hard`。
- 换方案的理由：① 本地 4B 自评不可靠，冷裁判可能一样乐观（原方案自己列的弊）；
  ② 每次 run 多几秒~几十秒，而首字延迟 45s 已是最大痛点；③ 确定性判据可单测、可复现。
- 设计取舍：**只报告不中断**（`HERMES_JUDGE_ABORT=1` 才 abort）；
  判据高精度低召回 —— 误报会让提示失去信任（狼来了），测试多数在验"不该报的都不能报"。
- 冷裁判**未关闭**：若要补，应作为独立"复盘"入口（事后判，不阻塞当下）。
- 详见 `docs/checkpoints.md` §三。判据：`node --test test/stopjudge.test.js`（14 例）。

**P1-4 `hermes curator adopt`**
- 做什么：把我们的技能纳入 curator 管理，先 `curator usage` 看遥测，`consolidate` 保持 off（LLM 合并是 opt-in）。
- 利：技能治理从「零作用」变成「自动剪枝 + 可恢复归档」。
- 弊与前提：adopt 是**黄区**（改全局配置），需确认；建议先 dry-run。

### P2 · 降本与可用性（打磨）

| 项 | 做什么 | 利 | 弊/前提 |
|---|---|---|---|
| P2-1 拦截反馈可读化 | 被拦/被拒时回一条**模型能读懂的反馈**（"该路径被策略拒绝，请换方案"） | 不卡死、不吐原始错误，模型能自纠 | **保留 TTL 放行**语义（超时转拒绝与"放手自主"目标冲突）；风险仍是放行窗口，靠 7 天上限兜底 |
| P2-2 工作目录前导 | 每条任务前导固定加「工作目录：<绝对路径>」 | 治 `-z --in` 不约束 terminal cwd（今天 hello-world 写进 `$HOME`） | 需与项目上传后缀统一措辞，避免两处冲突 |
| P2-3 `proactive_prune` 调参 | 认识并用好 `proactive_prune_min_result_chars: 8000` / `min_reclaim_tokens: 4096` | 工具结果占位可主动回收 | 需先量化收益，别凭感觉调 |
| P2-4 前端模块化 | app.js 1994 行单文件，按域拆分 | 可维护性 | ⚠️ 触碰三不变量，需 `npm run ui` 全绿 + 无 defer/module 变更，收益/风险比一般，缓做 |

---

## 9. 明确不做（含理由）

| 不做 | 理由 |
|---|---|
| Max Mode（best-of-N + 裁判选优） | 本地 4B 上跑 N 份 = 纯烧算力，16G 内存直接爆 |
| 云语音 / 桌面端 / Smart 调度 | 依赖小米云登录，**违背 local-first 红线** |
| 多代理并行 / worktree 编排 | 今天已证明瓶颈在「单代理上下文与模型能力」，加代理只放大不确定性 |
| 外部记忆 provider（mem0/honcho/OpenViking…） | 红线；且 OpenViking 与自建 KB 功能重叠 |
| BM25 技能检索层 | 99 技能规模下收益有限；瓶颈在 description 质量——先写好 description 更划算 |
| 抄 MiMo 的 checkpoint 三件套（validator/retry/reconcile） | 单用户本地工具，属过度设计；最小版（结构化字段 + 预算注入）足够 |

---

## 10. 路线图建议

**阶段一：算准 + 止血（今天可完成，零新功能）**
1. 上下文预算四处对齐 32768（P0-1）
2. `micro_compact` 关闭或降频（P0-2）
3. 双轨备份 + healthcheck 产物断言（P0-3）
4. 提交今天全部改动（分三笔：UI 精修 / 能力三件套 / 排障修复）
> 判据：`ollama ps` 与配置一致；一次真实长任务不再出现「用户任务被逐出」；`healthcheck.sh` 三条断言全绿。

**阶段二：可回滚 + 可判定（3 项）—— 进展 2026-09-12 晚**
5. ✅ 唤醒 checkpoints → UI 回退按钮（P1-1）—— 已完成，实测 live + UI 面板 + 14 例单测
6. ⏸ 结构化任务清单（P1-2）—— **未做**，且已不再是 P1-3 的前置（裁判改用确定性判据）
7. ✅ 停止条件裁判（P1-3）—— 已完成，**方案替换为确定性三判据**（非 LLM 冷裁判），14 例单测
8. ⬜ `curator adopt`（P1-4）—— 待做（agent-created=0 时零作用）
> 判据：✅ 能一键回退 agent 的文件改动（面板 + 双重守卫）；✅ 打转可被外部机制看见（只报告不中断）。
> 原判据「自主任务不再"乐观停止"」需用固定反例集复测 —— 尚未做该复测。

**阶段三：降本 + 探边界（有余力）**
9. `proactive_prune` 调参 + 前端模块化（P2-3 / P2-4）
10. MiMo 权重对比实验（**前提：在能访问 HF/ModelScope 的网络下载 GGUF**；复用 `scripts/model-bench.js`）
> 诚实预期：4B → 7B 是改善，不是跃迁；量级差距需要量级方案，不是工程能补的。

---

## 11. 可执行判据（下次开工先跑）

```bash
ollama ps                                   # 模型实载上下文是否为 32768
hermes prompt-size                          # 静态 prompt 开销（加功能前后必看）
hermes checkpoints status                   # 应为 live（非 0 B；09-12 已唤醒）
hermes curator status                       # agent-created 是否 > 0
ls -la ~/.hermes/backups/                   # 引擎侧备份是否有产物
ls -la ../_hermes-backups/*.bundle          # 项目侧 bundle（注意在仓库**上级**目录）
git branch -vv                              # main 是否已有 upstream
npm test && npm run smoke && npm run ui && npm run health   # 166 / 53 / 62 / 31 全绿
```
