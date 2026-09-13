'use strict';
/*
 * 知识库路由
 *
 * 公开组（认证前）：
 *   GET /kb、/kb/*      → 托管 kb/viewer.html（原独立 4174 服务的页面，现已同源）
 *
 * 认证组（与 /api/* 同一把 Bearer 令牌）：
 *   GET /api/kb/list    → 按分类列举条目
 *   GET /api/kb/search  → FTS5 召回
 *   GET /api/kb/status  → 分类计数 + Ollama 状态
 *   GET /api/kb?q=      → 旧的 slash 召回接口（保留，前端仍有调用）
 *
 * ---------- P2-10 认证决策（2026-09-11，明确记录，勿随手改回）----------
 * KB 接口**不再是公开路由**，改走与 /api/* 相同的认证闸门。理由：
 *   ① KB 内含 MEMORY.md 这类私有笔记，是本项目里最敏感的数据；
 *   ② 服务其余 /api/* 全部要令牌，唯独 KB 例外 → 认知负担，且容易被当成漏洞；
 *   ③ 原先的兜底理由"只绑 127.0.0.1"太脆 —— HOST 只是 plist 里一行 env，
 *      2026-09-06 曾为局域网访问改成 0.0.0.0，一旦再开，公开的 KB 即全网段可读。
 * 代价：viewer.html 需带令牌 —— 它从同源 localStorage('hermes_ui_token') 读，
 *      与主界面共用同一把，不需要输两遍；401 时页面顶部弹出补填提示。
 * GET /kb 页面壳保持公开：返回的是一张不含任何数据的静态 HTML，认证在这里没有意义。
 *
 * 注意：/kb 页面必须排在静态文件之前（否则会被 serveStatic 拦成 404），
 * 且 '/api/kb'（slash 召回）必须排在 /api/kb/list|search|status 之后 ——
 * 路由是前缀匹配，否则 '/api/kb' 会把另外三条全吞掉。
 */

const fs = require('fs');
const path = require('path');
const { WORKSPACE, PORT } = require('../config');
const { sendJSON } = require('../http');
const { kbListEntries, recallHits } = require('../knowledge');
const { ollamaStatusSync } = require('../ollama');

module.exports = {
  registerPublic(router) {

    // 严格匹配：/kb 与 /kb/ 开头的子路径都给 viewer.html（与拆分前一致）
    router.add('GET', (req) => req.url === '/kb' || req.url.startsWith('/kb/'), (req, res) => {
      return fs.readFile(path.join(WORKSPACE, 'kb', 'viewer.html'), (err, data) => {
        if (err) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
        res.end(data);
      });
    });
  },

  registerAuthed(router) {

    router.add('GET', '/api/kb/list', (req, res) => {
      const m = (req.url.split('?')[1] || '').match(/(?:^|&)cat=([^&]*)/);
      return sendJSON(res, 200, kbListEntries(m ? decodeURIComponent(m[1]) : 'all'));
    });

    router.add('GET', '/api/kb/search', async (req, res) => {
      const m = (req.url.split('?')[1] || '').match(/(?:^|&)q=([^&]*)/);
      const q = m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : '';
      const hits = q ? await recallHits(q) : [];
      const results = hits.slice(0, 50).map(h => ({ cat: 'search', type: h.section || '', src: h.source || '', text: h.text || '', score: h.score }));
      return sendJSON(res, 200, { query: q, count: results.length, results });
    });

    router.add('GET', '/api/kb/status', async (req, res) => {
      const entries = kbListEntries('all');
      const counts = { inbox: 0, distilled: 0, memory: 0 };
      for (const e of entries) if (e.cat in counts) counts[e.cat]++;
      const ollama = await ollamaStatusSync();
      return sendJSON(res, 200, { kb_port: PORT, counts, total: entries.length, ollama });
    });

    /* 知识库 slash 命令 /kb 的召回接口 —— 必须排在上面三条之后（前缀匹配） */
    router.add('GET', '/api/kb', async (req, res) => {
      const q = (req.url.split('?')[1] || '');
      const m = q.match(/(?:^|&)q=([^&]*)/);
      const query = m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : '';
      const hits = query ? await recallHits(query) : [];
      // 相关性阈值：与自动召回一致，弱相关不返回（前端按"未找到"提示）
      const RECALL_MIN_SCORE = 0.15;
      const filtered = hits.filter(h => (h.score ?? 0) >= RECALL_MIN_SCORE);
      const slim = (filtered.length ? filtered : hits).slice(0, 6).map(h => ({
        section: h.section || '经验', source: h.source || '', text: h.text || '',
        score: typeof h.score === 'number' ? Math.round(h.score * 100) / 100 : h.score,
      }));
      return sendJSON(res, 200, { query, hits: slim, count: slim.length });
    });
  },
};
