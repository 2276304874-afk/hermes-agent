# 改造方案：`hermes -z` 每轮起进程 → `hermes serve` 常驻后端

> 2026-09-10 · 状态：**待评审**（尚未动 server.js）
> 目标：消除每轮 25.7s 的 Hermes CLI 冷启动，把首字延迟从「秒级十几秒」压到「亚秒级」。

---

## 1. 实测数据（已复测，机器空闲、e4b 驻留）

| 路径 | 冷首字 | 热首字（同会话第 2 轮） | 整轮（热） |
|---|---|---|---|
| 现状 `hermes -z`（每轮 spawn 新进程） | 96.3s | 37.1s | — |
| `hermes serve`（常驻后端） | **16.6s** | **0.7s** | 6.0s |

- 「冷」= 新 session，前缀缓存未命中；「热」= 同 session 第 2 轮，前缀缓存命中。
- 另外：agent ready（后端可收 prompt）**25.7s → 0.06s**（约 400×）。
- 冷首字 16.6s 的构成 = 模型 prefill 8K token（system + skills + 工具 schema）+ 生成启动；**与 Hermes 冷启动无关**，改不掉也不需要改。
- 用户实际感知的是**热路径（第 2 轮起）**：37.1s → 0.7s，**约 53×**。

**结论：值得改。收益集中在多轮对话，单轮收益有限但仍有 5.8×。**

---

## 2. 改造范围

只动 `server.js` 一个文件。前端 `public/index.html` 与 SSE 协议**完全不动**。

| 位置 | 改动 |
|---|---|
| 新增 `ensureServe()` | 启动时确保 9119 后端在跑（spawn 或复用），记 PID；退出时清理 |
| 新增 `getServeToken()` | `GET http://127.0.0.1:9119/` 抓 `__HERMES_SESSION_TOKEN__` |
| 新增 `ServeClient` | 单条 WS 长连接，JSON-RPC 请求/响应 + 事件分发 |
| `handleChat`（L700-833） | 重写主体：`spawn(HERMES,…)` → `WS session.create/prompt.submit`；事件 → 现有 `sse()` |
| `tailStreamFile` / oneshot 补丁自愈（L122-146, L668-697） | **删除**（serve 原生流式，不再需要往 oneshot.py 打补丁） |
| `req.on('close')` | `child.kill()` → `session.interrupt` |
| `LOCAL_MODELS`（L53） | 清掉已删除的 `qwen2.5:7b` / `hermes-local` 幽灵项 |

---

## 3. 接口映射表（已核实源码）

### RPC（server.js → serve，`tui_gateway/`）

| 用途 | 方法 | 参数 | 源码 |
|---|---|---|---|
| 建会话 | `session.create` | `{cols, source, cwd, model, provider, reasoning_effort, fast, profile, messages, title, close_on_disconnect}` | `methods_session.py:296` |
| 续会话 | `session.resume` | `{session_id, eager_build}` | `methods_session.py:787` |
| 发消息 | `prompt.submit` | `{session_id, text, queued}` → 返回 `{"status":"streaming"}`，**异步** | `methods_prompt.py:534` |
| 中断 | `session.interrupt` | `{session_id}` | `methods_session.py:1922` |
| 审批应答 | `approval.respond` | `{session_id, choice, all, request_id}` | `methods_prompt.py:1154` |
| 会话级 yolo | `config.set` | `{key:"yolo", value:true, session_id}` | `methods_config_set.py:252,450` |
| 事件回放 | `session.events.since` | `{session_id, seq}` | `methods_session.py:2122` |

- `cwd` 参数 = 现有 `--in WORKSPACE`。
- `model` + `provider` 参数 = 现有 `-m model --provider X`。
- `_create_overrides`（`methods_session.py:278`）确认模型覆盖是**会话级**，不写全局 config。

### 事件（serve → server.js）

帧结构：`{"jsonrpc":"2.0","method":"event","params":{"type":"<EVENT>","session_id":"…","payload":{…},"seq":N}}`

| serve 事件 | payload | 映射到现有 SSE |
|---|---|---|
| `message.start` | — | 忽略（或 `ready` 已发） |
| `message.delta` | `{text}` | `token` ✅ |
| `message.complete` | `{text, status}` | `done`（**这是终止事件**） |
| `reasoning.delta` | `{text, verbose?}` | 新增 `reasoning`，或并入折叠区 |
| `thinking.delta` | `{text}` | 忽略（Hermes 自己的 UI 心跳，非模型输出） |
| `reasoning.available` | `{text, verbose?}` | 新增 `toolnotice`（工具预览，原用 DB `tool` 行） |
| `tool.started` / `tool.completed` / `tool.failed` | `{tool, preview, is_error, tool_call_id}` | 新增 `tool` 事件 |
| `session.info` | `{model, provider, approval_mode, yolo, tools, …}` | 内部状态（用于 ready 回填） |
| `session.title` | `{session_id, title}` | 新增 `title` |
| `status.update` | `{kind, text}` | `notice` |
| `approval.request` | approval payload | 新增 `approval`（前端需处理，见风险 R3） |
| `sessions.changed` / `session.reclaimed` | — | 忽略 |

---

## 4. 关键技术决策

### D1. session 生命周期：复用而非重建
- 现有前端传 `body.sessionId`（来自 `state.db`）。
- 改造后：`sessionId` 存在 → `session.resume {session_id}`；不存在 → `session.create`。
- serve 进程内 session 常驻 ⇒ **热路径成立**（第 2 轮复用前缀缓存）。若每轮重建 session，热路径收益归零。
- ⚠️ 现有 `sessionId` 来自 `state.db` 的 `20260910_200246_236a2c` 格式，而 serve 内部 sid 是 `e1aee924` 这种 runtime id。**必须核实两者对应关系**（`session.info.payload.session_id` 里带 stored id，见实测帧 `{"session_id":"20260910_200246_236a2c"}`）→ 实施第一步就要验证 `session.resume` 能否用 DB 的 stored id。

### D2. 单连接 vs 每请求连接 —— ⚠️ 已由实测定案：**必须共享长连接**
**2026-09-11 R1 实测（`state.db` 的 `cache_read_tokens` 是直接证据）**：

| 场景 | 热首字 | cache_read |
|---|---|---|
| **同一条 WS 连接，同 session 第 2 轮** | **0.4s** ✅ | 16380 ✅ |
| 新开 WS + `session.resume(stored id)` | **63.4s** ❌ | 0 ❌ |

→ **差 150 倍。`session.resume` 会把收益全部吃光，绝不能走这条路。**
（补充：`session.resume` 功能是通的——能接受 stored id 并返回同一个 runtime sid，
所以「能不能续」不是问题，「续了之后缓存全丢」才是问题。）

**根因**：serve 的 system prompt **每个会话的哈希都不一样**（实测 3 个 serve 会话得到
3 个不同 `system_prompt_hash`：`5a51fa0d` / `b2e61876` / `01873150`），而 CLI 路径的
system prompt 是**稳定的**（`caf6915d` 复现 4 次，`cache_read` 13971~28450）。
只要 system prompt 一变，Ollama 的前缀缓存就整体失效，16K token 全部重新 prefill。
推测变量是 cwd / 会话级上下文被写进了 system prompt（待验证）。

**因此架构必须这样**：
- server.js 持有**一条常驻共享 WS**（进程级单例，断线自动重连）。
- 多请求用 JSON-RPC `id` 区分；事件按 `params.session_id` 分发到各自的 SSE 流。
- session 一旦建立就**长期挂在 serve 里**，不 resume、不重建。
- 已有 session 映射（UI 的 stored id ↔ serve runtime sid）缓存一份在内存；
  serve 重启才需要重建（此时接受一次冷 prefill）。
- **降级须知**：若共享连接断开且重连失败，回退到 `-z` 路径比"新建连接 + resume"更快
  （后者 63.4s，比现状 18.7s 还慢 3 倍）。

### D3. 进程归属
- server.js 负责 spawn `hermes serve --skip-build --port 9119`，并记录 PID。
- 若 9119 已被占用（用户手动启动），**复用**，不接管生命周期（不 kill）。
- **不要**依赖 `hermes serve --stop`（实测杀不掉手动启动的进程，需按端口 `kill`）。

### D4. allowDangerous → 会话级 yolo
- 现状：`HERMES_UI_BYPASS_SAFETY=1` 环境变量 + pre_tool_call hook。
- 改造后：`session.create` 后若 `allowDangerous`，发 `config.set {key:"yolo", value:true, session_id}`。
- ⚠️ **hook 仍然生效**（hooks 在 `~/.hermes/hooks`，与传输方式无关）——这是安全底线，不能丢。

### D5. 真流式补丁退役
- `oneshot.py` 的 `HERMES_STREAM_FILE` 补丁（server.js L122-146 自愈）**整体删除**。
- serve 原生 `message.delta`，比「tail 文件 + 轮询 150ms」更低延迟、更少 IO。

### D6. `state.db` 轮询保留与否
- 建议**保留**为兜底（serve 事件偶发丢帧时靠 DB 补全历史），但降级为「非首字路径」。
- 首字完全走 WS，不再受 150ms 轮询节流。

---

## 5. 风险点

| # | 风险 | 等级 | 缓解 |
|---|---|---|---|
| R1 | ~~`session.resume` 不接受 DB stored id~~ → **已验证：功能通过，但续接后前缀缓存全丢（63.4s）** | **高** | **不采用 resume**。改用进程级共享 WS 长连接（见 D2），实测 0.4s |
| R2 | 单条共享 WS 的多路复用做错 → 事件串流、串话 | 中 | 先做「每请求一条 WS」（D2） |
| R3 | 前端不认识 `approval.request` → 危险命令静默卡死 | **高** | 二选一：①后端自动 `approval.respond {choice:"deny"}` 兜底 + 日志；②前端加审批 UI（工作量大）|
| R4 | serve 进程泄漏（孤儿） | 中 | server.js 记录 PID；launchd 重启时先按端口清理；`session.close` 收尾 |
| R5 | serve 版本升级后事件名漂移 | 中 | 事件名集中为一个常量表，未知事件记日志不崩 |
| R6 | 内存：serve 常驻额外占用 | 低 | 实测 serve 是 Python 进程，本机 16G，e4b 驻留 3.3G，余量充足 |
| R7 | 冷首字仍有 16.6s | 中 | 已知不可消除（模型 prefill）；前端加「思考中」进度提示（serve 的 `thinking.delta` 正好可用） |

---

## 6. 回滚路径

改造前先做**双路径开关**：

1. `server.js` 顶部加 `const USE_SERVE = process.env.HERMES_USE_SERVE !== '0';`
2. `handleChat` 开头分支：`USE_SERVE ? handleChatServe() : handleChatSpawn()`（旧的 `spawn` 逻辑原样保留、不删）。
3. 出问题：`launchd` plist 加 `HERMES_USE_SERVE=0` → `kickstart` → 立刻回到现状。
4. 稳定运行 ≥1 周后再删旧路径 + oneshot 补丁。

**这是硬要求。不要一上来就删 `spawn` 路径。**

---

## 7. 实施步骤（每步可独立验证）

| 步 | 内容 | 验证 |
|---|---|---|
| 1 | 验证 `session.resume` 能否吃 DB stored id | python 脚本：create → 拿 stored id → 新连接 resume → submit，热首字 < 2s |
| 2 | 验证 `cwd` + `model` 覆盖生效 | `session.info` 回读 model/cwd |
| 3 | 验证 `config.set yolo` 后 `session.info.yolo === true` | 回读 |
| 4 | 验证 `approval.request` 触发条件（跑一条危险命令） | 抓到事件 + `approval.respond` 能解 |
| 5 | 写 `ServeClient` + `handleChatServe`，保留旧路径 | 本地 curl SSE，首字 < 2s（热） |
| 6 | 前端按需加 `reasoning` / `tool` / `approval` 事件处理 | 界面无回归 |
| 7 | launchd 环境跑通 + 重启自愈 | 重启机器后首字仍 < 2s |
| 8 | 观察 1 周后删旧路径与 oneshot 补丁 | — |

---

## 8. 一并向导的遗留问题（与本方案无关，但同批处理）

- `~/.hermes/config.yaml` 里 `supports_reasoning: false` 与实际不符（e4b 会发 reasoning）→ 改 `true`。
- `server.js` 日志明文打印 token → 脱敏。
- `HOST` 默认 `127.0.0.1` 已正确；但代码注释与 README 需明确「改 0.0.0.0 = 局域网明文 token，风险自负」。
- `LOCAL_MODELS` 清理已删除模型（L53）。

---

## 9. 附录：让响应更快的全部手段（按性价比排序，2026-09-11 实测支撑）

| # | 手段 | 预期收益 | 成本/风险 | 证据 |
|---|---|---|---|---|
| 1 | **关思考**（已做） | 热首字 29.6→19.8s | 已做，可一行回滚 | `/v1` 端点 `reasoning_effort:"none"` 实测 8.6s→1.4s |
| 2 | **serve + 共享长连接** | 稳态 18.7s→**0.4s** | 需改造，有风险 | 本方案 D2 实测 |
| 3 | **预热保活**：启动/空闲时灌一次完整 system prompt，让首条消息也走热路径 | 消灭首轮 22s 冷 prefill | 低 | 冷 22.0s vs 热 0.4s（同一 session） |
| 4 | **稳住 system prompt**：查清为何 serve 每会话哈希都不同（疑 cwd/会话变量混入） | 跨会话也能命中缓存 | 中（要动 Hermes 配置或 cwd 固定） | 3 个 serve 会话 3 个哈希；CLI 稳定命中 14~28K |
| 5 | **裁工具/技能**：`hermes tools disable <toolset> --platform cli` | 16K prompt 减半 → 冷 prefill 22s→~11s | 中（功能有损） | 当前启用 22 个工具；可裁 browser_exec/desktop_project/tts/cronjob_manage 等 |
| 6 | **换更小模型** `gemma4:e2b` | 生成 39.25→54.97 tok/s（+40%），prefill 同步更快 | 高（质量下降 + 需重下 7.2GB） | 基准表 |
| 7 | **前端体感**：立即渲染 `thinking.delta` / `tool.started` / 计时器 | 不改变真实延迟，但"看起来快很多" | 低 | serve 原生提供这些事件 |
| 8 | Ollama 侧：FlashAttention、KV q8_0、`keep_alive` 拉长 | 边际 | 低（大部分已开） | — |
| 9 | **避免并发抢 GPU**：别在另一个会话同时跑大模型 | 避免偶发 3~10 倍劣化 | 低（纪律） | 曾因 qwen3:14b 占 GPU 导致 9 分钟无输出 |

**当前最优组合**：1（已做）+ 2 + 3 → 稳态 ~0.4s，首条也接近热路径。
**不想改造的话**：3 + 5 + 7，低成本把 18.7s 压到 ~10s 且体感明显改善。
