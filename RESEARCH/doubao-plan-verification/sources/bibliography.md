# 参考文献（Bibliography）

> 检索日期：2026-09-05 ~ 2026-09-06。所有 URL 均经实际访问或检索验证。

## 官方文档 / 仓库（A 级）

1. **Ollama**, 2026-09, "qwen3.5 - Tags", https://ollama.com/library/qwen3.5/tags — 官方 qwen3.5 全部标签（0.8b/2b/4b/9b/27b/35b/122b + mlx），链式验证抓取确认无 `-instruct-q4_K_M` 后缀写法。
2. **Ollama**, 2026-09, "qwen3.5:9b", https://ollama.com/library/qwen3.5:9b — 9.65B 参数、6.6GB、默认 Q4_K_M。
3. **Ollama**, 2026-09, "qwen3-coder - Tags", https://ollama.com/library/qwen3-coder/tags — 仅 30b-A3B(19GB)/480b-A35B(290GB)，256K 上下文；链式验证抓取确认无 14b、无 7b。
4. **NousResearch**, 2026, "Hermes Agent"（README）, https://github.com/nousresearch/hermes-agent/ — 主语言 Python；官方快速安装 `curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash`。
5. **Hermes Agent 官方文档**, 2026, "Contributing / Development Setup", https://hermes-agent.nousresearch.com/docs/developer-guide/contributing — 手动安装为 `uv venv` + `uv pip install -e ".[all,dev]"`；npm install 仅标注 "Optional: browser tools"。
6. **Hermes Agent 官方文档**, 2026, "Configuration", https://hermes-agent.nousresearch.com/docs/user-guide/configuration/ — 主配置 `~/.hermes/config.yaml`，顶层含 model:/agent:/mcp_servers:。
7. **NousResearch**, 2026, "cli-config.yaml.example", https://raw.githubusercontent.com/NousResearch/hermes-agent/main/cli-config.yaml.example — 真实顶层字段：database/runtime/model/terminal/compression/memory/skills/agent/gateway/mcp_servers；无 llm: 嵌套。
8. **OpenCode**, 2026-09, "Install", https://opencode.ai/docs — 官方 brew tap `anomalyco/tap/opencode`（core 公式更新更慢）；npm 包 `opencode-ai`；官方脚本 opencode.ai/install。
9. **anomalyco**, 2026, "opencode"（GitHub）, https://github.com/anomalyco/opencode — 当前官方仓库；旧 sst tap 已废弃（Issue #6841）。
10. **OpenCode**, 2026-09, "Config", https://opencode.ai/docs/config — 全局配置位置 `~/.config/opencode/opencode.json`，provider 嵌套结构。
11. **OpenCode**, 2026-09, "Providers / Ollama", https://opencode.ai/docs/providers — Ollama provider 配置片段；自动发现 127.0.0.1:11434。
12. **Ollama**, 持续更新, "FAQ", https://ollama.readthedocs.io/faq — OLLAMA_KEEP_ALIVE 单位秒、默认 5 分钟、-1 常驻、0 立即卸载。

## 社区 / 第三方（C 级）

13. **WorldFlowAI**, 2026-01, "Everything Claude Code" README, https://github.com/WorldFlowAI/everything-claude-code — 仓库真实存在（早期形态）。
14. **affaan-m**, 2026, "ECC", https://github.com/affaan-m/ECC — 作者本人仓库，官方插件源。
15. **LobeHub**, 2026, "Agent skills: npx skills & skills.sh", https://lobehub.com/tr/skills/svemyh-skills-skills-sh — `-g/--global`、`--skill` 参数语义。
16. **53AI**, 2026-05, "npx skills 指南", https://www.53ai.com/news/tishicikuangjia/2026051130182.html — 补充 skills CLI 用法。
17. **ComputingForGeeks**, 2026-08, "Ollama Models Cheat Sheet", https://computingforgeeks.com/ollama-models-cheat-sheet/ — qwen2.5-coder 上一代档位（1.5b/3b/7b/14b/32b）。
18. **ML Journey**, 2026, "Ollama Environment Variables Guide", https://mljourney.com/how-to-configure-ollama-environment-variables-complete-guide — OLLAMA_KEEP_ALIVE 默认 5m 佐证。

## 本机实测（第一手证据，非外部来源）

- Hermes v0.21.0 Python venv 部署（`~/.hermes/venvs/hermes/bin/hermes --version`）
- Ollama 模型清单（hermes-local/hermes-coder/qwen2.5:14b/qwen2.5-coder:14b/llava:7b/nomic-embed-text/llama3）
- `~/.hermes/config.yaml` 实际结构（provider: custom / base_url / extra_body{num_ctx:16384,temperature:0}）
- 16GB 内存、当前空闲 84%
