# 赫尔墨斯特工 · 行动清单（2026-09-12 实测版）

> 生成依据：2026-09-12 对运行实例的实测数据与源码核查，**不是沿用旧文档的推断**。
> 与本仓库 `IMPROVEMENT_PLAN.md`（2026-09-11）的关系：那份的 P0-1~P2-9 **已完成**（含 launchd 托管、
> gateway 接线），本文只列**剩余项**，两者不重叠。若冲突，以本文为准（本文更新且有实测支撑）。
>
> 每项的「工作量」为估算，标注 ⚠️ 的表示**尚未实做验证**，实际可能浮动。

---

## 零、先给结论

| 排序 | 事项 | 一句话 | 性价比 |
|---|---|---|---|
| **T1** | 关闭 Hermes 后台 auxiliary 任务 | 一整组后台任务在抢同一个本地模型，且全是默认开启 | ★★★★★（零风险、收益最高、30 分钟） |
| **T2** | Trajectory 进度可视化 | 把用户盯着的 10–23 秒空白变成「看得见的进度」 | ★★★★★（体验改观最直接） |
| **T3** | 崩溃防护：`readBody` / SSE 断连 | 历史崩溃同源，属稳定性地基 | ★★★★☆ |
| **T4** | 「快速/思考」文案修正 | 15 分钟消除误导 | ★★★★☆（极低投入） |
| **T5** | 削减 system prompt（第二步） | 15612 token → 目标 ≤2650 | ★★★★☆（需回归） |
| **T6** | 开启 `tool_search` 延迟加载工具 | 最大单一杠杆，但与原配置注释决策冲突 | ★★★☆☆（收益大·需验证） |
| **T7** | 备份脚本：覆盖 `~/.hermes` 关键配置 | 当前 1.7GB 配置零备份 | ★★★☆☆ |
| **T8** | P1-2 其余加固（A/B/E/F） | 可用性打磨 | ★★☆☆☆ |
| **T9** | PTY 终端面板（参考 OH-DSH） | 能看实时输出 / 能接管 | ★★☆☆☆（成本高） |
| **T10** | Git Review（参考 OH-DSH） | diff 视图 | ★☆☆☆☆ |

**不建议做**（理由见 §四）：目录级写权限限制、接入 OH-DSH 整体 / 插件市场 / 云端多模态。

---

## 一、实测基线（本次决策的全部依据）

### 1.1 延迟归因（P0-1 已结案）

```
HTTP 首字节 80ms → ready@48ms → session@63ms → msg@215ms
   💀 黑洞 23.7 秒 💀
首个 token@23992ms
```

Hermes 自身日志的 smoking gun：

```
API call #1: in=15612 out=188 latency=23.9s cache=15607/15612 (100%)
```

问「你好」两个字，prompt 却是 **15612 token**，占 `context_length: 16384` 的 **95%**。

prefill 长度 → 首 token 延迟，**严格线性**：

| prefill | 首 token |
|---|---|
| 20 tok | 416 ms |
| 2,082 | 7,339 ms |
| 4,175 | 7,945 ms |
| 8,373 | 17,752 ms |
| **16,374** | **42,857 ms** |

> **拟合公式：`延迟 ≈ 2.3 ms/token × N + ~3.9s`**
> 推论（硬约束）：10s → prompt ≤ **~2650**；8s → ≤ ~1780；**5s 物理上不可达**。

### 1.2 本次新发现：auxiliary 后台任务全部默认开启

源码 `agent/auxiliary_client.py`：

```python
# Fail-open (``enabled=True``) so a broken or missing config never disables a background helper.
return is_truthy_value(task.get("enabled"), default=True), task
```

**当前 `~/.hermes/config.yaml` 完全没有 `auxiliary` 段** → 下列后台任务全部按 `enabled=True` 运行：

`title_generation` · `compression` · `review` · `background_review` · `delegation` · `approval` · `moa_reference` · `openrouter_model`（云端）

日志实证它们**每轮都在跑**，且用同一个本地模型 `hermes-local-gemma4`（即另一次 15612-token prefill），反复 timeout 并重试。

> **这就是 T1 排第一的原因：它可能直接砍掉近一半等待，且改动只是一份配置。**

---

## 二、逐项清单

### T1 · 关闭 Hermes 后台 auxiliary 任务 ★★★★★

**做什么**
在 `~/.hermes/config.yaml` 新增 `auxiliary` 段，**逐个**关闭后台任务并每关一项复测一次。

确定可用的配置项（源码 `agent/title_generator.py:95-112` 已确认可关闭路径）：

```yaml
auxiliary:
  title_generation:
    enabled: false      # UI 的 chat.js 已自带唯一标题生成，此处纯重复且抢占
```

其余（名称已确认存在于源码，默认值同为 True）：
`review` / `background_review` / `compression` / `delegation` / `approval` / `moa_reference`

**解决什么 / 收益**
消除与主请求抢占同一个 Ollama 实例的后台模型调用。日志实证 title_generation 反复 timeout+retry。
预期：**首 token 显著下降**（幅度待实测，⚠️ 未经实做验证）。

**实施范围**：仅 `~/.hermes/config.yaml`（**不触碰本仓库任何代码**）。
**工作量**：改配置 10 分钟 + 每项复测约 5 分钟 ≈ **30–40 分钟**。

**前置 / 风险**
- ⚠️ `compression` 与 `micro_compact` 可能有耦合，关前确认不会出现上下文溢出；**建议保留或最后处理**。
- ⚠️ `approval` 与 `background_review` 可能参与安全/审批链路。**若不确定用途，先不关**。
- 每改一项必须重跑一次对话，确认功能无回归再继续。

**推荐策略：先只关 `title_generation`，测出净收益，再决定是否继续关其他。**

---

### T2 · Trajectory 进度可视化 ★★★★★

**做什么**
新增一个「执行轨迹」面板，实时显示当前所处阶段与已耗时，例如：

```
◐ 准备上下文        0.2s ✓
◐ 模型推理中      12.4s ...   ← 实时跳秒
○ 执行工具调用        —
```

数据不必新增：现有 `ready / session / msg / tool / token / done` 事件链已足够驱动。

**解决什么 / 收益**
即使 T1/T5 把真实延迟压到 10 秒，**用户仍要盯 10 秒空白**。Trajectory 把「这台机器卡住了」变成「它在干活」。
**这是唯一能在不解决根因的前提下立即改善体感的手段，且与 T1/T5 完全正交（可并行）。**

**实施范围**：`public/index.html` + `public/app.js`（状态机与渲染）+ `public/app.css`。
**工作量**：⚠️ **1–2 天**（含 `npm run ui` 补冒烟断言）。

**前置 / 风险**
- 必须在 **`msg@215ms` 之后立刻进入可见状态**，否则仍是空白。
- 「阶段」是对 Hermes 内部状态的**推测性映射**，文案不能谎称精确（避免"还剩 X 秒"这类无法兑现的承诺）。
- 与前端三不变量共存：head 内联主题不变、`app.js` 不加 `defer`、不改 ES module。

---

### T3 · 崩溃防护：`readBody` 与 SSE 断连 ★★★★☆

**做什么**（两项，C/D）
- `lib/http.js` 的 `readBody`：正确处理 `aborted` / `close`，客户端中途断开不得抛错。
- SSE 写入遇到 `EPIPE`：不得触发 `unhandledRejection`。

**解决什么 / 收益**
与历史上的 **P0-2 崩溃同源**（二次写头 → `ERR_HTTP_HEADERS_SENT` → unhandledRejection → 进程退出）。
用户中途点「停止」或关标签页，服务不应死。

**实施范围**：`lib/http.js`、`lib/routes/chat.js`。
**工作量**：⚠️ **半天**（含复现用例）。

**验证方式**
1. 半途 `kill` 正在请求的 curl → 断言服务仍活、`/api/health` 的 `uptimeSec` 递增。
2. 断言 stderr 无 `ERR_HTTP_HEADERS_SENT`。
3. 建议把上述固化成 `test/stop.smoke.js` 的新用例。

**前置 / 风险**：低。属纯加固，不改变正常路径行为。

---

### T4 · 「快速/思考」文案修正 ★★★★☆

**做什么**
`public/index.html` 87–89 行两处文案 + `title` 属性改为「折叠思考 / 展开思考」。
`public/app.js` 63 行注释同步更新。**变量名 `chatMode` 与 `localStorage` key 保持不变，行为零变更。**

**为什么这么改**
实测确认：模型 100% 本地（`cloud_providers.json` 为空、`/api/models.cloud` 为空）。
本地 CoT 是**流式**吐的，属于同一个 prefill 过程，因此该开关**既不能省时间也不能省 token**——它纯粹是显示开关，叫「快速」是误导。

**⚠️ 刻意保留的行为**：不同 `chatMode` 下传给模型。
依据项目既有共识——本地小模型关 CoT 会退化为「只说不做」。**这是约束，不是缺陷。**

**工作量**：**15 分钟**。建议并入 T2 同批提交。

---

### T5 · 削减 system prompt（15612 → ≤2650）★★★★☆

**做什么**（在 T1 之后执行，否则收益归因不清）
三路削减：
1. **开 `tools.tool_search`** ← 见 T6，最大单一杠杆，单独做为一项。
2. 复盘 `~/.hermes/skills` 的 **100 个 skills / 46MB** 是否全部进入 system prompt，移除非必要项。
3. 限制记忆自动召回的注入量——日志中已见 `[自动召回的相关历史经验…]` 且内容很长。

**收益**
按 §1.1 拟合公式线性折算。当前 15612 → 目标 ≤2650 对应约 10s。

**工作量**：⚠️ **半天到 1 天**（含每步复测 `in=` token 数）。

**前置 / 风险**
- 每削一项都要复查 Hermes 日志的 `in=` 值，用数据确认有效，别凭感觉。
- 削减过度务必谨慎：本项目已有前车之鉴（见 `config.yaml` 注释）——上下文溢出会导致工具调用失灵。

---

### T6 · 开启 `tool_search` 延迟加载工具 ★★★☆☆

**做什么**
把当前 `~/.hermes/config.yaml` 里的 `tools.tool_search.enabled: off` 改为开启，让工具定义**按需加载**而非全量注入。

源码依据（`tools/tool_search.py:512-538`）：`build_catalog_listing` 有 `max_tokens=4000` 预算与三级降级
（完整清单 → 仅名称 → 按 server 摘要），并有「排序确定以保证 prefix 可缓存」的设计。

**收益**：最大单一杠杆（若 100 个 skills 的工具定义是大头，可直接砍掉数千 token）。

**⚠️ 风险 / 取舍（必须知悉）**
这条与**当初关闭它的决策直接冲突**。原配置注释：

> 关掉工具搜索桥：把 tool_search/tool_describe/tool_call 三个 bridge 工具从模型可见列表移除，
> 让模型只看到原生 tool，**避免把原生工具误当成 bridge 调用**。

即：开启 → prompt 变小，但**可能**出现模型调用 bridge 而非原生工具的行为回退。

| 方案 | 适用场景 | 取舍 |
|---|---|---|
| **A. 保持关闭** | 工具调用正确性优先 | 放弃最大提速杠杆 |
| **B. 开启 + 全面回归**（推荐） | 愿意用 1 小时做工具调用正确性测试换取大幅提速 | 需逐类验证工具仍能正确命中 |

**推荐方案 B**，但**必须**先做工具调用正确性回归；若不通过则回退到 A。

**工作量**：⚠️ **半天**（含回归验证）。依赖：建议 T5 完成、拿到干净基线后再做。

---

### T7 · 备份脚本：覆盖 `~/.hermes` 关键配置 ★★★☆☆

**做什么**
扩展现有 `backup.sh`：除 git bundle 外，额外归档 `~/.hermes` 的关键小件（合计 <1MB）：
`config.yaml`、`ui_workspaces.json`、`ui_token`、`hooks/`、`kb_distilled.md`。

**为什么现在必须提**
当前 `backup.sh` **只备份 git 仓库**，而 `~/.hermes` 有 **1.7GB**（config + 会话 + 100 skills + venvs）**零备份**，
且不在 git 里。磁盘故障 = 配置与安全 hook 全丢。

**范围建议**：
- ✅ 备份：`config.yaml`、`ui_workspaces.json`、`ui_token`、`hooks/`、`kb_distilled.md`
- ❌ 不备份：`state.db`（3MB，可重建）、`venvs/`（1.1GB，可重装）、`node/`（326MB）

**工作量**：⚠️ **1 小时**（含恢复演练）。

**⚠️ 恢复演练必须做** —— 未验证过的备份不算备份。

---

### T8 · P1-2 其余加固 ★★☆☆☆

| 项 | 内容 | 验证方式 |
|---|---|---|
| A | `-z` 建会话失败重试（指数退避 2 次） | mock 首次失败，断言第二次成功且无重复 `session` 事件 |
| B | 标题幂等兜底：外部生成失败时用本地截断标题 | mock createSession 抛错，断言仍能出 `session` 且不崩 |
| E | 工作区 JSON 并发写（多请求同时 assign） | 并发 10 次，断言无丢失更新 |
| F | 空 / 超长 prompt 边界 | 空串 → 400 非 500；>100k → 400 并提示上限 |

**工作量**：⚠️ **1 天**。属打磨，不阻塞任何事。

---

### T9 / T10 · 参考 OH-DSH 的两个面板 ★★☆☆☆ / ★☆☆☆☆

**先说结论：OH-DSH 整体不可接入。**
它是 DeepSeek Harness 的封装，图片输入依赖 **DeepSeek V4 Flash 云端多模态**，插件市场依赖远程 registry
——与本项目 local-first / 无云端 API key 的红线**直接冲突**。但两个**纯前端 UI 模块**值得抄：

| 项 | 内容 | 工作量 ⚠️ | 收益 |
|---|---|---|---|
| T9 PTY 终端面板 | 新 route `/api/pty` + 前端终端面板，能看实时输出 / 能接管命令 | 3 天 | 高，但成本也高 |
| T10 Git Review | 读工作区 git diff + 前端渲染 | 1 天 | 中 |

**风险**
- T9 引入 PTY = 引入**新的攻击面**与会话隔离问题；必须严格限制在项目目录内并复用现有 Bearer 闸门。
- 两者都建议**等 T1–T5 完成后**再评估是否还必要。

---

## 三、推荐批次（依赖关系）

```
批次 1（今天，~1h，零风险）
   T1 关 title_generation  ──┐
   T4 文案修正              ──┴─→ 各自独立，可并行

批次 2（稳地基）
   T3 崩溃防护  ←── 无依赖；建议在任何大改之前完成

批次 3（体验，可与批次 1/2 并行）
   T2 Trajectory  ←── 与 T1/T5 正交，互不阻塞

批次 4（深削延迟，须串行、每步复测）
   T5 削减 prompt ──→ 拿到干净基线 ──→ T6 开 tool_search + 工具回归
       ↑ 依赖 T1 先完成，否则无法归因收益

批次 5
   T7 备份（含恢复演练）

批次 6（视兴趣）
   T8 加固 → T9 PTY → T10 Git Review
```

**关键依赖**
- **T5 必须在 T1 之后**：否则分不清延迟下降来自哪一处。
- **T6 必须在 T5 之后且必须回归**：它有已知的行为回退风险。
- **T2 与所有延迟优化正交**：即使优化全部成功，剩余延迟仍需要它来改善体感。

---

## 四、不建议做（附理由）

| 事项 | 不做的原因 |
|---|---|
| **目录级写权限限制** | 「安全感错觉」比没有隔离更危险。真要做须硬化 `hooks/safety_check.py` 并扩展协议；且 **agent 可通过符号链接、`~` 展开、绝对路径绕过**，要做到真安全需路径规范化 + 沙箱，工作量从半天膨胀到数天且**永不完备**。单人本地助手收益极低。**替代（15 分钟）**：会话头部显示当前工作区的「建议路径」，让工作区回归它本来的语义——**上下文归类**，而非权限边界。 |
| **接入 OH-DSH 整体** | 依赖 DeepSeek 云端模型，与隐私红线冲突。仅可借鉴 UI 模块（T9/T10）。 |
| **OH-DSH 插件市场** | 依赖远程 registry 与云端定价/交易状态。 |
| **OH-DSH 云端多模态** | 本项目已有本地多模态（`/api/vision`、`/api/transcribe`、`/api/upload` 实测均可用）。 |
| **接 5 秒首字目标** | §1.1 拟合公式证明**物理上不可达**（5s 要求 prompt ≤~480 token）。 |

---

## 五、验证基线（改前必跑，改后对比）

| 命令 | 覆盖 | 基线 |
|---|---|---|
| `npm test` | 单测 | 101 |
| `npm run smoke` | 路由冒烟 | 51 |
| `npm run ui` | 浏览器 UI | 38 |
| `npm run health` | 运行时自检 | 21 |
| `npm run test:safety` | 安全 hook | 6 |
| `npm run test:stop` | stop 契约 | 9 |
| `npm run test:chat` | chat 契约 | 6 |

**改前额外必做**（本次新增，用于 T1/T5/T6 的归因）：
记下改配置前 Hermes 日志里的 `in=` / `latency=`，与 `/api/usage` 的 `avgFirstTokenSec24h`，
**每改一项配置记录一次**，否则事后无法判断收益来源。
