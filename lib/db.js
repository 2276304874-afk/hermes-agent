'use strict';
/* =============================================================================
 * lib/db.js —— Hermes state.db 只读访问（长连接 + WAL）
 *
 * 为什么是只读长连接：本服务只观测 Hermes 写下的消息，绝不写它的库。
 * 轮询周期 POLL_MS（150ms）下频繁 open/close 代价高，故复用单例连接。
 * 单次查询失败不致命——withDB 返回 null，调用方退化处理（SSE 那一轮就跳过）。
 * ========================================================================== */

const { DB_PATH } = require('./config');

let db = null;
function getDB() {
  if (db) return db;
  const { DatabaseSync } = require('node:sqlite');
  db = new DatabaseSync(DB_PATH, { readonly: true });
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

function withDB(fn) {
  try { return fn(getDB()); } catch (e) { /* 单次查询失败不致命 */ return null; }
}

function latestSessionId() {
  return withDB(d => { const r = d.prepare('SELECT id FROM sessions ORDER BY id DESC LIMIT 1').get(); return r ? r.id : null; });
}

function maxMessageId(sid) {
  return withDB(d => { const r = d.prepare('SELECT max(id) AS m FROM messages WHERE session_id=?').get(sid); return r && r.m ? r.m : 0; }) || 0;
}

function newMessages(sid, afterId) {
  return withDB(d => d.prepare(
    'SELECT id, role, tool_name, content, tool_calls, display_kind, reasoning, timestamp FROM messages WHERE session_id=? AND id>? ORDER BY id'
  ).all(sid, afterId)) || [];
}

/* ---------- L4: 由 state.db 消息直接生成会话 Markdown ----------
 * 不依赖 `hermes export` 的文件落盘行为（那个行为随版本变过）。 */
function buildSessionMarkdown(sid, rows) {
  const lines = [`# Hermes 会话 ${sid}`, '', `> 导出时间：${new Date().toLocaleString()}`, ''];
  for (const r of rows) {
    if (r.role === 'user') {
      lines.push('## 👤 用户', '', String(r.content || '').trim(), '');
    } else if (r.role === 'assistant') {
      if (r.tool_calls) {
        try {
          const calls = JSON.parse(r.tool_calls);
          for (const c of (Array.isArray(calls) ? calls : [calls])) {
            const f = c.function || c;
            const name = f.name || 'tool';
            let args = f.arguments;
            if (typeof args === 'string') { try { args = JSON.parse(args); } catch {} }
            const cmd = (args && (args.command || args.path || args.file_path)) || '';
            lines.push(`### 🔧 工具调用：${name}`, '', '```', String(cmd || JSON.stringify(args)), '```', '');
          }
        } catch {}
      }
      if (r.content && String(r.content).trim()) lines.push('## 🤖 助手', '', String(r.content).trim(), '');
    } else if (r.role === 'tool') {
      let out = r.content || '';
      try {
        const c = JSON.parse(out);
        out = c.output != null ? String(c.output) : (c.error ? '错误: ' + c.error : JSON.stringify(c, null, 1));
      } catch {}
      lines.push('<details><summary>工具结果</summary>', '', '```', String(out).slice(0, 4000), '```', '', '</details>', '');
    }
  }
  return lines.join('\n');
}

module.exports = { getDB, withDB, latestSessionId, maxMessageId, newMessages, buildSessionMarkdown };
