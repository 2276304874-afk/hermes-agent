# 来源质量评级表（A-E）

## 评级标准
- **A（优秀）**：官方文档、官方 GitHub 仓库、监管机构
- **B（良好）**：知名厂商文档、权威技术出版物
- **C（可接受）**：技术博客、社区文档、知名新闻
- **D（较弱）**：无编辑监督的博客、众包内容
- **E（很差）**：匿名、过时、链接失效、明显偏见

## 评级表

| 编号 | 来源 | 类型 | 评级 | 理由 | 支撑声明 |
|------|------|------|------|------|---------|
| S1 | ollama.com/library/qwen3.5/tags | 官方 | A | Ollama 官方模型库，实时页面 | S1 |
| S2 | ollama.com/library/qwen3.5:9b | 官方 | A | 同上 | S1 |
| S3 | ollama.com/library/qwen3-coder/tags | 官方 | A | 同上 | S2, S3 |
| S4 | ComputingForGeeks Cheat Sheet | 技术博客 | C | 聚合类信息源，作佐证 | S3 |
| S5 | github.com/nousresearch/hermes-agent | 官方仓库 | A | 项目主语言与安装入口 | S4 |
| S6 | hermes-agent.nousresearch.com/docs/developer-guide | 官方文档 | A | 开发环境搭建步骤 | S4 |
| S7 | hermes-agent.nousresearch.com/docs/user-guide/configuration | 官方文档 | A | 配置路径与顶层结构 | S5 |
| S8 | cli-config.yaml.example | 官方源码 | A | 配置逐字原文，最权威 | S5 |
| S9 | opencode.ai/docs (Install) | 官方文档 | A | 安装方式 | S6 |
| S10 | github.com/anomalyco/opencode | 官方仓库 | A | 仓库归属与 tap 状态 | S6 |
| S11 | opencode.ai/docs/config | 官方文档 | A | 配置文件规范 | S7 |
| S12 | opencode.ai/docs/providers | 官方文档 | A | Ollama provider 写法 | S8 |
| S13 | github.com/WorldFlowAI/everything-claude-code | GitHub 仓库 | B | 真实存在，但 README 完整度有限 | S9, S10 |
| S14 | github.com/affaan-m/ECC | GitHub 仓库 | A | 作者官方仓库 | S9 |
| S15 | LobeHub skills CLI 文档 | 第三方文档 | C | 参数语义佐证 | S9, S10 |
| S16 | 53AI npx skills 指南 | 第三方博客 | C | 补充佐证 | S9 |
| S17 | ollama.readthedocs.io/faq | 官方 FAQ | A | KEEP_ALIVE 语义权威来源 | S11 |
| S18 | ML Journey 环境变量指南 | 技术博客 | C | 佐证 | S11 |

## 质量汇总
- A 级：11 个（占 61%）
- B 级：1 个
- C 级：5 个
- 无 D/E 级来源

## 关键声明来源质量评估

### 声明 1（qwen3.5 标签不存在）
来源全部为 Ollama 官方 library（A 级），且经 WebFetch 链式直接抓取页面确认 → **置信度：高**

### 声明 5（Hermes config 字段错误）
官方 config.example（A 级）逐字对照 + 本机实测 config.yaml 双证据 → **置信度：高**

### 声明 9/10（ECC 仓库归属）
涉及 WorldFlowAI（B 级）与 affaan-m（A 级）双仓库，二者关系未做 git 血缘分析 → **置信度：中**
