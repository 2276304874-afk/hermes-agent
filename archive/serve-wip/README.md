# 已否决：hermes serve 后端（选项 B 之前的探索）

`serve.js` 与 `serve-probe.js` 是早期「用 `hermes serve` 消除每轮冷启动」方案的产物。
**该方案已否决**，原因（实测 + 源码双重确认）：

- `hermes serve` 启动走快路径，**不注册** `pre_tool_call` 安全 hook
  （main.py:2732 对 serve 提前 return；web_server_sessions.py:205 明示
  "serve runs neither CLI nor gateway startup hooks"）。
- 切过去会**静默关掉** `hooks/safety_check.py` 的高危命令拦截 —— 对安全优先的本地项目不可接受。
- 改用 **gateway run**（`gateway/platforms/api_server.py` 的 OpenAI 兼容 API）作常驻后端：
  它在 `run_startup.py:831` **注册并执行** 安全 hook，且同样常驻、首回合后全热。

替代实现见 `lib/gateway.js`（客户端）+ `lib/safety.js`（会话级放行）+ `scripts/gateway-probe.js`（诊断）。

> 这两个文件**不再被任何模块 require**，仅作历史存档，请勿在新代码里引用。
