# 关键事实与来源映射

## 声明 → 支持来源 映射

| 声明 | 结论 | 支持来源 |
|------|------|---------|
| S1: qwen3.5:9b-instruct-q4_K_M | 不实 | [S1][S2] |
| S2: qwen3-code:14b | 不实 | [S3] |
| S3: Qwen 代码模型命名 | 不实 | [S3][S4] |
| S4: Hermes 是 npm | 不实 | [S5][S6] |
| S5: Hermes config 字段 | 不实 | [S7][S8] |
| S6: brew anomalyco tap | 属实 | [S9][S10] |
| S7: 扁平 config.json | 不实 | [S11][S12] |
| S8: 对接 Ollama | 属实 | [S11][S12] |
| S9: ECC npx 命令 | 部分属实 | [S13][S14][S15] |
| S10: owner 之争 | 不实 | [S13][S15] |
| S11: OLLAMA_KEEP_ALIVE | 属实 | [S16][S17] |

## 来源清单（编号对照 bibliography.md）

- [S1] ollama.com/library/qwen3.5/tags（链式验证抓取）
- [S2] ollama.com/library/qwen3.5:9b
- [S3] ollama.com/library/qwen3-coder/tags（链式验证抓取）
- [S4] ComputingForGeeks, 2026-08, Ollama Models Cheat Sheet
- [S5] github.com/nousresearch/hermes-agent README
- [S6] hermes-agent.nousresearch.com/docs/developer-guide/contributing
- [S7] hermes-agent.nousresearch.com/docs/user-guide/configuration
- [S8] raw.githubusercontent.com/NousResearch/hermes-agent/main/cli-config.yaml.example
- [S9] opencode.ai/docs（Install）
- [S10] github.com/anomalyco/opencode
- [S11] opencode.ai/docs/config
- [S12] opencode.ai/docs/providers
- [S13] github.com/WorldFlowAI/everything-claude-code（2026-01 README）
- [S14] github.com/affaan-m/ECC
- [S15] LobeHub skills CLI 文档 / 53AI npx skills 指南
- [S16] ollama.readthedocs.io/faq（官方 FAQ）
- [S17] mljourney.com Ollama 环境变量指南

## 未经验证/低置信事项

- frob/qwen3.5-instruct:9b 的实际工具调用表现（仅据 README 自述，未本机实测）
- ECC 两仓库（WorldFlowAI vs affaan-m）的 git 级血缘关系
- Hermes / OpenCode 在 16G M4 上叠加运行的真实内存占用峰值
