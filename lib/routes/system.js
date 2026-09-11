'use strict';
/*
 * 系统路由：健康 / Ollama 状态 / 用量 / 模型列表 / 认证探测。
 * 全部在认证闸门之后（含 /api/auth —— 它本身就是"这把 token 通不通"的探针）。
 */

const fs = require('fs');
const path = require('path');
const { PUBLIC_DIR, LOCAL_MODELS, DEFAULT_MODEL } = require('../config');
const { sendJSON } = require('../http');
const { patchState } = require('../hermes');
const { ollamaStatus, ollamaGet } = require('../ollama');
const { usageLog } = require('../state');
const { loadCloudProviders, PROVIDER_PRESETS } = require('../cloud');

module.exports = {
  register(router) {

    // L4: 健康（含流式补丁状态）
    router.add('GET', '/api/health', (req, res) => {
      let uiVersion = null;
      try { uiVersion = String(fs.statSync(path.join(PUBLIC_DIR, 'index.html')).mtimeMs); } catch { /* 版本探测失败不阻断 */ }
      return sendJSON(res, 200, { ok: true, uptimeSec: Math.round(process.uptime()), patch: patchState, uiVersion });
    });

    // L4: Ollama 运行状态
    router.add('GET', '/api/status', async (req, res) => {
      return sendJSON(res, 200, { ollama: await ollamaStatus() });
    });

    // L4: 近轮用量
    router.add('GET', '/api/usage', (req, res) => {
      return sendJSON(res, 200, { runs: usageLog.slice(-30).reverse() });
    });

    router.add('GET', '/api/models', async (req, res) => {
      const providers = loadCloudProviders();
      // 只列真实已装的本地模型（与 /api/tags 取交集），避免下拉出现不存在的模型。
      // 纯 embedding 模型（bge-m3 等，capabilities 仅含 embedding）排除在对话下拉外。
      const norm = s => String(s || '').replace(/:latest$/, '');
      const tags = await ollamaGet('/api/tags');
      let local;
      if (tags && Array.isArray(tags.models)) {
        const chatModels = tags.models
          .filter(m => !(m.capabilities || []).includes('embedding'))
          .map(m => m.name);
        const chatSet = new Set(chatModels.map(norm));
        const seen = new Set();
        local = [];
        for (const m of LOCAL_MODELS) {            // 偏好序优先
          if (chatSet.has(norm(m)) && !seen.has(norm(m))) { local.push({ value: norm(m), label: norm(m) }); seen.add(norm(m)); }
        }
        for (const m of chatModels) {              // 其余已装模型补在后面
          if (!seen.has(norm(m))) { local.push({ value: m, label: m }); seen.add(norm(m)); }
        }
      } else {
        local = LOCAL_MODELS.map(m => ({ value: m, label: m }));
      }
      const cloud = [];
      for (const [id, cfg] of Object.entries(providers)) {
        const preset = PROVIDER_PRESETS[id];
        if (!preset || !cfg.apiKey) continue;
        for (const m of (cfg.models || [])) {
          if (m) cloud.push({ value: `cloud:${id}/${m}`, label: `${preset.label} · ${m}` });
        }
      }
      return sendJSON(res, 200, { local, cloud, default: DEFAULT_MODEL });
    });

    router.add('GET', '/api/auth', (req, res) => {
      return sendJSON(res, 200, { ok: true });
    });
  },
};
