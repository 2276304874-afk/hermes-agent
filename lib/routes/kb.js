'use strict';
/*
 * 知识库路由
 *
 * 公开组（认证前，仅 127.0.0.1，只读）：
 *   GET /kb、/kb/*      → 托管 kb/viewer.html（原独立 4174 服务的页面，现已同源）
 *   GET /api/kb/list    → 按分类列举条目
 *   GET /api/kb/search  → FTS5 召回
 *   GET /api/kb/status  → 分类计数 + Ollama 状态
 * 认证组：
 *   GET /api/kb?q=      → 旧的 slash 召回接口（保留，前端仍有调用）
 *
 * 注意：公开组必须排在静态文件之前（否则 /kb 会被 serveStatic 拦成 404），
 * 且认证组必须排在公开组之后 —— 否则 /api/kb?q= 会被 /api/kb/list 之类抢走。
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

    router.add('GET', '/api/kb/list', (req, res) => {
      const m = (req.url.split('?')[1] || '').match(/(?:^|&)cat=([^&]*)/);
      return sendJSON(res, 200, kbListEntries(m ? decodeURIComponent(m[1]) : 'all'));
    });

    router.add('GET', '/api/kb/search', (req, res) => {
      const m = (req.url.split('?')[1] || '').match(/(?:^|&)q=([^&]*)/);
      const q = m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : '';
      const hits = q ? recallHits(q) : [];
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
  },

  registerAuthed(router) {
    /* 知识库 slash 命令 /kb 的召回接口 */
    router.add('GET', '/api/kb', (req, res) => {
      const q = (req.url.split('?')[1] || '');
      const m = q.match(/(?:^|&)q=([^&]*)/);
      const query = m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : '';
      const hits = query ? recallHits(query) : [];
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
