'use strict';
/*
 * lib/chatstore.js —— 「对话模式」的轻量会话存储。
 *
 * 对话模式（侧栏 对话/工作 分段开关）不走 Hermes 引擎，因此不能用引擎的会话注册表
 * （`hermes sessions list`）与 state.db messages 表 —— 那套绑定 system prompt / 工具 /
 * 工作区，正是闲聊模式要甩掉的 prefill 大头。这里用独立 JSON 文件存对话模式自己的
 * 会话与消息，天然与工作模式的历史记录分开（侧栏按模式各显示各的）。
 *
 * 文件：~/.hermes/ui_chat_sessions.json（0600）。体积可控：对话消息天然短，
 * 且每次带给模型的只有最近 CHAT_HISTORY_MAX 条（全量仍落盘，便于回看）。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { HOME } = require('./config');

const STORE_FILE = path.join(HOME, '.hermes', 'ui_chat_sessions.json');
const ID_RE = /^chat_[0-9a-z_]{4,64}$/;
/* LRU 上限（2026-09-13 体检 P2）：JSON 是全量读改写，无上限会无限膨胀拖慢每次 append。
 * 超限从最旧一侧丢弃——会话按 updated、消息按顺序。 */
const MAX_SESSIONS = 50;
const MAX_MSGS = 200;

function load() {
  try {
    const obj = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    if (obj && Array.isArray(obj.sessions)) return obj;
  } catch (e) { /* 不存在/损坏 → 视为空库（与 workspace.js 同策略） */ }
  return { version: 1, sessions: [] };
}

function save(db) {
  const tmp = STORE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db), { mode: 0o600 });
  fs.renameSync(tmp, STORE_FILE);
}

function find(db, id) {
  return db.sessions.find(s => s.id === id) || null;
}

function create(title) {
  const db = load();
  const id = 'chat_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex');
  const s = { id, title: String(title || '新对话').slice(0, 80), created: Date.now(), updated: Date.now(), messages: [] };
  db.sessions.unshift(s);
  db.sessions.sort((a, b) => b.updated - a.updated);
  while (db.sessions.length > MAX_SESSIONS) db.sessions.pop();   // LRU：挤掉最久未活跃的会话
  save(db);
  return s;
}

function get(id) {
  if (!ID_RE.test(String(id || ''))) return null;
  return find(load(), id);
}

function appendMessage(id, role, content) {
  const db = load();
  const s = find(db, id);
  if (!s) return null;
  s.messages.push({ role, content: String(content || ''), ts: Date.now() });
  while (s.messages.length > MAX_MSGS) s.messages.shift();   // LRU：挤掉最旧消息
  s.updated = Date.now();
  // 首条用户消息即标题（与 gateway 侧"标题取自 prompt"同源；重复标题无碍——本存储不做唯一性约束）
  if (role === 'user' && !s.messages.slice(0, -1).some(m => m.role === 'user')) {
    s.title = String(content || s.title).trim().slice(0, 32) || s.title;
  }
  save(db);
  return s;
}

function list() {
  return load().sessions
    .map(s => ({ id: s.id, title: s.title, created: s.created, updated: s.updated, msgCount: s.messages.length }))
    .sort((a, b) => b.updated - a.updated);
}

function history(id) {
  const s = get(id);
  return s ? s.messages : null;
}

function rename(id, title) {
  const db = load();
  const s = find(db, id);
  if (!s) return false;
  s.title = String(title).slice(0, 80);
  save(db);
  return true;
}

function remove(id) {
  const db = load();
  const i = db.sessions.findIndex(s => s.id === id);
  if (i === -1) return false;
  db.sessions.splice(i, 1);
  save(db);
  return true;
}

module.exports = { STORE_FILE, ID_RE, create, get, appendMessage, list, history, rename, remove };
