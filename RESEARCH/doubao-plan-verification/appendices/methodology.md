# 方法论

## 研究流程（7 阶段）
1. **问题范围界定**：将"豆包文档是否可照做"收敛为 11 条可证伪的具体声明（模型名/安装方式/配置结构/环境变量）。
2. **检索规划**：按主题分派 4 个子领域（模型存在性、Hermes、OpenCode、ECC+Ollama），每领域预置 3-5 条搜索查询。
3. **迭代查询（多智能体并行）**：一次响应内并行启动 4 个 general-purpose 智能体，各自独立 WebSearch/WebFetch。
4. **来源三角验证**：对每条声明收集 ≥2 个独立来源，识别并解决矛盾（ECC owner 之争）。
5. **知识综合**：按声明编号组织，输出结论/证据/评级/置信度/备注五段式。
6. **质量保证（链式验证）**：对全报告基石声明（qwen3.5 标签表、qwen3-coder 档位表）由主控 WebFetch 官方页面二次直抓确认。
7. **输出打包**：标准 RESEARCH/ 目录 8+ 文件。

## 多智能体部署
- 智能体总数：4（+1 主控链式验证）
- 类型：网络研究 ×4（无独立学术/交叉引用子 Agent——本主题为工具事实核查，非学术命题，4 路并行的来源重叠已起交叉验证作用）
- 执行方式：单次响应并行（非后台）

## 引用体系
- 每条声明附带：来源编号、组织、日期、标题、URL
- A-E 评级：官方文档/仓库 = A；GitHub 仓库 = A/B；第三方博客 = C
- 评级表见 sources/source_quality_table.md

## GoT（Graph of Thoughts）应用
- Generate(4)：从 root 生成 4 条研究路径
- Score：以"来源质量+多源一致性"给每条声明赋置信度（高 9 条/中 2 条）
- Aggregate：合并 4 Agent 发现 → 主题聚类（模型/安装/配置/调优）
- Refine：修正上一轮人工核查的 2 处判断（详见 full_report 第 7 节）

## 本机实测证据（第一手）
- `~/.hermes/venvs/hermes/bin/hermes --version` → v0.21.0
- Ollama `/api/tags` → 7 个模型清单
- `~/.hermes/config.yaml` 实际字段
- `sysctl hw.memsize` → 16GB；memory_pressure → 空闲 84%
