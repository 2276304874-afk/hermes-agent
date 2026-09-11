'use strict';
/* =============================================================================
 * lib/auth.js —— Bearer token 认证
 *
 * 安全模型：
 *   1. 所有 /api/* 请求需 Bearer token（启动时生成/读取，存 ~/.hermes/ui_token，0600）。
 *   2. 令牌**不落日志**（launchd 捕获的日志是明文的），启动横幅只打印前 4 位便于核对。
 *   3. HERMES_TOKEN 环境变量可覆盖（测试用，如冒烟测试起独立实例）。
 * ========================================================================== */

const fs = require('fs');
const crypto = require('crypto');
const { TOKEN_FILE } = require('./config');

function loadToken() {
  if (process.env.HERMES_TOKEN) return process.env.HERMES_TOKEN;
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
      if (t) return t;
    }
  } catch {}
  const t = crypto.randomBytes(24).toString('hex');
  try { fs.writeFileSync(TOKEN_FILE, t, { mode: 0o600 }); } catch {}
  return t;
}

const TOKEN = loadToken();

function checkAuth(req) {
  const h = req.headers['authorization'] || '';
  return h.startsWith('Bearer ') && h.slice(7) === TOKEN;
}

module.exports = { TOKEN, TOKEN_FILE, loadToken, checkAuth };
