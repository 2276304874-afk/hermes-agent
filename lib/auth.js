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
  } catch (e) {
    // P1-5 关键路径：读不到「已存在的」令牌文件会静默换发新令牌 → 浏览器里存的旧令牌
    // 全部失效，用户只看到 401 却不知道原因。必须说出来（本函数只在启动时跑一次，不刷屏）。
    console.warn(`[auth] 读取令牌文件失败（${TOKEN_FILE}）：${e.message} → 本次换发新令牌，浏览器需重新输入`);
  }
  const t = crypto.randomBytes(24).toString('hex');
  try { fs.writeFileSync(TOKEN_FILE, t, { mode: 0o600 }); }
  catch (e) {
    // 写不进去 = 令牌不持久，重启即换（每次都要重输）。不致命，但必须可见。
    console.warn(`[auth] 写入令牌文件失败（${TOKEN_FILE}）：${e.message} → 令牌不会持久化`);
  }
  return t;
}

const TOKEN = loadToken();

function checkAuth(req) {
  const h = req.headers['authorization'] || '';
  return h.startsWith('Bearer ') && h.slice(7) === TOKEN;
}

module.exports = { TOKEN, TOKEN_FILE, loadToken, checkAuth };
