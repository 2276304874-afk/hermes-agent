# 执行摘要：豆包方案 vs 赫尔墨斯特工现状

## 背景
用户收到一份 AI 生成的本地 Agent 部署文档（目标：Mac M4 16G、100% 免费纯本地），要求与本项目（已运行的 Ollama + Hermes v0.21.0 + 899 行 Web 控制台）对比核验。本研究部署 4 个并行研究智能体，对文档 11 条核心声明做多来源验证，并对关键声明做链式复查。

## 关键发现

1. **两个模型标签不存在**：`qwen3.5:9b-instruct-q4_K_M` 与 `qwen3-code:14b-q4_K_M` 均为虚构标签。官方 qwen3.5 标签只到 `qwen3.5:9b`（无 `-instruct-q4_K_M` 后缀写法）；官方代码模型为 `qwen3-coder`（仅 30b/480b），不存在 "qwen3-code" 命名，也无官方 14b 档。（来源：Ollama 官方 library 页面，A 级）

2. **Hermes 被误写为 npm 项目**：文档的 `git clone … && npm install && npm run setup` 与真实项目不符。Hermes Agent 是 **Python** 项目（uv/venv 安装，官方安装脚本为 `curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash`），npm 仅用于可选的浏览器工具。（来源：NousResearch 官方仓库与文档，A 级；与本机 Python venv v0.21.0 部署完全吻合）

3. **config.yaml 结构全错**：文档示例（`llm.provider`、`agent.max_concurrent_tasks`、`mcp.enabled`、`plugins.auto_load`…）所有字段均不存在。真实顶层字段为 `model:`（default/provider/base_url）、`agent:`（max_turns…）、`mcp_servers:` 等（对照官方 `cli-config.yaml.example`）。照抄会覆盖损坏现有可运行配置。（A 级）

4. **OpenCode 安装命令正确，但配置格式已过时**：`brew install anomalyco/tap/opencode` 是当前官方 tap（A 级）。但配置路径不再是 `~/.opencode/config.json`，而是 `~/.config/opencode/opencode.json`，且需 provider 嵌套结构（非扁平 baseUrl/apiKey），扁平写法已弃用不生效。（A 级）

5. **ECC 技能包命令部分失真**：`WorldFlowAI/everything-claude-code` 仓库真实存在且 `-g` 语法合法，但该命令**不是 ECC 官方推荐安装方式**（官方推荐 Claude Code `/plugin marketplace add affaan-m/everything-claude-code`），且 `npx skills add` 只装 skills/ 目录、不装 agents/commands/hooks/rules，"全套技能"表述有误导。本机已装 89 个技能，此步无需重做。（B-C 级）

6. **OLLAMA_KEEP_ALIVE=120 属实但取值偏激**：变量真实、单位秒、默认 5 分钟、`-1` 常驻、`0` 立即卸载（官方 FAQ，A 级）。对交互式 agent，2 分钟会导致频繁冷加载（10-100s），建议放宽。

7. **本研究修正了上一轮人工核查的两处判断**：a) WorldFlowAI 并非"错的 owner"，仓库真实存在；b) `npx skills add owner/repo` 不带 `--skill` 默认装全部技能、`-g` 是合法全局参数——上一轮"必须 --skill 逐个装"的说法不准确。详见完整报告第 7 节。

## 建议
- **采纳**：引入 OpenCode 作为编码子 Agent（文档唯一真增量），本机已有 14b coder 模型可直接对接。
- **忽略**：全部安装命令与 config 片段——本机环境已就绪且更先进，重跑会造成破坏而非升级。
- **待修**（与文档无关的既有问题）：删重复 plist 止崩溃循环 → `ollama create` 接通 14b → 修 /api/status 解析 bug → 起 cron 网关。

## 方法论摘要
- 4 个并行研究智能体（模型存在性 / Hermes / OpenCode / ECC+Ollama）
- 关键声明链式复查（ollama.com 官方 tags 页直接抓取验证）
- 7 阶段流程 + A-E 来源质量评级
- 共引用 12 个独立来源

## 局限性
- 2026 年新模型（qwen3.5 / qwen3-coder）生态变化快，报告以 2026-09-05/06 抓取为准。
- ECC 相关仓库存在同名/镜像情况（WorldFlowAI vs affaan-m），归属关系以检索到的 README 与官方文档为准，未做 git 级血缘分析。
- 第三方 Ollama 模型（frob/qwen3.5-instruct:9b）质量无法在本机实测，仅据其 README 声明评估。
