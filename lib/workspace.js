'use strict';
/*
 * lib/workspace.js —— dsh 式「工作区」元数据存储
 *
 * 设计决策：会话归属（sessionId → workspace）是 UI 层元数据，不写 hermes 的
 * state.db（那是 Hermes CLI 的领地，写它有耦合风险）。独立 JSON 文件存储，
 * 每次读写整个文件（量级：≤24 工作区 × 会话映射，几 KB），原子写（tmp+rename）。
 *
 * 与 lib/safety.js 同款纪律：文件缺失/损坏 → 回落默认值，绝不抛异常打断主链路。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const WS_FILE = process.env.HERMES_UI_WORKSPACES_FILE
  || path.join(os.homedir(), '.hermes', 'ui_workspaces.json');
const MAX_WORKSPACES = 24;
const NAME_MAX = 40;

function emptyStore() { return { workspaces: ['默认'], assignments: {} }; }

function loadStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(WS_FILE, 'utf8'));
    const workspaces = Array.isArray(raw.workspaces)
      ? [...new Set(raw.workspaces.filter(w => typeof w === 'string' && w.trim()).map(w => w.trim().slice(0, NAME_MAX)))]
      : [];
    const assignments = {};
    if (raw.assignments && typeof raw.assignments === 'object' && !Array.isArray(raw.assignments)) {
      for (const [k, v] of Object.entries(raw.assignments)) {
        if (typeof k === 'string' && k && typeof v === 'string' && v) assignments[k] = v.slice(0, NAME_MAX);
      }
    }
    return { workspaces: workspaces.length ? workspaces : emptyStore().workspaces, assignments };
  } catch {
    return emptyStore();   // 不存在/损坏 → 默认。绝不因元数据挂掉聊天主链路
  }
}

function saveStore(store) {
  const tmp = WS_FILE + '.tmp';
  fs.mkdirSync(path.dirname(WS_FILE), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, WS_FILE);
  try { fs.chmodSync(WS_FILE, 0o600); } catch { /* 权限加固尽力而为 */ }
}

function list() {
  const s = loadStore();
  return { workspaces: s.workspaces, assignments: s.assignments };
}

function create(name) {
  const n = String(name || '').trim().slice(0, NAME_MAX);
  if (!n) return { error: '工作区名称需 1-40 字符' };
  const s = loadStore();
  if (s.workspaces.includes(n)) return { ok: true, workspaces: s.workspaces, existed: true };
  if (s.workspaces.length >= MAX_WORKSPACES) return { error: `最多 ${MAX_WORKSPACES} 个工作区` };
  s.workspaces.push(n);
  saveStore(s);
  return { ok: true, workspaces: s.workspaces };
}

/**
 * 重命名工作区，并把归属整体迁移到新名下。
 *
 * 为什么单独要有它（而不是"删除再新建"）：删除会连带清掉 assignments 里该工作区的
 * 全部归属记录（见 remove 的 `for ... delete`），会话就此散落回「未归类」。
 * 「默认」禁止改名：它在 emptyStore() 与 remove() 里被当作硬编码锚点，
 * 改掉之后新装/文件损坏时的回落就会指向一个不存在的名字。
 *
 * 不允许改成已存在的名字：两个工作区同名会让 assignFilter 同时命中两者，
 * 看着像重命名成功、实则悄悄把两个分区合并了——静默丢信息的合并必须禁止。
 */
function rename(oldName, newName) {
  const from = String(oldName || '').trim();
  const to = String(newName || '').trim().slice(0, NAME_MAX);
  if (!from) return { error: '缺少原名称' };
  if (!to) return { error: '新名称需 1-40 字符' };
  if (from === '默认') return { error: '默认工作区不可重命名' };
  const s = loadStore();
  const i = s.workspaces.indexOf(from);
  if (i === -1) return { error: '工作区不存在' };
  if (to !== from && s.workspaces.includes(to)) return { error: `已存在同名工作区：${to}` };
  if (to === from) return { ok: true, workspaces: s.workspaces, assignments: s.assignments, unchanged: true };

  s.workspaces[i] = to;                                     // 保持原有顺序，不让 chips 跳位
  let moved = 0;
  for (const k of Object.keys(s.assignments)) {
    if (s.assignments[k] === from) { s.assignments[k] = to; moved++; }
  }
  saveStore(s);
  return { ok: true, workspaces: s.workspaces, assignments: s.assignments, moved };
}

/**
 * 删除工作区并清理其全部归属。默认区禁止删——它是回落锚点（同上）。
 */
function remove(name) {
  const n = String(name || '').trim();
  if (!n) return { error: 'name required' };
  if (n === '默认') return { error: '默认工作区不可删除' };
  const s = loadStore();
  const i = s.workspaces.indexOf(n);
  if (i === -1) return { error: '工作区不存在' };
  s.workspaces.splice(i, 1);
  for (const k of Object.keys(s.assignments)) if (s.assignments[k] === n) delete s.assignments[k];
  saveStore(s);
  return { ok: true, workspaces: s.workspaces };
}

function assign(sessionId, ws) {
  const s = loadStore();
  if (ws) {
    if (!s.workspaces.includes(ws)) return { error: '工作区不存在' };
    s.assignments[sessionId] = ws;
  } else {
    delete s.assignments[sessionId];
  }
  saveStore(s);
  return { ok: true };
}

/* chat 链路用：仅当会话尚无归属时写入（首轮建会话时归类），不覆盖已有归属 */
function assignIfNew(sessionId, ws) {
  if (!sessionId || !ws) return false;
  const s = loadStore();
  if (s.assignments[sessionId]) return false;
  if (!s.workspaces.includes(ws)) return false;
  s.assignments[sessionId] = ws;
  saveStore(s);
  return true;
}

/* 会话删除时清理归属（孤儿映射防膨胀） */
function removeSession(sessionId) {
  if (!sessionId) return;
  const s = loadStore();
  if (s.assignments[sessionId] === undefined) return;
  delete s.assignments[sessionId];
  saveStore(s);
}

module.exports = { list, create, remove, rename, assign, assignIfNew, removeSession, WS_FILE };
