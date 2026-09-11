# 赫尔墨斯特工 · 修改 + 升级总路线图

> 生成于 2026-09-06 · 基于对 server.js(899行)/index.html/双 plist/Ollama/state.db 的实际核查
> 分四个阶段：**A 必改 → B UI(参考豆包) → C 能力 → D 工程**，每阶段内按优先级排列

---

## 阶段 A · 必改项（现状问题，先修，防更坏）

### A1 🔴 双 launchd 服务抢 4173（正在崩溃循环）— 立即
| 服务 | plist | node | 状态 |
|---|---|---|---|
| `com.hermes.ui` | `deploy/com.hermes.ui.plist` | node26 | 崩溃状态 1，EADDRINUSE ×314 |
| `com.hermes-agent.ui` | `launchd/com.hermes-agent.ui.plist` | node22 | 正常，占 4173 |

```bash
launchctl bootout gui/501/com.hermes.ui
rm ~/Library/LaunchAgents/com.hermes.ui.plist   # 若装了
# 工作区 deploy/ 那份归档或删除，只留一份真源
```

### A2 🔴 主模型切换：qwen2.5:14b → qwen3.5:9b（2026-09-06 用户决定）
原 14b 派生方案被用户否决：删通用 `qwen2.5:14b-instruct-q3_K_M`，改用 `qwen3.5:9b`（官方标签真实存在，~6.6GB Q4，16G 甜点档）。流程：
1. `ollama pull qwen3.5:9b` → `ollama show` 查官方模板工具支持 → 决定是否建派生 `hermes-local-qwen35`（沿用 Modelfile 工具模板，FROM 换 qwen3.5:9b）
2. config.yaml：providers/models + model_overrides 加新派生，`model.default` 切换
3. 验证工具调用通过后 `ollama rm qwen2.5:14b-instruct-q3_K_M`
保留：`qwen2.5-coder:14b-instruct-q3_K_M`（未来 OpenCode 用）+ hermes-local/coder(7b) 后备

### A3 🟢 ~~`/api/status` 的 `ollama.models` 恒空~~ → 已更正：**不是 bug**
复查定论：status 查 `/api/ps`（驻留内存模型），models 查 `/api/tags`（全部已装），语义本就不同。Ollama 空闲 5 分钟自动卸载 → ps 为空是常态，前端正确显示"无驻留模型"。**无需修复**。
可选小增强 ✅（2026-09-06 完成）：`ollamaStatus()` 并行查 `/api/tags` 返回 `available` 计数；前端无驻留时显示"Ollama 运行中 · 无驻留 · 可用 N 个模型"。

### A4 🟡 `/api/cron` → `gatewayOk:false`
cron 依赖未启动的 gateway。若要用定时任务：改为不依赖 gateway 的判断（直接走 Hermes CLI）；不用就搁置，不影响主流程。

---

## 阶段 B · UI 界面（参考豆包网页版）

豆包网页版核心结构（多来源核实的官方形态）：**左侧「新建对话+历史按日期分组+智能体广场/文件库/设置」｜中部对话流｜底部「输入+图片/文件/语音+快速/思考模式切换」**，配空态引导磁贴、完成推送、亮暗切换、单条回复复制/重生成。

对照我们的现状 → 差距与动作：

| # | 豆包要素 | 我们的现状 | 动作 | 成本 |
|---|---|---|---|---|
| B1 ✅ | 底部输入工具条（图片/文件/语音）—— 2026-09-06 全部落地 | micBtn 曾是空壳；无图片上传 | ①图片上传 ✅（见 C4）；②语音=webkitSpeechRecognition ✅；③文件上传 ✅：小文本（≤6000 字符，受 PROMPT_LIMIT=8000 约束）客户端直读内联 prompt，其余 POST /api/upload 落盘 `~/.hermes/uploads/` 注入路径让 Hermes 文件工具自读；后端 15MB 上限、文件名穿越清洗、token 鉴权、`cleanStaleUploads()` 每 24h 清扫 >7 天的上传文件（启动+定时，同 D2 模式）；全链路已实测：Hermes 读 uploads 路径并准确报出文件内验证码 | 小 |
| B2 ✅ 历史按日期分组折叠 + 关键词搜索（2026-09-06 完成） | 侧栏平铺列表，无分组无搜索 | 按 id 时间戳前缀分 今天/昨天/近7天/更早 四组 + 顶部搜索框（title/info/id 过滤） | 小 ✅ |
| B3 ✅ 对话管理（重命名/删除/导出） | 后端 API 已有（`session/rename·delete·export`） | 会话项悬停菜单已接后端 API（L5 版已实现：重命名/删除/导出） | 小 |
| B4 ✅ 消息操作（复制/重新生成/朗读） | 无 | 每条消息 hover 出 编辑重发/复制/重跑/朗读 按钮（L5 版已实现） | 小 |
| B5 ✅ 空态引导磁贴（2026-09-06 复核确认已实现） | 仅一句欢迎语 → 现已有 4 个示例问题磁贴（`renderEmptyState()`），点击即发 | — | 极小 |
| B6 ✅ 完成推送提醒（2026-09-06 复核确认已实现） | 无 → 页面后台时 Notification API + WebAudio 短提示音 | — | 极小 |
| B7 ✅ | 快速/思考模式切换（2026-09-06 完成） | 只有模型下拉 | 下拉旁加"快速/思考"分段开关 → 思考=展开 reasoning 块（默认），快速=新思考块默认折叠（仍可点开） | 小 |
| B8 ✅ | 亮/暗主题切换（2026-09-06 完成） | 仅暗色 | 头部 ☀️/🌙 按钮；CSS 变量双套覆盖（外壳 + 代码块 + token 高亮）；localStorage 记忆；head 级脚本防 FOUC | 小 |
| B9 ✅ 技能/智能体入口（对应豆包"智能体广场"，2026-09-06 复核确认已实现） | 已随 C2 落地：技能列表"➡️ 使用"按钮 → 注入调用脚手架 | — | 小 |

**B 阶段做完的形态**：一个"暗色、左侧分组历史、底部带工具条、空态引导、消息可操作、长任务会提醒"的豆包式本地 agent 控制台。

---

## 阶段 C · 能力跃迁

### C1 ✅ OpenCode 编码子 Agent（2026-09-06 完成，含重大排障）
Hermes 代码能力弱；OpenCode 带 LSP/跨文件重构。
- `npm i -g opencode-ai`（brew 沙箱被拒；软链到 /opt/homebrew/bin），v1.18.29
- `~/.config/opencode/opencode.json`：自定义 provider `local`（@ai-sdk/openai-compatible → Ollama /v1）
- **关键排障**：qwen3.5:9b / coder-14b 在 opencode 里"cosplay 工具调用"（把 JSON 当文本吐）→ 根因是 **Ollama 默认 num_ctx=4096**，agent 上下文一爆模型就丢工具指令 → 建派生 `oc-qwen35`（FROM qwen3.5:9b + num_ctx 16384）→ 工具调用真实执行（read→write→bash 三连、文件真修复、node 验证 5）
- **遗留 → 已验证关闭（2026-09-06）**：`Modelfile.hermes-coder-14b` 已 ollama create（完整 Qwen2.5 工具模板 + num_ctx 16384），但实测 **q3_K_M 量化本身不输出 `<tool_call>` 包裹标签**（三轮测试：基线/系统提示强化/temperature 0.05，模型均把 JSON 当文本吐或包 ```json 围栏，Ollama 无法解析成 tool_calls）→ **结论：量化缺陷不可修，OpenCode 主力维持 oc-qwen35**；hermes-coder-14b 保留作非工具场景（纯代码补全/问答）后备，opencode.json 不收录
- Hermes 技能 `delegate-coding-to-opencode` 上线（/api/skills 确认 66 个）

### C2 ✅ 技能"点一下就用"（低配版智能体广场）— 2026-09-06 完成
技能市场已能列 89 技能但 7B 记不住名 → 列表点击把 SKILL.md 调用脚手架注入输入框。后端数据源现成，改动小收益高。
> 落地：后端 /api/skills 改为直扫 `~/.hermes/skills/`（绕开 CLI skills list 列宽截断——截断名会让点名失败），65 技能名完整 + 60/65 带 frontmatter description；前端技能项加"➡️ 使用"按钮 → 注入点名脚手架（含名称+用途描述）到主输入框，补任务即发送。

### C3 ✅ 思考过程可视化（2026-09-06 完成）
`state.db` messages 有 `reasoning` 列 → 轮询渲染成"▶ 深度思考"折叠块（`.reason`），配合 B7 快速/思考开关控制默认展开/折叠。

### C4 ✅ 多模态闭环：图片问答（2026-09-06 完成）
llava:7b 已下载，可"截图问 bug / 拍文档 OCR"。
- **后端** `POST /api/vision`：readBody 上限放宽 8MB；转发 Ollama `/api/chat` llava:7b，`keep_alive: '30m'`（16G 单驻留下把 llava 驻留窗口从默认 5m 拉长到 30m，避免频繁换载）；300s 超时
- **前端**：输入工具条 📎 图片按钮 → canvas 压缩（最长边 1280 JPEG 0.85）→ 预览条 → send 时先 llava 识别、识别文本注入 prompt（标注"识别结果不一定准确"）→ 走主 agent
- 识别阶段 UI 提示"首次需加载视觉模型 1-3 分钟"
- **实测证据**：vision OCR 准确（错误对话框文字逐字提取）；prompt 注入正确（state.db 多条 user 消息含"以下是 llava:7b 的识别结果"）；chat 正常启动 4/4
- **性能现实**：16G 单驻留（Ollama 默认 max_loaded_models=1）下，看图+推理连续两阶段必经历 1-2 次模型换载（12s~4min 波动，取决于 page cache）。qwen35 系请求自带 keep_alive 2h、llava 30m
- **后续优化 → D1 已处理（2026-09-06）**：Ollama 改由自建 LaunchAgent 托管，max_loaded_models=2 + KV q8_0 已生效；双驻留受系统空闲 RAM 限制（需 ≥6.6G），详见 D1 行

---

## 阶段 D · 工程加固

| # | 事项 | 动作 |
|---|---|---|
| D1 ✅ Ollama 托管化完成 + 双驻留按内存条件生效（2026-09-06） | 方案升级：放弃 brew/GUI，**自建 LaunchAgent `com.zhaocaozheng.ollama`**（~/Library/LaunchAgents，直跑 Ollama.app 自带 CLI 的 `serve`，之前 bootstrap IO error 根因是走 /usr/local/bin 符号链接）。env：`OLLAMA_MAX_LOADED_MODELS=2` + `OLLAMA_KEEP_ALIVE=2h` + `OLLAMA_FLASH_ATTENTION=1` + `OLLAMA_KV_CACHE_TYPE=q8_0`（KV 减半，llava 4.7→4.5G）。实测：GPU 侧双模型 10.2G < Metal 上限 11.8G 可共存，但**卡在系统空闲 RAM**——两模型实需 ~11.3G wired，qwen35 加载时要求空闲 ≥6.6G，本机常驻 App 占用下空闲只有 ~6.3G → 换出。**结论**：上限已放开，关掉吃内存的 App（空闲 ≥6.6G）时双驻留自动生效；日常单驻留 + llava 按需加载（30m keep_alive）。⚠️ 注意：Ollama.app 登录项若开机自启会抢 11434 端口——菜单栏退出它即可，本 LaunchAgent KeepAlive 数秒内自动接管；建议在 Ollama 设置里关闭"Start at Login" |
| D2 ✅ 日志健康守护（2026-09-06） | launchd 捕获日志无内置轮转，崩溃循环可能写爆磁盘 | server.js 启动时检查 `hermes-ui.{out,err}.log` 超 10MB 截断保留尾部 1MB（`trimOversizedLogs()`）；setup.sh 同样兜底 |
| D3 ✅ 一键部署 setup.sh（2026-09-06） | 换机/重装要手抄双 plist | `bash setup.sh`：前置检查(node/ollama/模型) → sed 换 HOME 装 plist → 已跑则 kickstart / 未跑 bootstrap(容错 IO error) → 健康检查 → 自检报告(端口/令牌/驻留/技能数) → 日志健康。实测全流程通过 |
| D4 ✅ 局域网访问已开启（2026-09-06 用户启用） | 绑 0.0.0.0 | plist env 已加 `HOST=0.0.0.0`（workspace launchd/ 与 ~/Library/LaunchAgents 两份同步），服务重载后监听 `*:4173`。访问：`http://192.168.31.159:4173` + 令牌（`~/.hermes/ui_token`）。⚠️ 令牌是唯一门锁且无 HTTPS：仅限局域网、勿暴露公网；防火墙首访会弹询问放行即可 |

---

## 建议执行顺序

```
Phase 1 (今天, 1h)   A1 → A2+A6 → A3           稳定基线 + 14b 真接通
Phase 2 (UI, 2-3h)   B5+B6+B3+B4 → B2 → B1语音 → B1图片(C4)   先小后大
Phase 3 (能力)       C2 技能注入 → C3 思考可视化 → C1 OpenCode(单独排期)
Phase 4 (工程)       D2 → D3 → D1 收尾 → D4 可选
```

> 原则：Phase 1 是地基（现在崩着/14b 没通）；Phase 2 按"成本从小到大"上，让每个改动当天可见；C1 OpenCode 因内存与调度设计，建议单独一次会话做。

---

## 阶段 E · 模型换血：gemma4:e4b（2026-09-10）

用户主动清空全部旧模型（14:04 七连删），重建阵容：`gemma4:e4b`（主）+ `bge-m3`（嵌入）。

### 动机
gemma4:e4b 一个模型同时具备**原生 function calling + 原生 system role + 视觉 + 音频**，顶掉旧的「qwen3.5:9b 对话 + llava:7b 视觉」两套 → **视觉与推理不再互相换载**（C4 最大痛点、D1 双驻留问题的根源一并消失）。

### 已落地（代码 / 配置）
- 新增 `Modelfile.hermes-local-gemma4`：`FROM gemma4:e4b` + `num_ctx 16384`。**不覆盖 TEMPLATE**——gemma4 原生支持 tools/system，覆盖反而破坏工具调用。关键：16G < Ollama 的 24GiB 阈值，Ollama 默认把 num_ctx 压到 4096 → agent 上下文溢出 → 工具调用 cosplay，故必须派生固定。
- `server.js`：`LOCAL_MODELS=['hermes-local-gemma4','gemma4:e4b','qwen2.5:7b','hermes-local']`、`DEFAULT_MODEL='hermes-local-gemma4'`；`VISION_MODEL=DEFAULT_MODEL`（视觉=对话同模型，杜绝换载）；`llavaDescribe` → 通用 `multimodalAsk`+`describeImage`/`transcribeAudio`；新增 `POST /api/transcribe`（本地语音，16MB 上限）；新增 `POST /api/skills/find`（bge-m3 技能语义检索）；`/api/models` 改为与 `/api/tags` 取交集（不再列不存在的模型），纯 embedding 模型排除在对话下拉外。
- `~/.hermes/config.yaml`：default / provider models / model_overrides 全切 gemma4，`supports_vision: true`。
- `~/.config/opencode/opencode.json`：默认模型 → `local/hermes-local-gemma4:latest`。
- 前端：语音从 `webkitSpeechRecognition`（**音频送 Google，违反 local-first**）改为 MediaRecorder → 重采样 16k 单声道 WAV → `/api/transcribe` → gemma4 转写；技能搜索从"远程注册表"改为本地语义检索；图片链路文案 llava → gemma4。
- llava 不再需要 → 视觉由主模型承担。

### 待完成（等 gemma4:e4b 下载完）
- `ollama create hermes-local-gemma4`（已挂链式脚本 `/tmp/after-e4b.sh`，检测到模型即自动创建）
- 实测：工具调用 / 视觉 / 本地语音转写 / 端到端 SSE
- 风险：16G 跑 9.6GB 模型（比旧 qwen3.5:9b 重 3GB）可能吃紧；gemma4 视觉在 Ollama 0.33.3 需实测（有 0.32.5 忽略图像的旧报告）

### 环境观察
同一台 Ollama 被多个 WorkBuddy 会话共享。本日另有一会话（小说机器人项目）在按 `bge-m3 → qwen3:8b → qwen3.5:9b → qwen2.5:14b → qwen3:14b` 顺序拉取 → 带宽被分摊，e4b 下载变慢。`bge-m3` 即由该会话拉入。
