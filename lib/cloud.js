'use strict';
/* =============================================================================
 * lib/cloud.js —— 云端 provider（可选增强层）
 *
 * local-first 是硬约束，云端是**可选**：健康检查失败自动降级本地 hermes-local。
 * API key 明文存 ~/.hermes/cloud_providers.json（0600），API 返回时一律打码。
 * 预设对齐 Hermes 内置注册表 hermes_cli/auth.py —— key 走环境变量注入，
 * 无需改 config.yaml。
 * ========================================================================== */

const fs = require('fs');
const { CLOUD_FILE, LOCAL_MODELS, DEFAULT_MODEL } = require('./config');

/* ---------- 云端 provider 预设 ---------- */
const PROVIDER_PRESETS = {
  'deepseek':       { label: 'DeepSeek',       env: 'DEEPSEEK_API_KEY',  baseEnv: 'DEEPSEEK_BASE_URL',  base: 'https://api.deepseek.com/v1' },
  'alibaba':        { label: '通义千问 Qwen',   env: 'DASHSCOPE_API_KEY', baseEnv: 'DASHSCOPE_BASE_URL',  base: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  'zai':            { label: '智谱 GLM',       env: 'GLM_API_KEY',       baseEnv: 'GLM_BASE_URL',       base: 'https://open.bigmodel.cn/api/paas/v4' },
  'kimi-coding-cn': { label: 'Kimi (中国)',    env: 'KIMI_CN_API_KEY',   baseEnv: '',                   base: 'https://api.moonshot.cn/v1' },
  'kimi-coding':    { label: 'Kimi (国际)',    env: 'KIMI_API_KEY',      baseEnv: 'KIMI_BASE_URL',      base: 'https://api.moonshot.ai/v1' },
  'xai':            { label: 'xAI Grok',       env: 'XAI_API_KEY',       baseEnv: 'XAI_BASE_URL',       base: 'https://api.x.ai/v1' },
  'openai-api':     { label: 'OpenAI/兼容端点', env: 'OPENAI_API_KEY',    baseEnv: 'OPENAI_BASE_URL',    base: 'https://api.openai.com/v1' },
  'siliconflow':    { label: 'SiliconFlow 硅基流动', env: 'SILICONFLOW_API_KEY', baseEnv: 'SILICONFLOW_BASE_URL', base: 'https://api.siliconflow.cn/v1' },
};

/* ---------- 配置存储 ---------- */
function loadCloudProviders() {
  try {
    const raw = JSON.parse(fs.readFileSync(CLOUD_FILE, 'utf8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw; // {id: {apiKey, baseUrl, models[]}}
  } catch (e) {
    // 「还没配过」= ENOENT，属正常空态，不留痕；文件在却读不动/解析不了才是故障 ——
    // 那种情况下列表会变空，看起来像「配置丢了」，必须可见。
    if (e.code !== 'ENOENT') console.warn(`[cloud] 读取 ${CLOUD_FILE} 失败：${e.message} → 云端接口按"未配置"处理`);
  }
  return {};
}

function saveCloudProviders(map) {
  fs.writeFileSync(CLOUD_FILE, JSON.stringify(map, null, 2), { mode: 0o600 });
}

function maskKey(k) {
  const s = String(k || '');
  if (!s) return '';
  return s.length <= 8 ? '****' : s.slice(0, 4) + '****' + s.slice(-4);
}

/* ---------- 云端健康检查（60s 缓存） ----------
 * 判据是"可达"而非"可用"：429 算可达（说明 key 和网络都对，只是限流）。
 * 故意不缓存 force=true 的结果差异——前端点"测试"时传 force 绕过缓存。 */
const healthCache = new Map(); // id -> {ok, ts, latencyMs, error}

async function providerHealth(id, cfg, force = false) {
  const cached = healthCache.get(id);
  if (!force && cached && Date.now() - cached.ts < 60_000) return cached;
  const preset = PROVIDER_PRESETS[id] || {};
  const base = (cfg.baseUrl || preset.base || '').replace(/\/+$/, '');
  const result = { ok: false, ts: Date.now(), latencyMs: 0, error: '' };
  const t0 = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    const r = await fetch(base + '/chat/completions', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.apiKey },
      body: JSON.stringify({ model: (cfg.models && cfg.models[0]) || 'test', messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false })
    });
    clearTimeout(timer);
    result.latencyMs = Date.now() - t0;
    if (r.status === 200) result.ok = true;
    else if (r.status === 401 || r.status === 403) result.error = 'API key 无效 (' + r.status + ')';
    else if (r.status === 404) result.error = '模型不存在或路径错误 (404)';
    else if (r.status === 429) { result.ok = true; result.error = '限流中，但可达'; } // 429 = 可达
    else result.error = 'HTTP ' + r.status;
  } catch (e) {
    result.latencyMs = Date.now() - t0;
    result.error = e.name === 'AbortError' ? '连接超时 (10s)' : ('网络错误: ' + e.message);
  }
  healthCache.set(id, result);
  return result;
}

/* ---------- 模型解析 ----------
 * 'hermes-local' → {cloud:false, model:'hermes-local'}
 * 'cloud:deepseek/deepseek-chat' → {cloud:true, providerId:'deepseek', model:'deepseek-chat'}
 * 注意：本地模型白名单外的一律回落到 DEFAULT_MODEL（防前端传幽灵模型名）。 */
function resolveModel(value) {
  const v = String(value || '');
  if (v.startsWith('cloud:')) {
    const rest = v.slice(6);
    const slash = rest.indexOf('/');
    if (slash > 0) {
      const providerId = rest.slice(0, slash);
      const model = rest.slice(slash + 1);
      if (PROVIDER_PRESETS[providerId] && model) return { cloud: true, providerId, model };
    }
  }
  return { cloud: false, model: LOCAL_MODELS.includes(v) ? v : DEFAULT_MODEL };
}

module.exports = {
  PROVIDER_PRESETS, loadCloudProviders, saveCloudProviders, maskKey,
  healthCache, providerHealth, resolveModel,
};
