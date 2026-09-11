'use strict';
/* =============================================================================
 * lib/safety.js —— 会话级危险操作放行（共享模块）
 *
 * 为什么独立成文件：原先 approveSession 写在已否决的 lib/serve.js 里，等于
 * 「只有那条被弃路径才会写放行文件，生产读得到、没人写」。现在 gateway 后端
 * 需要它（常驻进程 env 固定，无法像 -z 那样注入 HERMES_UI_BYPASS_SAFETY=1），
 * 故抽到这里，供 chat 路由在 allowDangerous 时统一调用。
 *
 * 契约（与 hooks/safety_check.py 严格对齐）：
 *   - 放行文件：~/.hermes/ui_bypass_sessions.json，形状 { sessions: { [sessionId]: expirySec } }
 *   - 过期时间戳单位**秒**（hook 用 python time.time() 秒级比较）。
 *     写成毫秒会让过期时间变成公元 5 万年后 —— 放行永久生效，且过期清理永不触发。
 *   - 写失败 fail-closed：文件写不出 → 不抛、仅告警，高危命令仍会被 hook 拦。
 * ========================================================================== */

const fs = require('fs');
const { HOME } = require('./config');

const BYPASS_FILE = `${HOME}/.hermes/ui_bypass_sessions.json`;
// 用户点"允许危险操作"后重跑的那一轮足够用，不做长期免检。
// 默认 5 分钟（2026-09-11 由 15 收紧，F②）：一次批准只覆盖紧随其后的重跑轮，
// 缩短「批一次 → 一段时间内该会话任意危险命令全放行」的敞口窗口。HERMES_BYPASS_TTL_MIN 仍可覆盖。
const BYPASS_TTL_MIN = Number(process.env.HERMES_BYPASS_TTL_MIN || 5);
const BYPASS_TTL_MS = BYPASS_TTL_MIN * 60 * 1000;

const log = (...a) => console.log('[safety]', ...a);
const warn = (...a) => console.warn('[safety]', ...a);

/** 把某个会话标记为"用户已批准危险操作"。
 *  @param {string} storedId  DB 会话 id（-z 的 20260911_xxx 或 gateway 的 api-xxxx）
 *  @param {number} [ttlMs]   放行有效期（毫秒），默认 HERMES_BYPASS_TTL_MIN（默认 5 分钟）
 *  @returns {boolean} 是否写入成功（失败仅告警，hook 侧仍按未放行处理） */
function approveSession(storedId, ttlMs = BYPASS_TTL_MS) {
  if (!storedId) return false;
  try {
    let data = { sessions: {} };
    try { data = JSON.parse(fs.readFileSync(BYPASS_FILE, 'utf8')) || data; } catch { /* 首次写入 / 文件损坏 → 重建 */ }
    const nowSec = Math.floor(Date.now() / 1000);
    const sessions = {};
    // 顺手清掉过期条目，文件不会无限膨胀
    for (const [k, v] of Object.entries(data.sessions || {})) if (Number(v) > nowSec) sessions[k] = v;
    sessions[storedId] = nowSec + Math.round(ttlMs / 1000);
    fs.writeFileSync(BYPASS_FILE, JSON.stringify({ sessions }, null, 0), { mode: 0o600 });
    log(`会话 ${storedId} 已获危险操作放行，有效期 ${Math.round(ttlMs / 60000)} 分钟`);
    return true;
  } catch (e) {
    warn(`写入放行文件失败（高危命令仍会被拦截）：${e.message}`);
    return false;
  }
}

module.exports = { BYPASS_FILE, BYPASS_TTL_MS, BYPASS_TTL_MIN, approveSession };
