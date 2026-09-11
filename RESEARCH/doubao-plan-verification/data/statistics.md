# 数据与统计

## 声明核验统计

| 指标 | 数值 |
|------|------|
| 核验声明总数 | 11 |
| 完全属实 | 3（27%） |
| 部分属实 | 2（18%） |
| 不实 | 6（55%） |
| 置信度=高 | 9 |
| 置信度=中 | 2 |

## 关键事实

| 事实 | 值 | 来源 |
|------|-----|------|
| qwen3.5 官方标签 | 0.8b/2b/4b/9b/27b/35b/122b（+mlx） | ollama.com/library/qwen3.5/tags |
| qwen3.5:9b 大小 | 6.6GB / 9.65B / 默认 Q4_K_M | ollama.com/library/qwen3.5:9b |
| qwen3-coder 官方档位 | 30b-A3B(19GB) / 480b-A35B(290GB) | ollama.com/library/qwen3-coder/tags |
| qwen3-coder 上下文 | 256K | 同上 |
| Hermes 主语言 | Python（uv/venv） | github.com/nousresearch/hermes-agent |
| Hermes 官方安装 | curl install.sh 或 uv pip install -e ".[all,dev]" | hermes-agent.nousresearch.com/docs |
| 本机 Hermes 版本 | v0.21.0 (2026.8.31)，Python venv | 本机实测 |
| 本机已装技能 | 89（~/.hermes/skills） | 本机实测 |
| 本机内存 | 16 GB（统一内存） | 本机实测 |
| OLLAMA_KEEP_ALIVE 默认 | 5 分钟 | Ollama 官方 FAQ |
| OLLAMA_KEEP_ALIVE=-1 | 常驻内存 | 同上 |
| 本机 14b coder 模型 | qwen2.5-coder:14b-instruct-q3_K_M (7.34GB) | 本机实测 |

## 用户现状（本机实测 2026-09-06）

- Ollama 已装模型：hermes-local(7.34GB)、hermes-coder(7.34GB)、qwen2.5:14b-instruct-q3_K_M(7.34GB)、qwen2.5-coder:14b-instruct-q3_K_M(7.34GB)、llava:7b(4.73GB)、nomic-embed-text(0.27GB)、llama3(4.66GB)
- 当前内存：空闲 84%（无模型驻留）
- 服务：4173 端口 Web 控制台存活
- opencode：未安装
