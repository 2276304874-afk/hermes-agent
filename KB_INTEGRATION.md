# 知识库查看器（viewer.html）与赫尔墨斯特工集成对接设计

> 目标：把 `kb/viewer.html` 现有的「内容 + 功能」并入赫尔墨斯特工主服务，
> 让**主 UI 能展示**、**智能体能主动调用**知识库，消除对独立 4174 进程的依赖。

---

## 1. 现状盘点

| 组件 | 角色 | 现状 |
|---|---|---|
| `kb/viewer.html` | 知识库只读前端 | 调 `/api/list`、`/api/search`、`/api/status` |
| `kb/serve.py` | 4174 独立后端 | 托管 viewer.html + 上述 3 接口；读 inbox/distilled/memory 文件 |
| `kb/kb.py` | 检索引擎 | `recall()` 基于 sqlite FTS5 trigram + BM25；CLI `recall`/`build` |
| `server.js` (4173) | 主服务 | 已用 `kb.py recall` 做**自动召回**（`recallContext`）+ `/api/kb?q=` **slash 召回** |
| 数据源 | 同一批文件 | `.workbuddy/kb_inbox.md`（自动捕获）、`.workbuddy/kb_distilled.md`（蒸馏技能）、`MEMORY.md`（长期记忆） |

**关键结论**：viewer.html 只是展示层，真正的「功能」是 serve.py 的 3 个接口 + kb.py 的 recall。
数据源是本地 Markdown 文件，无数据库依赖。**主服务已经具备检索能力，缺的是「统一暴露」和「智能体调用路径」。**

---

## 2. 需要暴露 / 共享的功能模块

viewer.html（及其后端）应向上暴露 4 个模块：

| 模块 | 含义 | 暴露形态 |
|---|---|---|
| **M1 条目列举 `list(cat)`** | 按分类（all/inbox/distilled/memory）读取并切块 Markdown | HTTP `GET /api/kb/list?cat=` |
| **M2 语义检索 `search(q)`** | 调 `kb.py recall` 返回带 `score` 的排序命中 | HTTP `GET /api/kb/search?q=` |
| **M3 状态探针 `status()`** | 各分类条目数 + Ollama 在线/模型列表 | HTTP `GET /api/kb/status` |
| **M4 内容呈现 `render()`** | 卡片式展示（标题/来源/相关度/正文） | 页面 `/kb`（托管 viewer.html） |

> viewer.html 自身无需改动其「渲染逻辑」，只需把 API 基址从 4174 改成同源 4173。

---

## 3. 数据交互方式

```
                  同源 127.0.0.1:4173
  ┌──────────────────────────────────────────────────────┐
  │  server.js（主服务，唯一 HTTP 入口）                    │
  │   ├─ /api/chat              SSE 聊天（已有）            │
  │   ├─ /api/kb?q=             slash 召回（已有）          │
  │   ├─ /api/kb/list           ← 新增：M1                 │
  │   ├─ /api/kb/search         ← 新增：M2（复用 recallHits）│
  │   ├─ /api/kb/status         ← 新增：M3                 │
  │   └─ /kb  → 托管 viewer.html ← 新增：M4                │
  └───────────────────┬──────────────────────────────────┘
                       │ spawnSync / 读文件（只读）
                       ▼
              kb/kb.py（recall 引擎，单源）
              inbox / distilled / memory.md（数据源）
                       ▲
  Hermes 智能体（CLI，由 server.js spawn）
   └─ kb-query 技能 → 直接 `python3 kb/kb.py recall` 或 `curl /api/kb/search`
```

- **交互协议**：HTTP + JSON（与 viewer.html 现状一致），只读、仅绑 127.0.0.1、无需 token（与原 4174 行为一致）。
- **检索实现**：`/api/kb/search` 复用 server.js 已有的 `recallHits()`（即 `kb.py recall --json`），不再重复造轮子。
- **列举/状态实现**：直接在 Node 侧读 3 个 Markdown 文件并切块（镜像 serve.py 的 `parse_blocks`），避免新开进程、避免依赖 4174。
- **单源保证**：serve.py 与 server.js 现在都只依赖 `kb.py` + 那几个文件，无状态分歧。

---

## 4. 触发机制（T1–T4）

| 触发 | 谁发起 | 走哪条路 | 状态 |
|---|---|---|---|
| **T1 自动召回** | 新会话时主服务 | `recallContext()` 把 top-3 注入 prompt | ✅ 已有 |
| **T2 用户 slash** | 用户输入 `/kb 问题` | `GET /api/kb?q=` | ✅ 已有 |
| **T3 智能体主动调用** | 智能体在对话中判断需要历史经验 | 加载 `kb-query` 技能 → `kb.py recall` 或 `curl /api/kb/search` | ✅ 新增（技能已建） |
| **T4 UI 入口** | 用户点顶栏「知识库」按钮 | 新标签打开 `/kb`（viewer.html） | ✅ 新增 |

T3 是本次对接的核心价值：**让「赫尔墨斯特工」能主动「调用」知识库**，而不只是被动被注入。

---

## 5. 集成后整体对接结构

```
浏览器 ──┬─ 聊天主界面 (4173/)         ─┐
        └─ 知识库查看器 (4173/kb)      ─┤ 同源，共享 4173 端口与认证体系
                                         │
              server.js :4173  ───────────┘ 唯一后端
                 │  recallHits / 读 Markdown
                 ▼
            kb/kb.py  ──►  inbox / distilled / memory.md
                 ▲
  Hermes 智能体（CLI）── kb-query 技能 ── 调 KB（T3）
```

- **端口收敛**：4174 不再是必需；viewer 与 chat 共用 4173。
- **职责收敛**：`kb/serve.py` 降级为「可选独立备用」，主路径全部经 server.js。
- **智能体可调用**：通过 `kb-query` 技能，智能体在任意对话轮次都能检索知识库并引用来源。

---

## 6. 需要实现的对接逻辑（已落地部分）

| 编号 | 实现 | 文件 | 说明 |
|---|---|---|---|
| L1 | KB 函数 `kbListEntries` / `_kbParseBlocks` / `ollamaStatusSync` | `server.js` | 镜像 serve.py 的列举+状态，纯读、异常降级 |
| L2 | 路由 `/kb`（页面壳）+ `/api/kb/list`、`/api/kb/search`、`/api/kb/status`、`/api/kb?q=` | `lib/routes/kb.js` | **P2-10 定案：数据接口全在认证闸门之后**（见下方「认证策略」），复用 `recallHits`；只有 `/kb` 页面壳公开 |
| L3 | viewer.html 改打 `/api/kb/*` + 页脚改 4173 | `kb/viewer.html` | 同源工作 |
| L4 | 主 UI 顶栏「知识库」按钮 → 打开 `/kb` | `public/index.html` | 用户可达 |
| L5 | `kb-query` 技能 | `~/.hermes/skills/kb-query/SKILL.md` | 智能体主动调用（T3） |

### 认证策略（P2-10 定案，2026-09-11）

**KB 数据接口需 Bearer token，与 `/api/*` 同一把。** 不再走"公开只读"。

- 理由 ①：KB 内含 `MEMORY.md` 这类私有笔记，是本项目最敏感的数据；
- 理由 ②：服务其余 `/api/*` 全部要令牌，唯独 KB 例外 → 认知负担，且容易被当成漏洞；
- 理由 ③：原先的兜底理由"只绑 127.0.0.1"太脆 —— `HOST` 只是 plist 里一行 env，
  2026-09-06 曾为局域网访问改成 `0.0.0.0`，一旦再开，公开的 KB 即对整个网段可读。
- 实现：接口移入认证组；`GET /kb` **页面壳**保持公开（只是一张不含数据的 HTML）。
  `viewer.html` 从同源 `localStorage('hermes_ui_token')` 取令牌（与主界面共用，不必输两遍），
  401 时页面顶部弹出补填提示。
- 护栏：`test/routes.smoke.sh` 与 `healthcheck.sh` 各有一条"无 token 必须 401"的断言，
  防止哪天又被改回公开。

### 仍可选 / 待定
- **停用 4174**：把 `kb/serve.py` 改为可选；若保留，建议加注释说明「已被 4173 取代」。
- **viewer 内「插入到对话」**：在 viewer.html 卡片加「引用到对话」按钮，把选中条目 POST 回 4173 聊天（需新增一个写入型接口 + 前端联调），当前未做。
- **自动构建索引**：`kb.py build` 目前需手动跑；可挂到 server.js 启动或 capture/distill 之后自动 build，使 FTS 检索始终最新。

---

## 7. 验证方式（重启主服务后）

```bash
# 服务起后，前三条应都返回 JSON（P2-10 起需带 Bearer 令牌；不带则 401）
T=$(cat ~/.hermes/ui_token)
curl -s -H "Authorization: Bearer $T" "http://127.0.0.1:4173/api/kb/list?cat=all"   | head -c 200
curl -s -H "Authorization: Bearer $T" "http://127.0.0.1:4173/api/kb/search?q=launchd" | head -c 200
curl -s -H "Authorization: Bearer $T" "http://127.0.0.1:4173/api/kb/status"         | head -c 200
# 反证：不带令牌必须 401
curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:4173/api/kb/status"
# 浏览器打开 http://127.0.0.1:4173/kb 应能看到知识库查看器（首次需在顶部填一次令牌）
```

> 注意：改完代码需让守护加载新版本 —— `launchctl kickstart -k gui/$(id -u)/com.hermes-agent.ui`
> （或重跑 `bash ~/WorkBuddy/赫尔墨斯特工/setup.sh`）后再验证。
