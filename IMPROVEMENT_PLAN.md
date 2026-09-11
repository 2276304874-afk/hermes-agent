# 赫尔墨斯特工 · 改进建议（含前提条件与预期效果）

> 针对 2026-09-11 项目分析中识别的问题，按优先级给出具体可执行方案。
> 每条包含：**建议内容 / 适用前提条件 / 实施后效果**。

---

## P0-1 · 把服务纳入 launchd 托管（解决"孤儿进程不自愈"）

**建议内容**
1. 在 **Terminal.app**（不是 WorkBuddy 的 shell）执行：
   ```bash
   lsof -ti:4173 | xargs kill 2>/dev/null; sleep 1
   bash ~/WorkBuddy/赫尔墨斯特工/setup.sh
   ```
2. 脚本会把 `launchd/com.hermes-agent.ui.plist` 装到 `~/Library/LaunchAgents/` 并 bootstrap。
3. 验证（三条都要过）：
   ```bash
   launchctl print gui/$(id -u)/com.hermes-agent.ui | grep state   # 应为 running
   lsof -nP -iTCP:4173 -sTCP:LISTEN                                # 应有 node 监听
   curl -s "http://127.0.0.1:4173/api/health"                      # 应有响应
   ```

**适用前提条件**
- 必须在 **macOS GUI 登录会话内的 Terminal.app** 执行；普通/非 Aqua 会话的 shell 调 `launchctl bootstrap|load` 会被拒（实测报 `Input/output error 5`）。
- **Ollama.app 必须在运行**（`setup.sh` 会探测 `127.0.0.1:11434`，未响应则直接退出）。
- 托管 node 与 `hermes-local-gemma4` / `gemma4:e4b` 模型在位。
- plist 内 `HOST=127.0.0.1`（已收紧，如需局域网访问改回 `0.0.0.0`）。

**实施后效果**
- 服务从"散落的手动/孤儿进程"变为**受 launchd 管理**：登录自启（`RunAtLoad`）+ 崩溃后 10 秒内自动拉起（`KeepAlive` + `ThrottleInterval=10`）。
- **彻底消除"每次要手动拉服务""崩溃后不自愈"**。
- 前提是重启一次让新代码（含 `/kb`、`/api/kb/*`）生效。

---

## P0-2 · 定位静默崩溃根因

**建议内容**
1. 重启后监控：`tail -f ~/Library/Logs/hermes-ui.err.log`，找 `[FATAL uncaughtException]` / `[FATAL unhandledRejection]` 行（已在 server.js 头部加好）。
2. 崩溃复现时跑一条完整对话（发消息 → 等回答完成），记录时间点，比对日志。
3. 若日志仍为空 → 加**内存监控**：崩溃前 RSS 是否接近上限（16G 机型上 `gemma4:e4b` 驻留 ~3.3G + bge-m3 + node），必要时在 `handleChat` 的 `spawn` 处加 `child.on('exit', code => console.error('[child exit]', code))`。
4. 对 `handleChat` 的异步轮询体（`setInterval` 内）已有的 `try/catch` 补 `console.warn`，别吞。

**适用前提条件**
- 必须先完成 P0-1（否则进程非托管，日志随进程消失）。
- 需要一次真实崩溃复现（当前是"随机死"，可能要多试几轮）。
- 磁盘有空间（日志已做 10MB 自动截断守护）。

**实施后效果**
- 拿到真实堆栈 → **从"猜"变"精准修"**。
- 若确诊是内存/换载，可针对性调整 `KEEP_ALIVE` 或限制并发。

---

## P1-3 · 拆分单体文件（server.js 1394 行 / index.html 1864 行）

**建议内容**
1. `server.js` 按域拆到 `lib/`：
   - `lib/auth.js`（token）、`lib/db.js`（SQLite 只读查询）、
   - `lib/kb.js`（KB list/search/status）、`lib/hermes.js`（spawn/env/CLI 解析）、
   - `lib/chat.js`（SSE 聊天）、`routes/*.js`（各 API 段）。
   - 主 `server.js` 只保留路由装配与启动。
2. `index.html` 把 3 个内联 `<script>` 抽到 `public/app.js`（保持零构建，直接 `<script src>`）。

**适用前提条件**
- **先建回归基线**：健康三连测（端口/`/api/health`/`/api/kb/status`）+ 一次完整对话。
- 分步拆、每步跑基线；**不要一次性大重构**。
- 保持"单进程、零 npm 依赖"约束不变。

**实施后效果**
- 单文件从 1394 行降到每模块 <300 行，**改动爆炸半径大幅缩小**。
- 前端可被浏览器缓存，改 app.js 不必整页重下。
- 为 P1-6 的测试铺路（模块化才能单测）。

---

## P1-4 · 加固 CLI 输出解析（4 个 parse 函数）

**建议内容**
1. `parseSessions` / `parseCronList` / `parseSkillsList` / `parseMcpList` 改为**返回 `{ok, items, raw}`**：解析到 0 条但原始输出非空时，标记 `ok:false` 并把 `raw` 带出。
2. 调用方（`/api/sessions` 等）在 `ok:false` 时返回 5xx + 提示，而不是静默返回空数组。
3. 抓一份真实 CLI 输出存为 `tests/fixtures/*.txt`，锁定格式。

**适用前提条件**
- 需先抓取当前 Hermes v0.21.0 的真实输出样本（版本升级后需更新 fixture）。
- 前端要能处理新增的错误分支。

**实施后效果**
- Hermes 升级改了表格格式时，**系统会"报错"而不是"静默空列表"**——问题当天暴露，不用等用户发现。
- 之前侧边栏"看起来没数据"的假象类问题不再复现。

---

## P1-5 · 治理静默 catch

**建议内容**
- 全局排查 `catch {}` / `catch (e) {}`（无日志）处，按级别补日志：关键路径 `console.error`，次要路径 `console.warn`，并在注释里写明"为何可忽略"。
- 已知修复样例：`loadSessions` 的 `catch(e){}` 已改成红框报错 + 点击重试。

**适用前提条件**
- 需配合日志分级，避免刷爆 launchd 捕获的日志文件。
- 已有 10MB 日志截断守护兜底。

**实施后效果**
- **消灭"功能缺失"假象**——出错能看见，排障从"盲猜"变"看日志"。

---

## P1-6 · 补最小测试与健康脚本

**建议内容**
1. 用 **node 22 内置 `node:test`（零依赖）** 写 `tests/`：覆盖 4 个 parse 函数、KB 函数（list/status）、认证、路径穿越防护。
2. 写 `scripts/healthcheck.sh`：端口 + `/api/health` + `/api/kb/status` + Ollama 三连测，退出码非 0 即告警。

**适用前提条件**
- node ≥ 22（当前满足，`node:test` 内置）。
- 建议在 P1-3 拆分后进行（模块可独立 import）。

**实施后效果**
- 改动有**回归网**，不再"改 A 崩 B"。
- 新增一键自检，替代"靠人肉试"。

---

## P2-7 · 清理根目录一次性脚本

**建议内容**
- `comprehensive_fix.py` / `fix_types.py` / `ultimate_fix.py` / `ultimate_fix_v2.py` / `simple_test.py` 移入 `archive/` 或删除（建议先备份）。
- 判据：它们都是上一轮 "Python 3.9 兼容性修复" 的一次性脚本，不是运行依赖。

**适用前提条件**
- 确认无任何 launchd / 脚本引用它们（当前仅 `setup.sh`/`run.sh` 是运行路径，均不引用）。

**实施后效果**
- 根目录从 5 个噪音文件变干净，**新会话一眼看清项目主体**。

---

## P2-8 · 收敛 KB 为单入口

**建议内容（二选一）**
- **A（推荐）**：停用 4174——`kb/serve.py` 顶部加弃用说明，并从任何启动流程移除；KB 只走 4173 的 `/api/kb/*`。
- **B**：保留 4174 作为独立备用，但在 `serve.py` 与文档中明确标注"已被 4173 取代，勿双跑"。

**适用前提条件**
- 确认没有外部工具/书签只依赖 4174。
- 4173 的 KB 路由已随 P0-1 生效（实测已通）。

**实施后效果**
- 消除**双后端/双源**隐患，`viewer.html` 与智能体走同一条路，行为一致。

---

## P2-9 · Python 路径动态探测（防"路径腐烂"）

**建议内容**
- 参照 `run.sh` 的 `resolve_node()` 思路，在 `setup.sh`/`server.js` 加 `resolve_python()`：优先 `KB_PYTHON` 环境变量 → 扫 `~/.workbuddy/binaries/python/versions/*/bin/python3`（取最高）→ PATH → `/usr/bin/python3`。
- `server.js:60` 的硬编码 `${HOME}/.workbuddy/binaries/python/versions/3.13.12/bin/python3` 改为运行时解析。

**适用前提条件**
- 需接受"多版本时取最高"的约定（与 node 相同策略）。
- 改动后跑一次 `/api/kb/search` 验证。

**实施后效果**
- WorkBuddy 升级 Python 时**不再重演 node 那样的"硬编码路径腐烂"**（当时 plist 里 `22.22.2-2` 被删导致服务起不来）。

---

## P2-10 · 明确 KB 路由的认证策略

**建议内容**
- 做一次显式决策并写进代码注释 + 文档：
  - 保持公开（仅 `127.0.0.1` + 只读，与原 4174 一致），**加注释说明这是有意的**；或
  - 改为需 token（`/kb` 页面加载时需注入 token，`apiFetch` 带 Bearer）。
- 当前实现为"公开"，与 `/api/*` 认证模型不一致，属设计权衡。

**适用前提条件**
- 若改需 token，`viewer.html` 要加 token 读取逻辑（可复用主 UI 的 localStorage 方案）。

**实施后效果**
- 要么**认证模型统一**，要么**风险边界写清楚**，消除"这是不是漏洞"的模糊地带。

---

## P3-11 · 建文档索引

**建议内容**
- 新增 `docs/INDEX.md`，汇总：`项目导读.md`、`UPGRADE_ROADMAP.md`、`PLAN-hermes-serve.md`、`KB_INTEGRATION.md`、`IMPROVEMENT_PLAN.md`、`GITHUB_RECOMMENDATIONS.md`，每条一句话说明用途。

**适用前提条件**：无（纯文档）。

**实施后效果**
- 新会话/新协作者能**30 秒定位到该看哪份**，不用逐份翻。

---

## P3-12 · 用量日志持久化

**建议内容**
- 把内存态 `usageLog`（当前仅最近 60 轮）追加落盘到 `~/.hermes/usage.jsonl`（一行一条 JSON）。
- 可选：加一个 `/api/usage` 聚合接口看延迟/成功率趋势。

**适用前提条件**
- 注意滚动/大小控制，避免无限增长（可复用日志截断思路）。

**实施后效果**
- **首字延迟、tokens/s、工具调用数等性能趋势可长期追踪**，为后续优化提供数据依据。

---

## 执行顺序建议

```
P0-1 装守护 + 重启  ──►  P0-2 观察崩溃日志
        │
        ▼
P2-7 清理残留 / P2-8 KB 单入口 / P2-9 Python 探测   （低风险，可与我并行做）
        │
        ▼
P1-3 拆分  ──►  P1-6 补测试  ──►  P1-4 解析加固 / P1-5 catch 治理
        │
        ▼
P2-10 认证决策  ──►  P3-11 文档索引 / P3-12 日志落盘
```

> 其中 **P0-1 必须由你在 Terminal.app 执行**（我方 shell 无 GUI 会话权限）；
> **P2-7 / P2-8 / P2-9 / P1-5 部分**我可直接改代码；**P1-3 拆分**建议先建基线再动。
