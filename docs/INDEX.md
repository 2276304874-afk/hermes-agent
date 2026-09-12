# 文档索引 · 赫尔墨斯特工

> 本文件只做一件事：**30 秒内告诉你该看哪份**。
> 最后更新：2026-09-12 晚（新增 `docs/checkpoints.md`：检查点回退 + 停止条件裁判的接线真源）。
> 此前：新增 `docs/PROJECT-AUDIT-2026-09-12.md`，整体审计 + MiMo-Code 对照 + 优先级。
> 再此前：`ACTION_PLAN-2026-09-12.md` 为有效待办清单。新增根目录 `.md` 时请回到这里补一行。

---

## 一、一句话总览

| 文档 | 一句话 | 什么时候看 |
|---|---|---|
| `docs/PROJECT-AUDIT-2026-09-12.md` | **整体审计**：架构/模块/功能矩阵/量化现状 + 「配置已写、机制未跑」九项实测 + MiMo-Code 逐域对照 + P0~P2 优先级与三步路线图 | **想知道「项目现在算什么水平、下一步做什么」**；接手项目或做规划前先看 |
| `项目导读.md` | 项目本体说明书：架构、目录、API 清单、启动方式、UI 结构 | **第一次接触项目**；想知道「这东西由什么组成」 |
| `AGENT_USER_GUIDE.md` | **使用者手册**：界面三大块、能/不能干什么、9 条经验、自救清单 | **日常使用**；想知道「怎么让特工干得更好 / 卡住了怎么办」 |
| `docs/AUTONOMY_POLICY.md` | **放手自主执行安全方案**：三色权限清单（绿全自动/黄5分钟放行/红必停）、五道检查点、分级回滚、时长与范围上限 | 想让特工**无人值守连续干活**之前必读；给自主任务写约束 prompt 时照抄 §六 模板 |
| `docs/checkpoints.md` | **检查点回退 + 停止条件裁判**：影子库契约、双重守卫、`terminal.cwd` 前置条件、三类判据与「只报告不中断」取舍、API/UI 接线 | 改回退逻辑、调裁判阈值，或排查「检查点列表为什么是空的」时看 |
| `docs/MODEL_BENCH-2026-09-12.md` | **14b 模型对比实验**：4 模型微基准 + agent 级实测，gemma4 全面胜出、qwen3.5:9b 收编为备胎、14b 在 16G 不可用 | **换模型之前必读**；含可复测脚本 `scripts/model-bench.js` / `model-bench-agent.sh` |
| `UPGRADE_ROADMAP.md` | 升级总路线图：A 必改 / B UI / C 能力 / D 工程 + 阶段 E 模型换装 | 想知道**能力与工程演进到哪一步、为什么这么走** |
| `docs/INTEGRATION_PLAN.md` | 外部仓库接入方案：对齐《AI Agent 技术栈 GitHub 仓库清单》，逐项列可接入性与偏好算法 | 想给 agent **接新能力**时看（含 §五 15 分钟的先决验证实验） |
| `ACTION_PLAN-2026-09-12.md` | **当前行动清单**：T1~T10 按优先级排列，含实测依据、工作量、依赖关系、多方案取舍 | 想知道**接下来该做什么**（替代已完成的 `IMPROVEMENT_PLAN.md`） |
| `IMPROVEMENT_PLAN.md` | 按优先级排列的改进清单（P0~P3），每条含「建议 / 前提 / 效果」 | 想知道**还有哪些问题待修**（注：P0-1~P2-9 已完成，状态见本文左上角引注） |
| `KB_INTEGRATION.md` | 知识库 viewer 并入主服务 4173 的设计与落地记录 | 动 `/kb` 或 `/api/kb/*` 之前**必看**（含认证策略定案） |
| `PLAN-hermes-serve.md` | 改造提案：`hermes -z` 每轮起进程 → `hermes serve` 常驻后端 | 想解决**首字延迟**时看（状态：**待评审，尚未落地**；实测热路径 37.1s → 0.7s） |
| `可复用知识沉淀系统-构思.md` | 「自动把对话沉淀成可复用技能」的构思与架构映射 | 想推进**知识自增长 / 自动蒸馏**方向时看 |
| `GITHUB_RECOMMENDATIONS.md` | 可集成的开源项目与技能推荐清单 | 想**给 agent 加能力**、挑现成轮子时看 |
| `RESEARCH/doubao-plan-verification/` | 豆包「M4 16G 本地 Agent 方案」逐条核验（含执行摘要与原始数据） | 有人拿"某方案说应该这样"来质疑时，先看这里有没有已核验的结论 |

---

## 二、按需求定位（比通读快）

| 我想… | 直接看 |
|---|---|
| 把服务跑起来 / 换台机器重装 | `项目导读.md` 的启动段 + `bash setup.sh`（AI shell 无 GUI 会话权限，需你自己在 Terminal.app 跑） |
| 知道**守护为什么没起来 / 端口被谁占** | `healthcheck.sh`（一条命令给判据），再查 `~/Library/Logs/hermes-ui.err.log` |
| 改后端代码 | `server.js` 头部注释（启动链路 + 安全模型 + 关键约束）→ 对应 `lib/*.js` 文件头 → `lib/routes/*.js` |
| 改前端 | `public/index.html`（骨架）+ `app.js`（全部逻辑，IIFE）+ `app.css`；改完跑 `npm run ui` |
| 搞清 **KB 接口为什么 401 / 还要不要令牌** | `KB_INTEGRATION.md` §「认证策略（P2-10 定案）」 |
| 知道**改完怎么验** | §三「可执行的判据」 |
| 排查「服务打不开 / 聊天没反应」 | `.workbuddy/memory/MEMORY.md` 的**工程纪律**段（含已知坑与 `[FATAL]/[handler]/[http]` 日志判读规则） |

---

## 三、可执行的判据（比文档更权威）

**文档会过期，测试不会。** 与代码冲突时，一律以代码 + 测试为准。

| 命令 | 覆盖 | 当前基线 |
|---|---|---|
| `npm test` | 纯函数单测（解析 / 用量 / HTTP / 接线 / 检查点 / 裁判 / 自主纪律 / 工作区…） | 166 例全绿 |
| `npm run smoke` | 路由清单冒烟（每条路由都被正确登记；KB 认证不变量） | 53 例全绿 |
| `npm run ui` | 无头 Chrome 前端冒烟（L1 传输 / L2 执行 / L3 渲染 / L4 健康 / L5 降级 / L6 KB 页 / L11 检查点面板） | 62 例全绿 |
| `npm run health` | 运行时自检：守护 / 端口 / 接口 / 日志健康 / 备份产物 / 引擎配置与检查点不变量（= `bash healthcheck.sh`） | 31 例全绿 |
| `npm run test:safety` | 高危命令拦截 hook（fail-closed） | 6 例全绿 |
| `npm run test:stop` | `/api/stop` 契约（SSE 收尾） | 9 例全绿 |
| `npm run test:chat` | 危险放行写盘契约（`ui_bypass_sessions.json`） | 6 例全绿 |
| `npm run check` | 全量语法检查（server + lib + routes + 前端 + 脚本 + 测试） | 退出码 0 |

> **七张网全绿才可 `git commit`。** 缺依赖时 `npm run ui` 会**显式 SKIP 并声明"前端未经验证"**，不会假装通过。
> ⚠️ 本机 `node --test` 必须写 `node --test test/*.test.js`（把目录当模块路径会报错）。
> ⚠️ `npm run ui` 依赖 `$HOME/.hermes/ui_token`；手敲 `node test/ui.smoke.js` 漏传 token 会假报一片 401。

---

## 四、代码里的文档（真源，别另抄一份）

| 位置 | 内容 |
|---|---|
| `server.js` 头部 | 启动链路、双通道进度来源、安全模型、关键部署约束（`PYTHONPATH` / `NO_PROXY`） |
| `lib/routes/kb.js` 头部 | **P2-10 KB 认证决策**与其三条理由（勿改回公开） |
| `lib/parse.js` 头部 | 解析层约定：纯函数、零 IO、可单测 |
| `lib/router.js` 头部 | 路由匹配语义（顺序 + 前缀），以及为什么不引入框架 |
| `lib/state.js` 头部 | 为什么可变状态要集中在单例模块 |
| `.workbuddy/memory/MEMORY.md` | 项目长期记忆：架构、模型选型、**工程纪律（血泪教训）**、路线图现状 |
| `.workbuddy/memory/YYYY-MM-DD.md` | 每日工作日志（append-only）：当天改了什么、怎么验的、踩了什么坑 |
| `archive/` | 已归档的一次性脚本（P2-7），留档不参与运行 |

---

## 五、建议阅读顺序（新会话 / 新人）

1. `项目导读.md` + `docs/PROJECT-AUDIT-2026-09-12.md` —— 先建立整体图景，再看现状判据、实测发现与优先级
2. `AGENT_USER_GUIDE.md` —— **如果是「用」而不是「改」，先看这份**
3. `.workbuddy/memory/MEMORY.md` —— 再吃下「不能违反的约束」和已知坑
3. `docs/INDEX.md`（本文件）—— 知道后续该查谁
4. `UPGRADE_ROADMAP.md` —— 理解演进脉络与决策依据
5. `ACTION_PLAN-2026-09-12.md` —— **认领当前待办**（T1~T10，按优先级；
   `IMPROVEMENT_PLAN.md` 为 2026-09-11 的历史清单，已基本完成，仅作决策追溯）
6. 动手前跑一遍 §三 的判据，拿到自己的基线

---

## 六、维护约定

- 新增/删除根目录 `.md` 或 `RESEARCH/` 文档时，**回来改 §一 的表**。
- 文档与代码不一致时：改文档，别改测试去迁就文档。
- 涉及安全边界（认证、绑定地址、文件写入范围）的决策，必须同时写进**代码注释**和对应文档，两处都要有理由，不能只留结论。
