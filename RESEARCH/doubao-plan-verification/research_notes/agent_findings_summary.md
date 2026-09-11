# 智能体研究发现汇总

> 4 个并行研究智能体（general-purpose），2026-09-06 部署，一次响应并行启动。

## Agent 1 — 模型存在性核验（[agent-bf624094]）

**任务**：核验 qwen3.5:9b-instruct-q4_K_M 与 qwen3-code:14b-q4_K_M 是否真实可拉取。

**发现**：
- `qwen3.5:9b-instruct-q4_K_M` **不实**：官方标签仅 0.8b/2b/4b/9b/27b/35b/122b（+mlx），无 `-instruct-q4_K_M` 后缀。`qwen3.5:9b` 本身真实（6.6GB / 9.65B / 默认 Q4_K_M，digest 6488c96fa5fa）。
- `qwen3-code:14b-q4_K_M` **不实（双重错误）**：官方 qwen3-code 页面 404；正确名 qwen3-coder，且仅 30b(19GB)/480b(290GB)，**无 14b 档**。
- 命名沿革：qwen2.5-coder（1.5b~32b）→ qwen3-coder（30b/480b，均 MoE）。
- **额外提醒**：第三方 frob/qwen3.5-instruct:9b README 自述"未使用官方库 RENDERER/PARSER，工具调用能力弱于 thinking 版"→ agent 场景应避开第三方 instruct 改版。
- 建议本机 `ollama pull qwen3.5:9b` / `ollama list` 实测确认。

## Agent 2 — Hermes 形态与配置核验（[agent-54dc0eb9]）

**任务**：核验 Hermes 是否 npm 项目、config 字段是否如文档所述。

**发现**：
- Hermes 是 **Python** 项目（uv/venv/Python 3.11，hermes_cli 包），官方安装 `curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash`。
- 手动安装：`git clone https://github.com/NousResearch/hermes-agent.git` → `uv venv venv --python 3.11` → `uv pip install -e ".[all,dev]"`。
- `npm install` 仅出现于 "Optional: browser tools"，**无 `npm run setup`**。
- config 文档字段**全部不存在**：无 `llm:` 嵌套、无 `mcp.enabled`、无 `plugins.auto_load`。真实对应：`model.provider`/`model.base_url`/`model.default`、顶层 `max_concurrent_sessions`、`mcp_servers:`。无顶层 temperature。
- 与用户 Python venv v0.21.0 部署完全吻合。

## Agent 3 — OpenCode 安装与配置核验（[agent-46ce5b5e]）

**任务**：核验 brew tap、配置文件路径与 Ollama 对接写法。

**发现**：
- `brew install anomalyco/tap/opencode` **属实**（官方推荐 tap；core 公式由 Homebrew 团队维护更新更慢；旧 sst tap 废弃）。
- 配置路径**已迁移**：`~/.config/opencode/opencode.json`，provider 嵌套结构；扁平 `{baseUrl,apiKey,model,contextWindow}` 弃用不生效；`contextWindow` 非顶层字段。
- 对接 Ollama **可行**：provider id `ollama`，自动发现 127.0.0.1:11434；官方片段为 `provider.ollama.{npm:"@ai-sdk/openai-compatible", options.baseURL, models}`。
- 提示：工具调用异常时把 Ollama num_ctx 调大到 16k-32k。

## Agent 4 — ECC 与 Ollama 调优核验（[agent-174747c8]）

**任务**：核验 ECC 安装命令与 OLLAMA_KEEP_ALIVE。

**发现**：
- `WorldFlowAI/everything-claude-code` 仓库**真实存在**（2026-01 README），语法合法（`-g`=全局）。但**非官方推荐安装**——ECC 官方推荐 Claude Code `/plugin marketplace add affaan-m/everything-claude-code` + `/plugin install`；npx skills add 只装 skills/，不含 agents/commands/hooks/rules。
- 上轮"affaan-m 是唯一正确 owner、WorldFlowAI 错、须 --skill 逐个装"的断言**不实**：WorldFlowAI 是合法 owner（作者 affaan-m 的早期组织形态/镜像），`--skill` 非必填，`-g` 合法。
- OLLAMA_KEEP_ALIVE=120 **属实**：秒为单位，默认 5m，-1 常驻，0 立即卸载。agent 场景 2 分钟偏短，建议 5-15m 或 -1。
- 相关变量确认存在：OLLAMA_MAX_LOADED_MODELS（默认 1）、OLLAMA_NUM_PARALLEL（默认 1）。

## 交叉引用与三角验证结论
- 声明 1/2/4/5/7：三个以上独立来源 + 官方 A 级来源一致 → 结论稳定。
- 声明 9/10：双仓库并存、官方推荐路径唯一 → 部分属实/中置信。
- 无来源间重大矛盾；唯一分歧（ECC owner）已通过"两仓库都真实、区别在官方推荐路径"解决。
