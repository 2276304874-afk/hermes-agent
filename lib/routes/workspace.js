'use strict';
/*
 * 工作区路由：列表 / 新建 / 删除 / 会话归属。全部在认证闸门之后。
 * 存储见 lib/workspace.js（独立 JSON，不碰 hermes state.db）。
 */

const { SESSION_ID_RE } = require('../config');
const { sendJSON, readBody } = require('../http');
const ws = require('../workspace');

module.exports = {
  register(router) {

    router.add('GET', '/api/workspaces', (req, res) => {
      return sendJSON(res, 200, ws.list());
    });

    router.add('POST', '/api/workspace/create', async (req, res) => {
      const b = JSON.parse(await readBody(req) || '{}');
      const r = ws.create(b.name);
      return sendJSON(res, r.error ? 400 : 200, r);
    });

    router.add('POST', '/api/workspace/delete', async (req, res) => {
      const b = JSON.parse(await readBody(req) || '{}');
      const r = ws.remove(b.name);
      return sendJSON(res, r.error ? 400 : 200, r);
    });

    // 重命名：必须整体迁移归属，否则等于变相删空间（会话散落回「未归类」）
    router.add('POST', '/api/workspace/rename', async (req, res) => {
      const b = JSON.parse(await readBody(req) || '{}');
      const r = ws.rename(b.from, b.to);
      return sendJSON(res, r.error ? 400 : 200, r);
    });

    // 会话归属：workspace 为空串 = 移出工作区（归入「未归类」）
    router.add('POST', '/api/workspace/assign', async (req, res) => {
      const b = JSON.parse(await readBody(req) || '{}');
      const sid = String(b.id || '').trim();
      if (!SESSION_ID_RE.test(sid)) return sendJSON(res, 400, { error: 'bad session id' });
      const w = String(b.workspace || '').trim();
      const r = ws.assign(sid, w);
      return sendJSON(res, r.error ? 400 : 200, r);
    });
  },
};
