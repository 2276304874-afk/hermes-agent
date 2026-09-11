# 完整报告：豆包方案逐条核验与现状对比

## 1. 引言

### 1.1 背景
用户机器为一台 Mac M4 16G 统一内存，已建成并运行一套 100% 免费、纯本地的 AI Agent 体系：
- **推理底座**：Ollama（本地 11434 端口，OpenAI 兼容）
- **主 Agent**：Hermes Agent v0.21.0（Python venv，`~/.hermes/venvs/hermes`），89 个已装技能
- **控制前端**：Node 无依赖 Web 控制台（server.js 899 行 / 30+ API / SSE 实时工具时间线 / 安全钩子 / 历史回显 / 认证）
- **模型**：hermes-local(7b)、hermes-coder(7b)、qwen2.5:14b、qwen2.5-coder:14b、llava:7b、nomic-embed-text、llama3

### 1.2 研究对象
一份外部 AI 生成的《Mac M4 16G 纯免费本地 AI Agent 全套落地汇总文档》，推荐架构为"Ollama + Hermes-Agent + OpenCode + ECC + nvm"，附完整安装命令与配置。

### 1.3 研究问题
该文档的**命令、模型名、配置结构**是否真实可执行？与本项目现状相比，有哪些增量与哪些破坏风险？

## 2. 声明核验总览

| # | 声明 | 结论 | 置信度 |
|---|------|------|--------|
| 1 | `ollama pull qwen3.5:9b-instruct-q4_K_M` 有效 | ❌ 不实 | 高 |
| 2 | `ollama pull qwen3-code:14b-q4_K_M` 有效 | ❌ 不实 | 高 |
| 3 | Qwen 代码模型 = qwen3-code 系列 | ❌ 不实（正确名 qwen3-coder） | 高 |
| 4 | Hermes 是 npm 项目（clone+npm install+npm run setup） | ❌ 不实（Python/uv） | 高 |
| 5 | Hermes config.yaml 用 llm.* / agent.* / mcp.enabled 结构 | ❌ 不实（字段全错） | 高 |
| 6 | `brew install anomalyco/tap/opencode` 为官方方式 | ✅ 属实 | 高 |
| 7 | OpenCode 配置在 `~/.opencode/config.json` 扁平 JSON | ❌ 不实（已迁移嵌套结构） | 高 |
| 8 | OpenCode 可对接本地 Ollama | ✅ 属实（但须用新配置格式） | 高 |
| 9 | `npx skills add WorldFlowAI/... -g` 是 ECC 官方安装 | ⚠️ 部分属实（仓库真、语法合法，非官方推荐） | 中 |
| 10 | ECC 正确 owner 是 affaan-m，WorldFlowAI 是错的 | ❌ 不实（两仓库均真实存在） | 中 |
| 11 | OLLAMA_KEEP_ALIVE=120 使模型闲置 2 分钟卸载 | ✅ 属实（但取值对 agent 偏短） | 高 |

## 3. 模型存在性（声明 1-3）

### 声明 1：qwen3.5:9b-instruct-q4_K_M
- **结论**：不实。Ollama 官方 qwen3.5 标签页仅列出 `0.8b / 2b / 4b / 9b / 27b / 35b / 122b`（含 -mlx 变体），**无 `-instruct-q4_K_M` 这类后缀标签写法**。正确的 9b 拉取命令是 `ollama pull qwen3.5:9b`（默认 Q4_K_M，6.6GB，9.65B 参数）。
- 文档混淆了"量化格式"与"标签"两个概念：量化是模型的默认属性，不是标签后缀。
- 直接执行文档命令会得到 `model not found` 错误。

### 声明 2：qwen3-code:14b-q4_K_M
- **结论**：不实，双重错误。
  - 命名错误：Qwen 代码模型叫 **qwen3-coder**，不存在 "qwen3-code"（官方页面 404）。
  - 尺寸错误：官方 qwen3-coder 仅有 **30b-A3B（19GB）与 480b-A35B（290GB）** 两档（链式抓取官方 tags 页确认，均为 MoE），**没有 14b dense 档**。
- 用户本机已有的 `qwen2.5-coder:14b-instruct-q3_K_M`（7.34GB）是上一代代码模型，是 16G 机器上现实的编码选择；qwen3-coder 全系超出 16G 单机能力（最小 30b 也需 ~19GB+）。

### 声明 3：Qwen 代码模型系列命名
- 正确认知：官方代码模型沿革为 qwen2.5-coder → qwen3-coder。"qwen3-code" 是不存在的命名。
- 第三方提示：Ollama 社区存在 `frob/qwen3.5-instruct:9b` 等非官方非-thinking 改版，其 README 自述"未使用官方库的 RENDERER/PARSER，工具调用能力弱于 thinking 版"——**agent 场景应避开**。

## 4. Hermes 形态与配置（声明 4-5）

### 声明 4：npm 项目
- **结论**：不实。NousResearch/hermes-agent 主语言为 **Python**（官方要求 Python 3.11 / uv）。官方快速安装为：
  ```
  curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
  ```
  手动安装为 `uv venv` + `uv pip install -e ".[all,dev]"`。
- 文档中的 `npm install` 在项目里**确实出现**，但仅标注 "Optional: browser tools"（可选浏览器工具），项目**没有 `npm run setup`**。
- 与本机实际部署（Python venv `~/.hermes/venvs/hermes`、v0.21.0）完全吻合，进一步反证文档错误。

### 声明 5：config.yaml 结构
- **结论**：不实。文档示例所有字段（`llm.provider`、`llm.endpoint`、`agent.max_concurrent_tasks`、`agent.auto_skill_generation`、`mcp.enabled`、`plugins.auto_load`）**在官方配置中均不存在**。
- 真实结构（对照官方 `cli-config.yaml.example`）顶层为：`database / runtime / model / terminal / compression / memory / skills / agent / gateway / mcp_servers`。
- 与本机实测 `~/.hermes/config.yaml` 吻合：顶层是 `provider: custom`、`base_url: http://localhost:11434/v1`、`extra_body: {temperature, num_ctx}`、`tools.tool_search.enabled: false`。
- **风险提示**：若用户照抄文档 yaml 覆盖现有 config，Hermes 将无法解析配置、直接起不来。这是全文档最具破坏性的一条。

## 5. OpenCode（声明 6-8）

### 声明 6：安装命令
- **结论**：属实。`brew install anomalyco/tap/opencode` 是当前官方推荐 Homebrew 方式（anomalyco/tap 为现官方 tap；旧 `sst/tap/opencode` 已废弃）。备用方式：`npm i -g opencode-ai` 或官方脚本 `curl -fsSL https://opencode.ai/install | bash`。

### 声明 7：配置文件
- **结论**：不实（已过时）。新版配置路径为 **`~/.config/opencode/opencode.json`**（非 `~/.opencode/config.json`），结构需用 **provider 嵌套**，扁平 `{baseUrl, apiKey, model, contextWindow}` 已弃用、不生效。

### 声明 8：对接 Ollama
- **结论**：属实，但必须用新格式。官方推荐 Ollama provider 写法：
  ```json
  {
    "$schema": "https://opencode.ai/config.json",
    "provider": {
      "ollama": {
        "npm": "@ai-sdk/openai-compatible",
        "name": "Ollama (local)",
        "options": { "baseURL": "http://localhost:11434/v1" },
        "models": { "qwen2.5-coder:14b-instruct-q3_K_M": { "name": "Qwen 14b coder" } }
      }
    }
  }
  ```
  （注：OpenCode 能自动发现 127.0.0.1:11434 上的 Ollama 模型，provider id 为 `ollama`。此处 model key 必须与本机 `ollama list` 输出完全一致。）

## 6. ECC 与 Ollama 调优（声明 9-11）

### 声明 9：ECC 安装命令
- **结论**：部分属实。`WorldFlowAI/everything-claude-code` 仓库**真实存在**，`npx skills add owner/repo -g` 语法也合法（`-g/--global`=全局安装，不带 `--skill` 默认装该仓库全部 skills）。但：**该命令不是 ECC 官方推荐安装方式**——官方推荐 Claude Code 内 `/plugin marketplace add affaan-m/everything-claude-code` + `/plugin install`。且 `npx skills add` 只装 `skills/` 目录内容，**不包含 agents/commands/hooks/rules**，"全套技能"表述有误导。
- 本机已装 89 个技能（含 caveman/ponytail/ECC 体系），此步无需执行。

### 声明 10：owner 之争
- **结论**：不实。上一轮人工核查曾断言"WorldFlowAI 是错的、affaan-m 才是对的"，深度检索修正该判断：**WorldFlowAI/everything-claude-code（2026-01 有 README）与 affaan-m/everything-claude-code 均真实存在**，WorldFlowAI 是早期原著名仓库形态，affaan-m 是作者本人账号，官方插件源写 affaan-m。二者都有效，不能说 WorldFlowAI "错"。真正的问题是：**npx skills add 不是官方推荐安装路径**。

### 声明 11：OLLAMA_KEEP_ALIVE
- **结论**：属实。官方定义：单位秒，默认 5 分钟，`-1`=常驻内存，`0`=立即卸载。设 120 确实使闲置 2 分钟卸载。
- **取值建议**：对交互式 agent 2 分钟偏短——每次对话冷加载需 10-100s。多模型换用时建议 5-15 分钟；常驻单一模型用 `-1`。
- 相关变量（一并确认存在）：`OLLAMA_MAX_LOADED_MODELS`（默认 1）、`OLLAMA_NUM_PARALLEL`（默认 1）。

## 7. 与上一轮人工核查的差异记录（诚实修正）

| 上轮结论 | 本轮修正 | 原因 |
|---------|---------|------|
| "WorldFlowAI/everything-claude-code 仓库名写错" | 仓库真实存在，只是非官方推荐安装源 | 上轮只验证了 affaan-m 一侧；本轮 agent 检索到 WorldFlowAI 仓库本体 |
| "`npx skills add ... -g` 不是该 CLI 用法，应 --skill 逐个装" | `-g` 合法、不带 --skill 默认装全部；真正问题是"非官方推荐" | 上轮未查 skills.sh CLI 文档 |
| "qwen3-code 应为 qwen2.5-coder/qwen3-coder" | 确认 qwen3-coder，且官方仅 30b/480b 无 14b | 链式抓取官方 tags 页 |
| "qwen3.5:9b-instruct-q4_K_M 不存在，官方为 qwen3.5:9b" | 维持，补充官方标签全表 | 链式抓取官方 tags 页 |

## 8. 现状对比与行动建议

### 8.1 用户项目 vs 豆包文档（能力对比）

| 维度 | 豆包文档方案 | 用户现状（赫尔墨斯特工） | 胜出 |
|------|------------|------------------------|------|
| 交互界面 | 纯终端 | Web 控制台（SSE 实时工具时间线/历史回显） | 用户 |
| 技能包 | 需装 ECC | 已有 89 技能（含 ECC 体系） | 用户 |
| 安全 | 未提 | 30 条规则安全钩子 + 前端审批 | 用户 |
| 多模态 | "后续扩展" | llava:7b 已可用 | 用户 |
| 记忆/检索 | 未提 | nomic-embed-text 已装 | 用户 |
| 编码子 Agent | OpenCode（建议） | 未装 | 豆包 |
| 定时/网关/MCP | 未提 | 已有接口（cron 网关未起） | 用户 |

### 8.2 建议采纳
1. **引入 OpenCode 作为编码子 Agent**（文档唯一真增量）——Hermes 7B 写代码弱，OpenCode + 本机 14b coder 模型补短板。安装：`brew install anomalyco/tap/opencode`；配置用第 5 节新格式。
2. **OLLAMA_KEEP_ALIVE 放宽**至 10-30 分钟（或常驻模型用 -1），避免 agent 频繁冷加载。

### 8.3 明确忽略
- 全部模型 pull 命令（标签不存在 / 已存在更合适模型）
- 全部 Hermes 安装与 config 操作（环境已就绪，照做会破坏）

### 8.4 既有待修（与本研究无关，但阻塞体验）
1. 两份 launchd plist（launchd/ 旧 + deploy/ 新）抢 4173 → 删一留一
2. `ollama create` 接通 hermes-local-14b / hermes-coder-14b 派生模型
3. 修 `/api/status` 的 ollama.models 解析 bug
4. 起 cron 网关或下线定时任务入口

## 参考文献
见 sources/bibliography.md（12 个来源，含 A-E 评级表）。
