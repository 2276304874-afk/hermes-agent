#!/usr/bin/env node
/**
 * gateway-probe.js — 侦察 hermes gateway 的 OpenAI 兼容本地 API（选项 B 的聊天后端）。
 *
 * 零依赖（Node 22 内置 fetch + 流式读取）。仅用于本地诊断，不触碰生产 4173。
 *
 * 前置（本地最小运行配置）：
 *   1) 在 ~/.hermes/config.yaml 启用 api_server 平台适配器（loopback）：
 *        gateway:
 *          platforms:
 *            api_server:
 *              extra:
 *                host: 127.0.0.1        # 默认即 loopback，勿改 0.0.0.0
 *                port: 8642            # API_SERVER_PORT，可改
 *                key: "<≥16 字符的强随机串>"   # API_SERVER_KEY，Bearer 鉴权
 *      （gateway.api_server.port/host/key 形式等价，config_loader 会桥接到 extra。）
 *   2) 启动网关（前台仅诊断；生产应走 launchd 服务）：
 *        env -u PYTHONPATH HERMES_ACCEPT_HOOKS=1 \
 *          ~/.hermes/venvs/hermes/bin/hermes gateway run
 *      启动后监听 127.0.0.1:8642，并在 run_startup 阶段注册 safety_check.py（安全钩子生效）。
 *
 * 用法：
 *   API_SERVER_KEY=xxxx node scripts/gateway-probe.js [prompt]
 *   GATEWAY_API_URL=http://127.0.0.1:8642/v1 API_SERVER_KEY=xxxx node scripts/gateway-probe.js "你好"
 *
 * 输出：/models、/capabilities 摘要 + 一次聊天回合的首 token 延迟与流式完整性。
 */
'use strict';

const API_URL = (process.env.GATEWAY_API_URL || 'http://127.0.0.1:8642/v1').replace(/\/$/, '');
const API_KEY = process.env.API_SERVER_KEY || '';
const PROMPT = process.argv[2] || '用一句话介绍你自己。';

function fail(msg, err) {
  console.error('[gateway-probe] ' + msg + (err ? ': ' + (err.message || err) : ''));
  process.exit(1);
}

async function getJSON(path) {
  const r = await fetch(API_URL + path, {
    headers: API_KEY ? { Authorization: 'Bearer ' + API_KEY } : {},
  });
  if (!r.ok) fail(`GET ${path} -> HTTP ${r.status}`);
  return r.json();
}

async function discoverModel() {
  try {
    const j = await getJSON('/models');
    const list = j.data || j.models || [];
    if (list.length) return list[0].id;
  } catch (_) { /* 忽略，回退默认 */ }
  return 'hermes';
}

/** 标准 OpenAI 兼容 chat/completions，SSE 流式，返回 {firstTokenMs, done, text} */
async function chatStream(model) {
  const t0 = Date.now();
  const r = await fetch(API_URL + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(API_KEY ? { Authorization: 'Bearer ' + API_KEY } : {}),
    },
    body: JSON.stringify({
      model,
      stream: true,
      messages: [{ role: 'user', content: PROMPT }],
    }),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    fail(`POST /chat/completions -> HTTP ${r.status} ${txt.slice(0, 300)}`);
  }
  if (!r.body || typeof r.body.getReader !== 'function') fail('响应非流式（无 body reader）');

  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let firstTokenMs = -1;
  let text = '';
  let done = false;
  for (;;) {
    const { value, done: eof } = await reader.read();
    if (eof) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line || !line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') { done = true; continue; }
      try {
        const ev = JSON.parse(payload);
        const delta = ev.choices && ev.choices[0] && ev.choices[0].delta;
        const piece = delta && (delta.content || delta.text || '');
        if (piece) {
          if (firstTokenMs < 0) firstTokenMs = Date.now() - t0;
          text += piece;
        }
      } catch (_) { /* 跳过非 JSON 行 */ }
    }
  }
  return { firstTokenMs, done, text };
}

async function main() {
  if (!API_KEY) console.warn('[gateway-probe] 未设 API_SERVER_KEY；若网关允许无 key 才能通，否则会 401。');
  console.log('[gateway-probe] endpoint =', API_URL);

  try {
    const caps = await getJSON('/capabilities');
    console.log('[gateway-probe] capabilities.session_chat =', caps && caps.session_chat);
    console.log('[gateway-probe] capabilities.run_approval_response =', caps && caps.run_approval_response);
  } catch (e) { console.warn('[gateway-probe] /capabilities 失败（非致命）:', e.message); }

  let model = 'hermes';
  try {
    const m = await discoverModel();
    model = m;
    console.log('[gateway-probe] 选用 model =', model);
  } catch (e) { console.warn('[gateway-probe] /models 失败，回退 model=hermes:', e.message); }

  console.log('[gateway-probe] 发送:', JSON.stringify(PROMPT));
  const res = await chatStream(model);
  const totalMs = res.firstTokenMs < 0 ? -1 : null; // 仅首 token 计时；总时长由调用方自行测
  console.log('[gateway-probe] 首 token 延迟 =', res.firstTokenMs < 0 ? '（无流式内容）' : res.firstTokenMs + 'ms');
  console.log('[gateway-probe] 流结束 [DONE] =', res.done);
  console.log('[gateway-probe] 回复前 200 字 =\n' + res.text.slice(0, 200));
  if (res.firstTokenMs < 0 || !res.done) fail('流式回合不完整');
  console.log('[gateway-probe] OK');
}

main().catch((e) => fail('异常', e));
