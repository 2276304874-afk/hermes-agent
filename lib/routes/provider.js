'use strict';
/*
 * 云端 provider 路由：配置读写 / 健康检查 / 本地模型预热。
 * 全部在认证闸门之后。API key 明文存 ~/.hermes/cloud_providers.json(0600)，返回时打码。
 */

module.exports = {
  register(router, ctx) {
    const {
      sendJSON, readBody, loadCloudProviders, saveCloudProviders, maskKey,
      PROVIDER_PRESETS, healthCache, providerHealth, resolveModel, prewarmOllama,
    } = ctx;

    router.add('GET', '/api/providers', (req, res) => {
      const providers = loadCloudProviders();
      const out = {};
      for (const [id, cfg] of Object.entries(providers)) {
        out[id] = {
          label: (PROVIDER_PRESETS[id] || {}).label || id,
          apiKeyMasked: maskKey(cfg.apiKey),
          hasKey: !!cfg.apiKey,
          baseUrl: cfg.baseUrl || (PROVIDER_PRESETS[id] || {}).base || '',
          models: cfg.models || [],
          health: healthCache.get(id) || null
        };
      }
      return sendJSON(res, 200, { providers: out, presets: PROVIDER_PRESETS });
    });

    router.add('POST', '/api/providers/save', async (req, res) => {
      const b = JSON.parse(await readBody(req) || '{}');
      const id = String(b.id || '').trim();
      if (!PROVIDER_PRESETS[id]) return sendJSON(res, 400, { error: 'unknown provider id' });
      const providers = loadCloudProviders();
      const prev = providers[id] || {};
      providers[id] = {
        apiKey: (b.apiKey && String(b.apiKey).trim()) || prev.apiKey || '',
        baseUrl: (b.baseUrl != null ? String(b.baseUrl).trim() : prev.baseUrl || ''),
        models: Array.isArray(b.models) ? b.models.map(s => String(s).trim()).filter(Boolean) : (prev.models || [])
      };
      if (!providers[id].apiKey) return sendJSON(res, 400, { error: 'apiKey required' });
      saveCloudProviders(providers);
      return sendJSON(res, 200, { ok: true, apiKeyMasked: maskKey(providers[id].apiKey) });
    });

    router.add('POST', '/api/providers/delete', async (req, res) => {
      const b = JSON.parse(await readBody(req) || '{}');
      const providers = loadCloudProviders();
      delete providers[b.id];
      saveCloudProviders(providers);
      return sendJSON(res, 200, { ok: true });
    });

    router.add('POST', '/api/provider/health', async (req, res) => {
      const b = JSON.parse(await readBody(req) || '{}');
      const providers = loadCloudProviders();
      const cfg = providers[b.id];
      if (!cfg) return sendJSON(res, 404, { error: 'provider not configured' });
      const hc = await providerHealth(b.id, cfg, true);
      return sendJSON(res, 200, hc);
    });

    router.add('POST', '/api/prewarm', async (req, res) => {
      const b = JSON.parse(await readBody(req) || '{}');
      const m = resolveModel(b.model);
      if (m.cloud) return sendJSON(res, 200, { ok: false, error: '云端模型无需预热' });
      prewarmOllama(m.model);
      return sendJSON(res, 200, { ok: true, model: m.model });
    });
  },
};
