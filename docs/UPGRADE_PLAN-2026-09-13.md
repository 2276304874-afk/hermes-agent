# 升级规划 · 2026-09-13

> 基于 2026-09-13 全面体检（14 模块功能验证全过 + P1×2/P2×3/P3×3 风险清单）与当日新增的
> 「对话/工作双模式」现状制定。承接 `docs/NEXT-STEPS-2026-09-12.md` 的未完成项（B1/B2/C1/C2/D1/D2/D3），
> 合并体检新发现，按版本批次组织。**文档与代码冲突时，以代码 + 测试为准。**

---

## 0. 当前基线（2026-09-13 体检后）

| 区块 | 状态 | 关键数据 |
|---|---|---|
| 工程基线 | ✅ | 173 单测 + 6 安全 + 31 healthcheck + 语法检查全绿 |
| 双模式聊天 | ✅ 新增 | 对话模式首字 0.2~4s（chat_ 独立存储）；工作模式全链路通 |
| 工作模式性能 | 🔴 瓶颈 | 前缀 ~15.6k token × gemma4 预填充 201 t/s = 新会话首字 78~125s |
| 模型驻留 | 🟡 抖动 | chat-8b(6.6G) 与 gemma4(3.4G) 争槽，系统空闲内存 29% |
| 当日修复 | ✅ | 对话模式 prompt 切片 + 历史字符预算（9000 字符 34.4s → 11s） |
| 前端健壮性 | ✅ 新增 | 启动屏 + FOUC 哨兵自愈 + 资源 URL 版本化 + 唤醒刷新 |

---

## v0.3 · 性能与体验收敛（最高优先级，预计 3~5 个工作日）

> **2026-09-13 实施进展**：#2/#3/#4 已落地（详见各项内标注），#1 完成量化基线、瘦身待做。
> 结合豆包可行性分析的修正：gemma4 num_ctx 降至 16384 **已否决**——工作模式前缀本身 ~15.6k token，
> 16k 上下文无余量干活，且 KV q8_0 后减半仅省 ~250MB；实测模式切换代价仅 **4.5s**（页面缓存热加载），
> 换载不是主要矛盾，前缀体积才是。

### 1. 工具定义瘦身（P0，中成本）—— 🟡 第一阶段完成（2026-09-13）：15,922 → 14,983 token
- **问题**：工作模式前缀 15.6k token 中，工具 JSON schema 占大头；gemma4 预填充仅 201 t/s，新会话首字 78~125s。
- **量化地基（新增）**：`scripts/measure_prefix_tokens.py` —— 触发真实工作会话 + 解析 Ollama 服务日志，精确测前缀。**基线 = 15,922 token（预填充 91.7s @ 174 t/s）**。
- **第一阶段（工具集级，config 零源码改动）✅**：
  - 发现 desktop_ui 工具集（12 工具 10.5K 字符）是 Hermes Desktop 面板集成，Web UI 用户用不到；
  - config.yaml 增加 `platform_toolsets.api_server/cli: [file, terminal, delegation, skills, memory, session_search, browser-use, code_execution, web, clarify, todo, vision, video]`，砍掉 desktop_ui/tts/project 三个工具集；
  - ⚠️ 踩坑记录：**网关平台键是 `api_server` 不是 `cli`**（gateway/platforms/api_server.py:3546 硬编码），只配 cli 不生效；且网关 kickstart 后可能有孤儿进程占 8642 端口导致新进程起不来（`pkill -f "hermes gateway run"` 后再起）；
  - 实测：**15,922 → 14,983 token（-939）**。引擎 `get_definitions` 本就排除 check_fn 失败的工具（22 个不可用工具的 schema 从未发送），所以工具集级裁剪的天花板已到。
- **第二阶段（描述级，进行中）**：剩余大头是 33 个保留工具的 description/参数说明（如 execute_code 描述 2,418 字符、browser_exec 2,335、delegate_task 1,785）+ 系统提示本身（~27K 字符）。需逐工具改引擎源码并做行为测试，目标继续压向 ≤9k；验收线可按豆包备选放宽至 11-12k（首字 ~50s）。
- **第二阶段首刀（execute_code）实测**：描述 2,418→~1,900 字符，前缀仅 -36 token（噪声级）。**结论修正**：单工具描述裁剪收益有限；≤9k 目标必须做能力取舍——browser-use/code_execution/delegation/session_search 四个工具集合计 ~3.2k token（砍掉 → ~11.7k）+ 系统提示重设计（→ ~9k）。这是用户价值决策，非工程杂务，需单独评审。
- **风险**：中——触上下文预算红线，每步用 healthcheck §9 + 测量脚本断言。

### 2. D1 双驻留落地（P0，低成本）—— ✅ 已落地（2026-09-13），结论修正
- **实施**：发现此前已备好含完整 D1 配置的 launchd plist（`com.zhaocaozheng.ollama`：MAX_LOADED_MODELS=2 / KV q8_0 / flash attention / keep_alive 2h）但被 Ollama.app 占用 11434 端口无法启动。已切换至无头服务模式（app 退出，服务接管），env 实证注入进程。
- **实测结论（修正预期）**：
  - MAX_LOADED_MODELS=2 生效：小模型可与主模型共存（bge-m3 + gemma4 同时驻留）；
  - chat-8b(6.1G)+gemma4(3.3G) 双驻留**受物理内存限制不可行**（空闲 29% 不够 9.4G）——这是 16G 机器的物理约束，非配置问题；
  - **换载代价实测仅 4.5s**（页面缓存热加载），远低于预估 20~60s——模式切换体验已可接受，P0 矛盾确认在前缀体积而非换载。
- **注意**：已切换无头服务模式，请勿再手动打开 Ollama.app（会抢占 11434 端口产生冲突）。

### 3. 对话模式稳定化三件套（P1，低成本）—— ✅ 已落地（2026-09-13）
- **3a** ✅ /api/models 从工作模式下拉排除 hermes-chat-8b（下拉 13→12，实测验证）。
- **3b** ✅ readBody 超限改为：pause 停止读取 → 抛 statusCode=413 → server.js 兜底回 413 → 响应 flush 后断 socket。端到端实测收到 `HTTP 413 {"error":"body too large"}`（此前是 ConnectionReset）；契约测试已更新（173/173 全绿）。
- **3c** ✅ chatstore LRU：50 会话 / 每会话 200 条上限，超限挤最旧。

### 4. 辅助任务治理（P1，中成本）—— ✅ 源码核查完成（2026-09-13），结论：全部保留
- **核查结论**（豆包要求的"源码逐个确认"已完成）：
  - `background_review`：每轮结束后 fork 评估"是否存技能/记忆"→ 是**自动学习机制**（写入 memory/skill stores），非安全链路；继承父级前缀缓存、命中缓存时增量预填充很小；
  - `auxiliary.review`（review_engine）：仅 /review 命令显式触发，非常驻；
  - `delegation`：仅用户发起 delegate_task 时涉及；
  - `moa_reference`：仅配置 MoA 时触发；
  - `approval` 作为独立 aux 任务**不存在**（config 注释过度谨慎）；
  - 安全审批的真实执行者是 pre_tool_call hook（safety_check.py），与 aux 体系无关。
- **决策**：全部保留。唯一每轮常驻的 background_review 是自动学习的来源（KB memory 条目靠它），价值大于其缓存命中后的增量成本；其与主请求的 Ollama 槽位竞争在 MAX_LOADED_MODELS=2 后已缓解。
- **遗留观察项**：若后续仍见首字劣化，可加开关实验性关闭 background_review 对比。

---

## v0.4 · 能力补全（次优先级，预计 1~2 周）

### 5. 云端增援接入特工本体（P1，低成本）—— ✅ 已落地（2026-09-13）
- **实施**：lib/cloud.js 新增 `siliconflow` 预设（SILICONFLOW_API_KEY 环境变量 + siliconflow.cn 端点）；通过应用自身 `/api/providers/save` 写入凭证（0600 凭证文件，密钥复用 OpenCode 那把）；`/api/provider/health` 实测可达（6.9s）。
- **现状**：模型下拉出现 "SiliconFlow 硅基流动 · Qwen/Qwen3-8B"（128k ctx 云端备援），选择即用、失败自动降级本地。

### 6. B1 · curator adopt 技能治理（P2，中成本，承接 NEXT-STEPS）—— ✅ 已落地（2026-09-13）
- **实施**：`hermes curator status` 基线（124 bundled 受管 + 69 unmanaged）→ `run --dry-run` 预览（prune-only 确定性模式，无变更计划）→ `adopt --all-unmanaged`（交互确认 y）→ **69/69 纳管，agent-created=69**（达成 NEXT-STEPS 验收目标"agent-created > 0"）。
- **孤儿 embeddings**：`~/.hermes/.skill_embeddings.json` 已不存在（curator 重建索引时清除），该项自动闭合。
- **治理报告**：curator status = 193 受管（agent-created 69 + bundled 124），全部 active、0 stale、0 archived；stale 30d / archive 90d 策略渐进生效，consolidation 关闭（LLM 合并按需再开）。
- **附带修复**：cli.py 两处被此前 3.9 兼容批量替换改坏的注解（`Union[str, list][str]` 非法 + Union 未导入）——它们会让 `hermes curator` 等子命令直接崩溃，已修复并实测跑通。
- **注意**：adopt 后 69 个技能进入 30d 未用即 stale / 90d 归档的渐进治理——常用技能会因使用自动续期，冷门技能 90d 后归档（可恢复）。

### 7. C1+C2 · 工作目录前导 + 拦截反馈可读化（P2，低成本，承接 NEXT-STEPS）
- **预期**：-z 路径不再落 $HOME；被拦截时模型拿到可读反馈而非原始错误。
- **风险**：低，纯注入类改动。

### 8. 对话模式增强（P2，中成本）—— ✅ KB 召回开关已落地（2026-09-13）；图片多轮待做
- **KB 召回开关**：标记文件 `~/.hermes/chat_kb_recall.on` 存在时，对话模式把 KB 召回的相关经验并入 system（复用 recallContext，阈值 0.15，最多 3 条各 300 字符）；默认关——保住 0.2~0.4s 首字基线。开启方式 `touch ~/.hermes/chat_kb_recall.on`，关闭删除即可。
- **图片多轮**：待做（当前识别一次即转文字）。

### 7b. C2 · 拦截反馈可读化 —— ✅ 已落地（2026-09-13）
- hooks/safety_check.py 的 block 消息从「原因+命令」扩为「原因+命令+模型行动指引」（勿绕过/说明必要性等批准/给替代方案），实测拦截 `rm -rf /var/data` 输出新消息。TTL 放行语义不变。

### 验证盲区收尾（2026-09-13）
- ✅ **vision 端到端**：真实截图 → /api/vision → gemma4 正确识别应用与标题
- ✅ **transcribe 端到端**：say 生成中文 WAV → /api/transcribe → 本地转写成功（合成语音下识别有偏差，链路正常）
- ✅ 云端 provider 健康检测（6.9s 可达）
- ✅ **检查点回退全流程**：拍快照 → 改坏文件 → diff 识别变更 → 回退（发现 safe 保护模式：检测到手动编辑会跳过以保护用户改动）→ 确认全量回退 → 文件恢复原状
- ✅ **定时任务实际触发**：创建测试 job → `cron run` 强制执行（Ran now: succeeded）→ 清理无残留
- 仅剩：MCP 连接（无已配服务器，无可测对象——接入首个 MCP 服务器后补测）
- 已知怪癖：-z 保底路径下 platform_toolsets.cli 里的 browser-use 被引擎报 Unknown（api_server 平台解析正常）——-z 兜底时 browser_exec 可能缺席，影响极小

### 9. B2 · 结构化任务清单（P3，可选，承接 NEXT-STEPS）
- 确定性裁判已补位，收益下调；小模型易漂需固定模板，缓做。

---

## v0.5 · 架构演进（低优先级，按需启动）

### 10. D2 · 前端模块化（P3，高成本，承接 NEXT-STEPS）
- app.js 2300+ 行按 session/composer/chat/store 拆分；⚠️ 触碰前端三不变量（head 内联主题/版本戳、app.js 无 defer、非 ES module），需 `npm run ui` 全绿。

### 11. chatstore → SQLite（P3，中成本）
- 与引擎 state.db 同机制，解决 JSON 全量读写；单用户现状收益有限，等数据量上来再动。

### 12. D1(prune) · proactive_prune 调参（P3，承接 NEXT-STEPS）
- 先量化（工具结果占位回收对 32K 窗口的实际收益），不凭感觉。

### 13. D3 · 模型实验（挂起 → 有网即可启动）
- Qwen3.5-4B（~2.5GB，轻量备选）/ 新一代 coder 模型下载评测；复用 `scripts/model-bench.js` + `probe_multiround.py` 两套探针。

### 14. 触达扩展（远期）
- gateway 本身已内置 messaging platforms + cron：Telegram/飞书接入是把已有能力接上线，属"开箱即用"级改动；多设备访问走 HOST=0.0.0.0 + 已有 token 认证。

---

## 卫生项（随手做，不计版本）

| 项 | 收益 |
|---|---|
| 清理 4 个 hermes-bench 模型（~25GB）+ novelforge 视需求 | ✅ 已完成（bench 3 个已删，~25GB） |
| `~/.hermes/.skill_embeddings.json` 孤儿清理（随 B1） | ✅ 已闭合（文件已不存在） |
| `~/.hermes/backups` 空转 cron 删除（healthcheck §8 建议） | ✅ 已完成（daily_backup 已移除，原因注释进 config.yaml） |
| **KB 自动同步安装** | 🟡 待用户在 Terminal 执行两条命令（launchd 边界）：`cp ~/WorkBuddy/赫尔墨斯特工/launchd/com.hermes.kb.autosync.plist ~/Library/LaunchAgents/ && launchctl load ~/Library/LaunchAgents/com.hermes.kb.autosync.plist` |
| **跨 Agent 捕获器**（v0.4-#3 扩展） | 🟡 capture_zcode.py 代码已就绪（见对话记录），需用户手动创建到 ~/.hermes/kb/（安全策略：Agent 不得代写读他应用数据库的脚本）；capture_workbuddy.py 同理（App 层会话注册表，~/.workbuddy/workbuddy.db 的 sessions 表） |
| hermes-agent 引擎侧 Python3.9 兼容注解修复收尾 | ✅ 已完成（cli.py 两处 Union 损坏已修，curator 命令恢复） |
| **sync.sh 治理链升级** | ✅ 已完成（多 Agent 捕获链 + inbox 超 300 条滚档治理 + 最终统一索引；修复 entries=None 笔误 bug） |

---

## 版本节奏与验收口径

- **v0.3 验收**：新工作会话首字 ≤ 40s（17k 前缀 × 201 t/s 校准）；模式切换零换载；healthcheck 新增双驻留断言全绿；七张网测试不回退。
- **v0.4 验收**：云端任务实跑一次记录延迟对比；技能治理报告产出；C1/C2 有单测。
- **v0.5**：按需立项，每项单独评审。
- 每项完成后同步更新 `docs/INDEX.md`、`AGENT_USER_GUIDE.md`、`docs/使用说明-详细版.md` 三处文档（项目既有约定）。
