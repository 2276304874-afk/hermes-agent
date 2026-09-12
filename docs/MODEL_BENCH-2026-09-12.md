# 14b 模型对比实验报告（2026-09-12）

> 结论先行：**现役 `hermes-local-gemma4` 在这台 16G 机器上全面胜出，维持不换**。
> 唯一值得保留的备胎是 `qwen3.5:9b`（6.6GB，agent 任务成功且只慢 1.65×）；
> 两个 14b 模型在本机被内存 swap 拖垮，agent 场景不可用。复测 32G+ 机器后再议。

## 一、实验设计

| 项 | 内容 |
|---|---|
| 待对比模型 | `hermes-local-gemma4`(9.61GB, 基线) · `hermes-bench-q314`(qwen3:14b, 9.28GB) · `hermes-bench-q2514`(qwen2.5:14b, 8.99GB) · `hermes-bench-q359`(qwen3.5:9b, 6.59GB) |
| 公平性处理 | 全部派生自本地权重、**参数完全一致**（num_ctx=16384, temp=0.6, top_p=0.95, top_k=64, num_predict=4096）——不派生会被 Ollama 低内存默认 num_ctx=4096 坑掉（cosplay 工具调用） |
| 测试条件 | 同机 16G 统一内存；每模型测前 `keep_alive:0` 卸载其余模型；同一组 prompt；Ollama 官方计时字段取数 |
| 微基准 | 冷加载耗时 → 8,195 token 模拟 system prompt 的 TTFT/prefill 吞吐 → 生成吞吐 → JSON 工具调用合规 ×3 |
| agent 级 | 真实 Hermes `-z` 工具循环任务：数出目录下 7 个 .txt 并写入 count.txt（绝对路径，规避 cwd 干扰）；判据=文件内容==7 |
| 脚本 | `scripts/model-bench.js`（微基准）· `scripts/model-bench-agent.sh`（agent 级），可随时复测 |

## 二、结果总表

| 指标 | gemma4 (基线) | qwen3:14b | qwen2.5:14b | qwen3.5:9b |
|---|---|---|---|---|
| 磁盘体积 | 9.61 GB | 9.28 GB | 8.99 GB | **6.59 GB** |
| 冷加载 | **3.7s** | 7.0s | 6.6s | 5.2s |
| TTFT（8.2K tok 冷 prefill） | **34.4s** | 267.4s | 220.1s | 250.5s |
| prefill 吞吐 | **271 tok/s** | 47 | 37 | 85 |
| 生成吞吐 | **25 tok/s** | 4 | 4 | 8 |
| JSON 合规（纯 chat） | 3/3 | 3/3 | 3/3 | 3/3 |
| agent 任务 | ✅ 165s | ⚠️ 698s | ❌ 513s 算错 | ✅ 273s |
| agent 工具调用（state.db 实测） | 2 次，全部正确 | 2 次 | 3 次（含算错） | 2 次 |

*注：微基准 prompt 实际 8.2K token（中文合成文本）。真实 agent system prompt 为 15.6K token，
冷 prefill 时间按吞吐线性放大：gemma4 ≈ 57s，qwen 14b ≈ 5.5~7 分钟/轮。*

## 三、逐项分析

### 1. 速度：14b 在 16G 机器上被 swap 拖垮（决定性因素）
gemma4（gemma4:e4b，有效 ~4B 参数）prefill 271 tok/s；两个 14b 只有 37~47 tok/s——**差 6~7 倍**，
生成更是 4 tok/s vs 25 tok/s。根因是内存：9GB 权重 + KV cache + macOS 常驻在 16G 上必然部分
落盘 swap，Metal 计算被 IO 淹没。**这不是模型好坏问题，是资源约束问题**——32G 机器上大概率反转。

### 2. agent 可靠性：速度慢还会放大成"伪完成"
- **qwen3:14b** 第一轮（cwd 相对路径版）18.5 分钟后声称"完成了"，但 state.db **零工具调用**——
  纯幻觉执行；第二轮（绝对路径版）正常调用工具并算对。同任务两次行为不一致 = 能力有但**不稳定**。
- **qwen2.5:14b** 工具循环最完整（search→terminal→write_file 三连），但**把 7 个文件数成了 5**，
  write_file 还"verified:true"——能力性错误比超时更危险，因为它会**自信地交付错误结果**。
- **gemma4** 两轮均正确调用工具；**qwen3.5:9b** 干净利落 273s 完成。
- 三个模型 JSON 合规都是 3/3——纯 chat 场景 qwen 们没问题，**差距只在真实 agent 循环里显形**。

### 3. 首字延迟（用户最敏感的体验指标）
以真实 15.6K system prompt 换算冷 prefill：gemma4 ≈ 57s（有 KV cache 时实测 8.9~11.7s），
qwen 14b ≈ 5.5~7 分钟**每轮**，且 agent 每次工具循环后都要重新 prefill——多轮任务完全不可接受。

### 4. 内存与多模型共存
qwen3.5:9b（6.6GB）比 gemma4 少占 3GB——若未来要"agent 模型 + 视觉/嵌入模型"同时常驻，
q359 是唯一可行组合；gemma4 的多模态一体（视觉+音频）优势则部分抵消这一点。

## 四、推荐

| 场景 | 选什么 | 理由 |
|---|---|---|
| **常驻 agent 主模型（现状维持）** | `hermes-local-gemma4` | 速度 6 倍 + 可靠性最佳 + 多模态一体；16G 上的最优解 |
| 低内存/多模型共存备胎 | `hermes-bench-q359`（可改名收编） | 6.6GB、agent 成功、只慢 1.65×；省出的 3GB 给系统或其他模型 |
| ❌ 不建议 | qwen3:14b / qwen2.5:14b | 本机 swap 拖垮 + 不稳定/算错；**32G+ 机器再复测**（届时大概率反转） |
| 编程专精补位 | `hermes-coder-14b` Modelfile 已备 | 同样受 16G 约束，建议仅在单轮代码生成（非 agent 循环）场景手动切换使用 |

### 附：实验过程的两个额外收获
1. **`-z` 的 `--in` 不约束 terminal 工具 cwd**（写入落到了 `$HOME`）——生产路径 server spawn 时
   显式 `cwd: WORKSPACE` 所以 UI 不受影响，但任何直接调 CLI 的脚本要注意。
2. **agent 级测试必须从 state.db 读工具调用**（stdout grep 不到），且 prompt 用绝对路径——
   本次第一轮结果全部被 cwd 污染，已修正脚本后重测。
