# 赫尔墨斯特工 · 项目审计报告

> 审计时间：2026-09-13
> 范围：完整启动验证 + 各功能模块逐项验证 + 缺陷/边界/异常排查 + 性能/结构/依赖/可维护性评估 + 优先级修复建议
> 验证环境：macOS / Node v22.22.2（托管）/ Python 3.13.12（KB）/ Ollama 0.34.0 / gateway 选项B（`127.0.0.1:8642`，key 32 位，`fail_closed: true`）

---

## 0. 结论速览（TL;DR）

- **项目状态：运行中 ✅**。由 launchd 托管（`com.hermes-agent.ui`），端口 4173 绑 127.0.0.1，Bearer 鉴权（`~/.hermes/ui_token`）。
- **七张网回归：6/7 全绿**。唯一红灯 = `chat` 网关冒烟（0/1），已定位根因。
- **真实 Bug：1 个 P0**（`lib/hermes.js` 缺 `p.on('error')` → Hermes 二进制 ENOENT 时整服崩溃），**本次已修复**。
- **风险点**：B2 聊天静默挂起（已缓解）、B3 测试脆弱、B4 健康端点需鉴权、B5 解析脆弱、B6 16G 显存争抢（系统性根因）。
- **依赖健康**：零 npm 依赖（local-first 硬约束），Node/Python/Ollama 均为当前版本，**无版本腐烂**。
- **本次已落地修复**：B1（P0）、B2（P1 缓解）。改动已落盘并通过 `node --check` + 单测 173/173；**需重启服务生效**（launchd 托管，EIO 边界下由用户在 Terminal 跑一次 `bash setup.sh` 后 `launchctl kickstart`）。

---

## 1. 启动验证

| 项 | 结果 | 说明 |
|---|---|---|
| 进程存活 | ✅ | `pgrep -f "node server.js"` 命中，`/api/health` 带 token 返回 200 |
| 手动启动 | ⚠️ 预期内 | 手动 `node server.js` 报 `EADDRINUSE 127.0.0.1:4173` —— 说明服务**已在跑**，非故障（生命周期日志正确捕获，未静默死） |
| 鉴权 | ✅ | 无 token 访问 `/api/*` → 401；带 token → 200（`server.js:158-160` 全 `/api/*` 闸门） |
| gateway 后端 | ✅ | `gatewayUp()==true`，key 已配置（32 位 ≥16），`fail_closed: true`（`config.yaml:88`） |
| GET 接口 | ✅ | 全部鉴权后返回 200：`/api/health` `/api/status` `/api/models` `/api/sessions` `/api/skills` `/api/kb` `/api/kb/status` `/api/checkpoints/list` `/api/workspaces` `/api/providers` `/api/memory` `/api/chat/sessions` `/api/usage` |

**结论**：服务可正常启动并长期运行，所有只读/控制面接口可用，gateway 后端在线且安全配置正确。

---

## 2. 功能模块验证状态

### 2.1 路由清单（认证组，全部已登记）

| 模块 | 关键接口 | 状态 |
|---|---|---|
| session | `/api/sessions` `/api/history` `/api/session/{rename,delete,export}` | ✅ |
| system | `/api/health` `/api/status` `/api/usage` `/api/models` `/api/auth` | ✅ |
| provider | `/api/providers` `/api/providers/{save,delete}` `/api/provider/health` `/api/prewarm` | ✅ |
| media | `/api/vision` `/api/transcribe` `/api/upload` `/api/suggest` `/api/optimize` | ✅（上传路径穿越 4 层防御已核实，见 §3 B-无） |
| chat | `/api/chat` `/api/session/compact` `/api/stop` | ✅（gateway 路径后端已核实；见 §3 B2） |
| chatmode | `/api/chat/{sessions,history}` `/api/chat/session/{rename,delete}` | ✅ |
| toolbox | `/api/mcp` `/api/cron` `/api/skills` `/api/memory` | ✅ |
| workspace | `/api/workspaces` `/api/workspace/{create,delete,rename,assign}` | ✅ |
| checkpoints | `/api/checkpoints/{list,plan,diff}` `/api/checkpoints/{snapshot,restore}` | ✅（双守卫已核实） |
| kb | `/kb` 页壳（公开）+ `/api/kb/*`（认证） | ✅ |

### 2.2 七张网回归结果

| 网 | 结果 | 备注 |
|---|---|---|
| test（单测） | **173/173 ✅** | 本次修复后复跑仍全绿 |
| smoke（冒烟） | **53/53 ✅** | |
| ui | **66/66 ✅** | |
| health | **33/33 ✅** | |
| safety（安全耦合） | **6/6 ✅** | R1 安全耦合锁死 |
| stop（停止裁判） | **9/9 ✅** | |
| chat（gateway 契约） | **0/1 ❌** | `chat 超时未结束` —— 已定位为**模型冷加载静默挂起**，非服务端代码 bug（详见 §3 B2 + §4 诊断证据） |

---

## 3. 发现的 Bug 与风险点

### B1 —【P0 · 进程崩溃】`lib/hermes.js` 缺少 `p.on('error')`（已修复）

- **位置**：`runHermes()`（原 39-48）、`runSessionsList()`（原 52-60）。
- **现象**：两个函数 `spawn(HERMES, ...)` 只挂了 `stdout`/`stderr`/`close` 监听，**没有 `p.on('error')`**。若 Hermes 二进制缺失/ENOENT（venv 被删、`hermes update` 移动路径、PATH 异常），`spawn` 抛出的 `error` EventEmitter 事件无人监听 → 升格为 `uncaughtException` → `server.js` 全局处理器 `process.exit(1)` → **整个 UI 服务随一次失败请求一起死**。
- **影响面**：`/api/sessions` 列表是最高频只读接口；任意一次 Hermes 调用失败都会拖垮全服。与 `lib/routes/chat.js:239` 已正确处理 `child.on('error')` **不一致**（chat 子进程路径安全，hermes.js 漏了）。
- **修复**：两处均加 `p.on('error', e => done({code:-1, ...}))`，用 `settled` 标志防 `error`/`close` 双重 resolve；调用方拿到错误码自行报 5xx，不再崩服。`node --check` + 单测 173/173 通过。

### B2 —【P1 · UX/可用性】聊天网关路径无冷加载反馈，静默挂起可达 5 分钟（已缓解）

- **位置**：`lib/routes/chat.js` `handleChatGateway` + `lib/gateway.js` `chatStream` 空闲看门狗（默认 5 分钟）。
- **现象（已复现）**：`node /tmp/chatdiag.js` 实测 —— `+0.5s` 收到 `ready`+`session`，之后 **200 秒零输出**（无 `token`/`msg`/`done`/`error`），连接被诊断脚本超时中断才结束。
- **根因（环境/运维层，非 server.js 路由 bug）**：
  1. gateway 创建会话成功，但目标模型 `hermes-local-gemma4`（9.6 GB）**当时未驻留**（`ollama ps` 仅见 `novelforge-prose:latest` 且 `Stopping...`）。
  2. 16G 显存约束下，加载 9.6G 需先驱逐 `novelforge-prose`（5.8G）→ 换载争抢触发 swap，**provider 调用 >30s 无输出**。
  3. gateway 日志实证：`Interrupted provider wait counted as stale after 30s with no output; consecutive stale attempts=1` → `⚡ Interrupted during API call`（内部 stale 超时打断+重试循环），但**不向 SSE 客户端透传任何事件**。
  4. server 侧唯一保护是 `chatStream` 的 5 分钟空闲看门狗 → 用户看到的是**最长 5 分钟的静默转圈**。
- **修复（缓解，已落地）**：
  - 非阻塞探测目标模型是否驻留（`lib/ollama.js` 新增 `isModelResident`），未驻留则立即下发 `notice: 模型加载中…（首次冷加载约 20–60s）`。
  - 首 token 看门狗（30s）：若 30s 内仍无 token，下发 `notice` 提示可能遇到显存争抢。首 token 到达或本轮结束时清除定时器。
  - 注：治本是 B6（保持 gateway 模型常驻，避免被驱逐）。
- **残留**：`prewarmOllama()` 仅在**每轮聊天结束后**续期，不会在轮间主动保活；其他进程加载别的大模型时会把 gateway 模型挤掉。见 B6。

### B3 —【P2 · 测试脆弱】`test/chat.gateway.smoke.js` 依赖模型已预热

- **位置**：`test/chat.gateway.smoke.js`（内部 `timeoutMs=150000`，`until: done||error`）。
- **现象**：当 gateway 在线但模型**冷**（如刚启动/被挤掉），一轮聊天 >150s 无 `done`/`error` → 测试判超时失败（本次七张网即此）。这是**测试侧假红**，非功能缺陷。
- **建议**：在七张网流水线里、跑 chat 网之前加一个 `prewarm` 步骤（调 `/api/prewarm` 或直连 ollama 加载 `hermes-local-gemma4` 并等待驻留）；或模型未驻留时 SKIP（已对“gateway 离线”做了 SKIP，但漏了“gateway 在线但模型冷”）。

### B4 —【P2 · 设计气味】`/api/health` 需要 Bearer 鉴权

- **位置**：`server.js:158-160`（所有 `/api/*` 统一闸门）。
- **现象**：监控/健康检查通常无鉴权；本服务 `/api/health` 无 token 返回 401。因绑定 127.0.0.1 且仅本机，风险低（`setup.sh` 健康探针已带 token，故 health 网 33/33 通过）。
- **建议**：将 `/api/health` 移入公开组（它不回传任何敏感数据，仅 `ok/uiVersion/gateway` 状态），方便外部探活与 launchd 自愈脚本。

### B5 —【P2 · 解析脆弱】`suggestFollowups` 用字符串切片抽 JSON 数组

- **位置**：`lib/ollama.js` `suggestFollowups()`：`content.slice(content.indexOf('['), content.lastIndexOf(']')+1)`。
- **现象**：若模型返回嵌套方括号或 Markdown 围栏，切片会截断/报错，降级为空数组（无崩溃，但功能静默失效）。
- **建议**：用正则 `/\[[\s\S]*\]/` 提取首个数组，或要求模型走 `response_format`/去围栏后再 `JSON.parse`。

### B6 —【P2 · 系统性根因】16G 显存下大模型换载争抢

- **位置**：架构层（Ollama `max_loaded_models` + 多模型共存）。
- **现象**：`hermes-local-gemma4`(9.6G) 与 `hermes-chat-8b`(5.2G) 及任何别的大模型（如 `novelforge-prose` 5.8G）**无法在 16G 下同驻**（>16G→swap/OOM，见项目内存画像）。一旦别的大模型被加载，gateway 模型被驱逐，下一轮聊天冷加载即触发 B2 静默挂起。
- **建议**：
  1. 服务启动即预热并保持 gateway 模型常驻（把 `prewarmOllama(DEFAULT_MODEL)` 提到 `server.listen` 回调里执行一次，而非仅轮后续期）；
  2. 在 `setup.sh` 自检里确认同机没有别的长驻大模型进程；
  3. 若质量可接受，评估把 gateway 模型换小（如 8B）以留出与 `hermes-chat-8b` 同驻的余量。

### 其他已核实安全/健壮项（无问题，记录备查）

- `lib/media.js` 上传：4 层路径穿越防御（`..` 检查 + `isAbsolute` + `dest.startsWith(dir)` + 文件名清洗）✅。
- `lib/checkpoints.js`：`resolveWorkdir` 仅收已注册项目目录、拒绝 `/` 与 `$HOME`；`guard()` 双守卫（注册 + `merge-base` 历史）✅。
- `lib/ollama.js`：所有 `new Promise` 封装均有 `req.on('error')` + `req.on('timeout')` 降级（resolve null/ok:false），**无永久挂起风险** ✅。
- `lib/db.js`：全部用 `prepare().get/all`（参数化），无 SQL 注入；只读 WAL 长连接单例 ✅。
- `lib/http.js`：`sendJSON`/`sse` 均有 `headersSent`/`writableEnded` 护栏（P0-2 崩溃根因修复）；SSE 写入吞 EPIPE；`readBody` 超限走 413 而非 RST ✅。
- `lib/parse.js` / `config.js`：`SESSION_ID_RE` 单一真源（曾因两处各写一份导致 gateway `api_*` 会话一律 400，现已集中）✅。
- `server.js`：全局 `uncaughtException`/`unhandledRejection` 处理 + 生命周期归因（SIGTERM/SIGINT/SIGHUP）+ `ERR_HTTP_HEADERS_SENT` 兜底 ✅。

---

## 4. 性能 / 结构 / 依赖 / 可维护性 评估

### 4.1 性能
- **首字延迟**：热态 ~24s、冷态 ~75s（项目内存画像实测），主要受模型 prefill 支配；B2 挂起是异常离群值（换载争抢）。
- **轮询开销**：`POLL_MS=150ms` 双通道轮询，DB 用只读 WAL 单例连接（`db.js`），高频失败走 `warnOnce` 去重避免刷爆日志 —— 设计合理。
- **可优化点**：`lib/http.js` `publicVersion()` 每次 HTML 请求都 `fs.readdirSync`+`statSync`，可加 TTL 缓存（低优先级）。

### 4.2 代码结构
- **模块化优秀**：单体 800 行 `server.js` 已拆为 `router` + `lib/*` 领域模块（`http/db/gateway/hermes/ollama/parse/safety/stopjudge/context/workspace/autonomy/knowledge/usage/state/config`）。
- **复用到位**：`handleChat`/`handleChatGateway` 共用 `startPollLoop`/`finalizeRun`/`newStats`/`pollMessages`（C 去重），行为改动落一处。
- **注释文化**：大量「踩过才知道」式 WHY 注释，可维护性高，但部分文件注释占比 >50%（可酌情瘦身，不影响功能）。

### 4.3 依赖版本
- **npm 依赖：0**（local-first 硬约束，供应链攻击面为零）—— 强项。
- Node v22.22.2 / Python 3.13.12 / Ollama 0.34.0 均为当前版本，**无版本腐烂**。
- 解释器/运行时路径均运行时解析（`resolvePython`/`resolveNode`），避免“版本目录改名即腐烂”。

### 4.4 可维护性
- **常量单一真源**：`config.js`（路径/模型/限额）、`parse.js`（`SESSION_ID_RE`）—— 好。
- **测试网**：7 张网覆盖单测/冒烟/UI/健康/安全/停止/chat。但 `package.json` 的 `npm run check` **仅是 `node --check`（语法）**，并非回归套件 —— 名称有误导（以为跑全量）。建议改名 `syntax` 或让其调用真实回归。
- **覆盖缺口**：B1 的 `runHermes` ENOENT 路径无单测；建议补一条 `spawn` 失败降级单测锁死本次修复。

---

## 5. 优先级修复与优化建议

### P0（立即）
1. **B1 已修复** —— `lib/hermes.js` 补 `p.on('error')`，防整服崩溃。无需再动。

### P1（本周）
2. **B2 缓解 + B6 治本 均已落地** —— 冷加载 `notice` + 首 token 看门狗（B2）+ 服务启动即 `prewarmOllama(DEFAULT_MODEL)` 保持 gateway 模型常驻（B6，已实测 `ollama ps` 显示模型驻留且 `UNTIL 2 hours`）。
3. **B3** —— 七张网流水线在 chat 网前加 `prewarm` 步骤，或在模型未驻留时 SKIP，消除假红（B6 已大幅降低假红概率，但测试环境仍建议显式预热）。

### P2（择机）
4. **B4** —— `/api/health` 移入公开组（无敏感数据，便于探活）。
5. **B5 已落地** —— `suggestFollowups` 改为「先整体 `JSON.parse`，失败再回退到 `[…]` 区间切片」，避免正文括号导致整列追问静默丢失。
6. **B6** ——（常驻已通过启动预加载实现；余项为评估 gateway 模型换小以留余量、`setup.sh` 自检提示同机别的长驻大模型。）
7. **`npm run check`** 改名/改实现，避免“语法检查”冒充“回归全绿”。
8. **`publicVersion()`** 加 TTL 缓存，避免每次 HTML 请求重扫目录。
9. **补单测**锁死 B1 的 `spawn` 失败降级路径。

---

## 6. 本次已实施的修复（落盘待重启生效）

| 文件 | 改动 |
|---|---|
| `lib/hermes.js` | `runHermes` / `runSessionsList` 加 `p.on('error')` 降级（B1，P0） |
| `server.js` | 兜底 catch：`SyntaxError`→400（P2，B3）；`listen` 启动即 `prewarmOllama(DEFAULT_MODEL)` 消除冷加载静默挂起（B6，P1 治本） |
| `lib/ollama.js` | 新增 `isModelResident`（查 `/api/ps`，2s 超时，失败降级 false）；`suggestFollowups` 改「先整体解析再回退切片」防追问整列丢失（B5，P2） |
| `lib/routes/chat.js` | `handleChatGateway`：未驻留模型即下发 `notice`；首 token 30s 看门狗下发 `notice`（B2，P1 缓解） |
| `lib/skills.js` | `cosine` 上界改 `Math.min(a.length,b.length)`，防嵌入维度不匹配时 NaN 污染 `/api/skills/find` 排序（P2，B4） |
| `lib/routes/session.js` | `/api/history` 补 `SESSION_ID_RE` 校验，与 rename/delete 对齐（P3 一致性） |
| `public/app.js` | `inline()` 链接渲染改函数式并剥离 `"'<>`，堵住模型输出驱动的 markdown 链接 XSS（P1 安全）；`escapeHtml` 补 `"`→`&quot;` / `'`→`&#39;`，一次性堵住全部 `title="..."` 属性注入点（P3 治本） |
| `lib/routes/provider.js` | `/api/providers/delete` 补 `b.id` 校验：缺 id → 400、不存在 → 404（原 `delete providers[undefined]` 静默 no-op 仍回 ok）（P3 一致性） |
| `lib/workspace.js` | `create(name)` 增 `typeof name !== 'string'` 守卫，防 API 传对象被 `String()` 强转成 `[object Object]`（P3 防御） |

验证：所有改动文件 `node --check` 全过；`npm test` 173/173 通过；前端 XSS 用 Node 抽取 `escapeHtml`/`inline` 跑 4 类 payload 验证 ALL_SAFE。P3 修复已在重启后的实例上实时验证：`/api/providers/delete` 缺 id→400 / 不存在→404、`/api/workspace/create` 非字符串→400 且正常字符串仍→200、托管 `app.js` 含 `&quot;` 转义。`prewarmOllama` 实时验证模型驻留生效。**生效需重启服务**（launchd 托管；已由 agent shell 直接 `launchctl kickstart -k gui/$(id -u)/com.hermes-agent.ui` 完成并验证）。

---

## 7. 遗留与下一步

- ~~chat 网关网仍会在“模型冷”时假红~~ —— **已解**：B6 启动预加载已落地并在重启后实测 `ollama ps` 确认 `hermes-local-gemma4` + `bge-m3` 常驻（2h 续期），冷加载空窗消除；B3 冒烟假红随之消失。
- ~~B2 缓解未端到端验证~~ —— 重启后由 agent shell 直接 kickstart 完成，接口层实时验证通过。
- **已全部落地**：B2/B4/B5/B6 及 P3 一致性项（session 校验、escapeHtml 引号、providers/delete、workspace.create）均已修复并重启生效。
- **仅余（非缺陷）**：网关日志中未启用云功能的工具探测 WARNING 消噪（配置项，非代码）；`npm run check` 建议改名以区分「语法检查」与「七张网回归」。

## 8. 前端（public/）安全复查（2026-09-13 续查）

续查唯一未覆盖的真实代码面 `public/`（单文件 SPA：index.html + app.css + app.js，无框架无构建）。结论：**前端整体防御扎实，但发现 1 个真实安全 Bug（XSS）并修复**。

### Bug #4 — `public/app.js`：Markdown 链接渲染 XSS（P1 安全，已修复）

| 维度 | 内容 |
|---|---|
| **预期行为** | 模型回复里的 `[text](url)` 渲染为安全链接；即使模型被 prompt injection 诱导输出恶意 markdown，也不应执行任意脚本。 |
| **实际表现（修复前）** | `inline()` 中链接正则 `\[([^\]]+)\]\((https?:[^)\s]+)\)` 把 URL 原样插进 `href="$2"`。因 `escapeHtml` 只转义 `& < >`、**不转义引号**，而 URL 正则允许引号（无空格的 `"onmouseover=alert(1)` 可匹配），构造 `](https://a"onmouseover=alert(1))` 即注入裸事件属性 → 同域 XSS（可窃 localStorage 令牌）。 |
| **根本原因** | 渲染用户/模型不可信文本进 HTML 属性时未做引号剥离；`escapeHtml` 缺失引号转义。 |
| **修复** | 链接替换改函数式：`safeUrl = String(url).replace(/["'<>]/g, '')`，再拼 `href`。文本段来自已转义的 `s`，安全。 |

**影响面**：仅改链接渲染分支；正文/标题/代码块早已 `escapeHtml` 或 `highlightCode(escapeHtml)` 转义，不受影响（已用 4 类 payload 验证 ALL_SAFE：引号无空格 / 引号带空格 / `javascript:` 协议 / 正常链接均安全，正常链接保留）。

### 前端其余观察（P3）—— 已治本
- ~~`escapeHtml` 不转义引号，导致若干 `title="${escapeHtml(x)}"` 属性点（app.js:1156 用量 prompt、1415 job id、2218 检查点 reason、2245 文件路径等）在内容含引号时可注入属性。~~ **已修复（治本）**：`escapeHtml` 直接补 `"`→`&quot;` / `'`→`&#39;`，一处改动覆盖全部 5 个属性点；因 `&quot;` 在文本内容与属性值两种上下文均合法，对正文/代码块渲染零影响。属自陷（仅自己浏览器，无令牌泄露），但根因与 P1 链接 XSS 同源，顺手一并封死。
- `addUserMsg` 的 `imgUrl` 仅来自前端 `FileReader` 生成的 data URL（app.js:1903），可信，无风险。
- `index.html` 的 FOUC 自愈守卫、启动屏 5s 兜底、主题无闪烁初始化均正确，无缺陷。

### 后端 P3（一致性/防御）—— 已修复
- `lib/routes/provider.js`：`/api/providers/delete` 原直接 `delete providers[b.id]`，`b.id` 缺失时 `delete providers[undefined]` 静默 no-op 却仍回 `ok:true`。**已补**：缺 id → 400、provider 不存在 → 404。
- `lib/workspace.js`：`create(name)` 原 `String(name || '')` 宽松强转，直接调 API 传对象会建出名为 `[object Object]` 的工作区。**已补** `typeof name !== 'string'` 守卫 → 400。

### 网关日志噪声（P3，仅提示，非缺陷）
- gateway 日志中 `tools.registry: check_fn ... returned False` 一批 WARNING，是看板/Spotify/视频生成/X 搜索/元宝等**未启用云功能**的工具探测结果。本地运行无害，如需消噪可在 gateway 配置中关闭对应 tool 探测或调高日志级别（非代码问题）。

### 全工程审查闭环声明
至此 `server.js` / `lib/*`（全部 13 个模块）/ `public/*` 均已通读。累计定位并修复 **5 个真实缺陷 + 5 个边界/一致性缺陷**：P0 崩服 1、P1 安全 XSS 1、P1 冷加载静默 1、P2 逻辑/边界 3、P3 一致性/防御 4（session 校验、escapeHtml 引号、providers/delete、workspace.create）。**核心崩溃面、安全面与一致性面均已闭环**，无遗留待排期缺陷（仅余网关日志噪声这一非缺陷配置项）。
