'use strict';
/*
 * 会话路由：列表 / 历史 / 重命名 / 删除 / 导出 Markdown。
 * 全部在认证闸门之后。
 */

const { SESSION_ID_RE } = require('../config');
const { sendJSON, readBody } = require('../http');
const { parseResult } = require('../parse');
const { runSessionsList, runHermes } = require('../hermes');
const { withDB, buildSessionMarkdown } = require('../db');
const wsStore = require('../workspace');

module.exports = {
  register(router) {

    /* P1-4: 空列表与"解析失效"必须可区分 —— degraded 为**附加**字段（200，不改成 5xx）：
     * 前端仍能渲染列表并在顶部提示"疑似 CLI 输出格式变更"，而不是让用户以为"本来就没有会话"。 */
    router.add('GET', '/api/sessions', async (req, res) => {
      const { items, raw } = await runSessionsList(30);
      const r = parseResult('sessions list', raw, items);
      return sendJSON(res, 200, r.ok
        ? { sessions: r.items }
        : { sessions: r.items, degraded: true, warning: r.warning });
    });

    router.add('GET', '/api/history', (req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      const sid = (u.searchParams.get('session') || '').trim();
      if (!sid) return sendJSON(res, 400, { error: 'session required' });
      const rows = withDB(d => d.prepare(
        'SELECT id, role, tool_name, content, tool_calls, display_kind, reasoning, timestamp FROM messages WHERE session_id=? ORDER BY id'
      ).all(sid)) || [];
      return sendJSON(res, 200, { sessionId: sid, messages: rows });
    });

    // L4: 会话重命名
    router.add('POST', '/api/session/rename', async (req, res) => {
      const b = JSON.parse(await readBody(req) || '{}');
      const sid = String(b.id || '').trim();
      const title = String(b.title || '').trim();
      if (!SESSION_ID_RE.test(sid)) return sendJSON(res, 400, { error: 'bad session id' });
      if (!title || title.length > 80) return sendJSON(res, 400, { error: '标题需 1-80 字符' });
      const r = await runHermes(['sessions', 'rename', sid, title]);
      return sendJSON(res, r.code === 0 ? 200 : 500, r.code === 0 ? { ok: true } : { error: 'rename failed: ' + r.err });
    });

    // L4: 会话删除
    router.add('POST', '/api/session/delete', async (req, res) => {
      const b = JSON.parse(await readBody(req) || '{}');
      const sid = String(b.id || '').trim();
      if (!SESSION_ID_RE.test(sid)) return sendJSON(res, 400, { error: 'bad session id' });
      const r = await runHermes(['sessions', 'delete', sid, '--yes']);
      if (r.code === 0) wsStore.removeSession(sid);   // 清理工作区归属，防孤儿映射膨胀
      return sendJSON(res, r.code === 0 ? 200 : 500, r.code === 0 ? { ok: true } : { error: 'delete failed: ' + r.err });
    });

    // L4: 导出会话 Markdown（附件下载）
    router.add('GET', '/api/session/export', (req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      const sid = (u.searchParams.get('session') || '').trim();
      if (!SESSION_ID_RE.test(sid)) return sendJSON(res, 400, { error: 'bad session id' });
      const rows = withDB(d => d.prepare(
        'SELECT role, tool_name, content, tool_calls, timestamp FROM messages WHERE session_id=? ORDER BY id'
      ).all(sid)) || [];
      res.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="hermes-${sid}.md"`
      });
      return res.end(buildSessionMarkdown(sid, rows));
    });
  },
};
