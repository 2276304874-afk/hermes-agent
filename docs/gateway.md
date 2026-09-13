# gateway 后端接线说明

本文描述「赫尔墨斯特工」Web UI 与 Hermes gateway 常驻进程的对接方式、通信契约、
已知坑点与排障清单。目标读者：在本机维护/重启这套服务的人。

---

## 1. 为什么是 gateway，而不是 `hermes serve`

| | `hermes serve` | `hermes gateway run` |
|---|---|---|
| 是否常驻 | 是 | 是 |
| 是否注册 `pre_tool_call` 安全 hook | **否** | 是 |
| 高危命令拦截 | **静默失效** | 生效（已实测 `rm -rf` 被拦） |

Hermes 源码 `main.py:2732` 对 `serve` 提前 return，`web_server_sessions.py:205` 明示
"serve runs neither CLI nor gateway startup hooks"；而 `gateway run` 在 `run_startup.py:831`
注册该 hook。

> ⛔ **红线：绝不把后端切回 `hermes serve`。** 那等于在不报错的前提下关掉安全拦截。
> 可用后端只有两个：`gateway run`（首选）和 `hermes -z`（保底）。

---

## 2. 配置

`~/.hermes/config.yaml`（600 权限）：

```yaml
gateway:
  platforms:
    api_server:
      enabled: true
      extra:
        host: 127.0.0.1     # ⛔ 禁改成 0.0.0.0
        port: 8642
        key: <≥16 位随机串>  # 对应 Bearer API_SERVER_KEY
```

- UI 侧通过 `lib/gateway.js` 的 `gatewayKey()` 从此文件读取，**config.yaml 是单一真源**。
- 也支持环境变量 `HERMES_GATEWAY_KEY` 覆盖（优先级更高，测试用）。
- 解析规则：先在 `api_server:` 缩进块内找 `key:`，找不到才全文兜底；支持裸值、单/双引号、行内 `#` 注释。
  引号内的 `#` 不当作注释。详见 `test/gateway.test.js`。
- key 不足 16 位时 `describeKey()` 会给出明确原因，不会拖到调用时才报莫名的 401。

### launchd 常驻

```
标签：com.hermes-agent.gateway
安装：bash setup.sh        # ⚠️ bootstrap/load 必须在 Terminal.app 里跑，
                           #    我在受限 shell 里执行会必报 EIO 5
重启：launchctl kickstart -k gui/$(id -u)/com.hermes-agent.gateway
```

plist 的关键 env：

- `HERMES_ACCEPT_HOOKS=1` —— 没有它安全 hook 不注册
- `NO_PROXY=127.0.0.1,localhost`
- `PYTHONPATH` 清空 —— 污染后 gateway 起不来

---

## 3. 通信契约

| 用途 | 路径 | 说明 |
|---|---|---|
| 建会话 | `POST /api/sessions` | **顶层路径，不是 `/v1`** |
| 流式对话 | `POST /api/sessions/{id}/chat/stream` | Hermes 原生 SSE |
| 鉴权 | `Authorization: Bearer <key>` | |
| 探活 | `GET /health` | UI 用它决定走 gateway 还是回退 -z |

**双通道**：真流式文本来自 SSE 的 `assistant.delta` → 前端 `token` 事件；
tool 调用 / reasoning 来自 `state.db` 轮询（`newMessages()`）→ 前端 `msg` 事件。
后者是权威来源，故 SSE 里的 `tool.*` / `run.completed` 一律忽略，避免重复渲染。

### 安全边界

- 8642 **只由本 Node 进程发起调用**，浏览器绝不直连。
- api_server 的 CORS 是 origin-gated（跨站 403），Node 无 `Origin` 头所以放行——这是刻意的，不要"顺手"给浏览器加上。
- 危险命令放行走文件 `~/.hermes/ui_bypass_sessions.json`，**不走 env**（常驻进程 env 固定，改不动）。

---

## 4. 已知坑点（都踩过）

### 4.1 会话标题必须全局唯一

`POST /api/sessions` 对重复 title 返回：

```
400 {"error":{"message":"Title already in use"}}
```

同一句 prompt 问两次是常态，所以 `lib/routes/chat.js` 一律用：

```js
title: `${prompt.slice(0, 32)} #${runId.slice(0, 8)}`
```

**排查提示**：gateway 的业务错误只在响应体里给真因。`createSession` 抛出时必须带
`await r.text()` 片段，否则 UI 侧只见一个没头没尾的 400。

### 4.2 SSE 行终结符不能只认 `\n`

服务端一旦用了 CRLF，行尾残留的 `\r` 会让"空行即炸帧"永远不成立 → **整条流一帧都不吐**，
前端表现为永久转圈。解析器必须同时支持 LF / CRLF / CR，见 `createSSEParser()`。

### 4.3 拆包必须靠同一个 `TextDecoder`

一个 UTF-8 汉字可能被切成两个 WebSocket/TCP 块。必须用
`new TextDecoder().decode(value, { stream: true })`。
**不要**用 `Buffer#toString('utf8')` —— 半个汉字会被解成 `U+FFFD`，那是调用方的错，不是解析器的。

### 4.4 会话 id 要补登到 `active`

gateway 路径里 `createSession` 是异步的，`ready` 事件发出时会话还没建出来。
若不在此后补 `active.set(sessionId, ...)`，前端拿 `sessionId` 调 `/api/stop` 会命中不到。
（`-z` 路径在轮询里补登记，两条后端行为必须保持一致 —— 由 `test/stop.smoke.js` 用例 4 守住。）

### 4.5 空闲看门狗

默认的**空闲**（不是总时长）超时 5 分钟（`HERMES_STREAM_IDLE_MIN` 覆盖）。
选空闲而非总时长，是为了不让长 agent run 被误杀：只要有字节到达就续期。

### 4.6 首 token stall 降级（⑥，默认关）

看门狗只能"告知 + 漫长后中断"，不能自救。可选的 stall 降级补这一环：**首 token 之前**
卡住超过阈值 → 换一个更小的**已驻留**模型新建会话重跑本轮。

| 环境变量 | 默认 | 作用 |
|---|---|---|
| `HERMES_STALL_SEC` | 未设（= 关闭） | 首 token 超时阈值（秒）。未设或 ≤0 为关闭 |
| `HERMES_FALLBACK_MODEL` | 未设 | 备用模型名（如 `qwen3:8b`）。不设则不降级 |

两条硬边界（决策逻辑在 `lib/stall.js`，纯函数、`test/stall.test.js` 全分支覆盖）：

1. **只在首 token 之前**降级。已经吐过字再换模型，用户会看到两段拼接的回答，比卡住更糟。
2. **备用模型必须已驻留**才降级。本机 16G 同时只容得下一个 ≥8B 模型，
   若备用模型是冷的，降级要**先驱逐主模型再冷加载备用模型** —— 这一轮更慢，下一轮还得再冷加载主模型，
   代价大于原地等。所以 `fallbackResident === false` 一律不降级。

另外只降**一级**（`attempts >= 1` 即止），且换会话后会把被放弃会话的 `active` 映射摘掉 ——
否则该会话会永远挂在 `active` 里，之后任何请求都会被会话车道（②）判为「忙」而 409。

---

## 5. 运行时可观测性

```bash
curl -s -H "Authorization: Bearer $(cat ~/.hermes/ui_token)" \
  http://127.0.0.1:4173/api/health | jq .gateway
```

返回示例（**不含 key 明文**）：

```json
{"enabled":true,"base":"http://127.0.0.1:8642","up":true,
 "keyConfigured":true,"reason":"","checkedAt":1789148389631}
```

UI 启动时还会打 `[gateway] 初始探活：…`，之后每 30s 探活**仅在状态跃迁时**落一行：

```
[gateway] gateway 状态跃迁：就绪 → 不可达，新请求将自动回退 -z 保底
```

存在意义：gateway 掉线时 UI 会静默降级成 `-z`（慢但能用）。没有这行日志，
使用者只会觉得"最近怎么变慢了"，无从归因。它**不**负责把 gateway 拉起来 —— 那是 launchd 的活。

---

## 6. 排障清单

| 现象 | 先看 |
|---|---|
| UI 说"走了 -z" | `/api/health` 的 `gateway.up`；为 false 则查 launchd 是否注册、gateway 日志 |
| `createSession` 报 400 | 响应体里是 `Title already in use` → 标题没带唯一后缀 |
| 全部请求 401 | key 配了但 <16 位，或 UI 读到的是空（`describeKey().reason`） |
| 流式永久转圈、一个字不出 | 见 4.2 / 4.3 |
| 高危命令突然能执行了 | 检查后端是不是被切成了 `hermes serve`（见第 1 节红线） |
| 停止按钮没反应 | `active` 里没有该 id；跑 `node test/stop.smoke.js` |

---

## 7. 相关文件

| 文件 | 职责 |
|---|---|
| `lib/gateway.js` | gateway 客户端：key 解析、探活、看护、SSE 解析、建会话 |
| `lib/workspace.js` + `lib/routes/workspace.js` | 工作区元数据：列表/新建/**重命名**/删除/会话归属 |
| `lib/routes/chat.js` | 两条后端（-z / gateway）的编排与 `/api/stop` |
| `lib/safety.js` | 会话级危险放行文件读写（秒级 TTL） |
| `test/gateway.test.js` | SSE 解析 + key 提取单测（20 项，不联网） |
| `test/stop.smoke.js` | `/api/stop` 契约测试（9 项，需服务在线） |
| `test/chat.gateway.smoke.js` | 多轮续聊 + 危险放行契约测试 |
| `launchd/com.hermes-agent.gateway.plist` | gateway 常驻服务定义 |
