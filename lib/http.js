'use strict';
/* =============================================================================
 * lib/http.js —— HTTP 基元（响应写出 / 请求体读取 / 静态托管 / 流文件 tail）
 *
 * 这些是「与业务无关的搬运工」，拆出来之后路由模块只需关心语义，不再各自
 * 复制一份 sendJSON。行为与原 server.js 内联版本逐字一致。
 * ========================================================================== */

const fs = require('fs');
const path = require('path');
const { PUBLIC_DIR, BODY_LIMIT } = require('./config');

function sendJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function sse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const max = limit || BODY_LIMIT;
    let buf = '';
    req.on('data', d => {
      buf += d;
      if (buf.length > max) { req.destroy(); reject(new Error('body too large')); }
    });
    req.on('end', () => resolve(buf));
    req.on('error', reject);
  });
}

/* ---------- 静态文件（防路径穿越） ---------- */
function serveStatic(req, res) {
  const urlPath = (req.url.split('?')[0] === '/') ? '/index.html' : req.url.split('?')[0];
  const decoded = decodeURIComponent(urlPath);
  // 去掉前导 /，避免 path.resolve 把它当绝对路径（/ → 根目录）
  const relative = decoded.startsWith('/') ? decoded.slice(1) : decoded;
  // path.resolve 把 .. 折叠，再用 path.relative 确认结果仍在 PUBLIC_DIR 内
  const resolved = path.resolve(PUBLIC_DIR, relative);
  const rel = path.relative(PUBLIC_DIR, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  fs.readFile(resolved, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    const ext = path.extname(resolved).toLowerCase();
    const ct = ext === '.html' ? 'text/html; charset=utf-8'
      : ext === '.js' ? 'text/javascript; charset=utf-8'
      : ext === '.css' ? 'text/css; charset=utf-8'
      : ext === '.json' ? 'application/json; charset=utf-8'
      : ext === '.svg' ? 'image/svg+xml'
      : ext === '.png' ? 'image/png'
      : ext === '.ico' ? 'image/x-icon'
      : 'application/octet-stream';
    // HTML 不缓存，保证 UI 更新刷新即生效；静态资源短缓存
    const headers = { 'Content-Type': ct };
    if (ext === '.html') headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
    else headers['Cache-Control'] = 'max-age=300';
    let body = data;
    if (ext === '.html' && data.includes('__UI_VERSION__')) {
      // 版本戳 = index.html 的 mtime：老浏览器无视 no-store 缓存旧页面时，
      // 页面自身可对比 /api/health 的 uiVersion 弹"点击刷新"提示条
      try {
        const ver = String(fs.statSync(resolved).mtimeMs);
        // 只替换带引号的字符串字面量，避免误伤 window.__UI_VERSION__ 变量名
        body = Buffer.from(data.toString('utf8').split("'__UI_VERSION__'").join("'" + ver + "'"));
        headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
      } catch { /* 版本戳失败按原样返回 */ }
    }
    res.writeHead(200, headers);
    res.end(body);
  });
}

/* ---------- token 流 tail ----------
 * stream file 由 oneshot 补丁逐块追加。轮询 stat：文件增长 → 读出增量字节，
 * 以 SSE `token` 事件推送。读按 UTF-8 边界安全处理（丢弃尾部不完整多字节序列）。
 */
function tailStreamFile(file, offsetRef, onText) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return;
    if (st.size <= offsetRef.pos) return;
    fs.open(file, 'r', (err2, fd) => {
      if (err2) return;
      const len = st.size - offsetRef.pos;
      const buf = Buffer.alloc(len);
      fs.read(fd, buf, 0, len, offsetRef.pos, (err3) => {
        fs.close(fd, () => {});
        if (err3) return;
        offsetRef.pos = st.size;
        // 丢弃尾部不完整 UTF-8 多字节序列，避免半个汉字渲染成乱码
        let end = buf.length;
        const last = buf[buf.length - 1];
        if (last >= 0xC0) {
          end = buf.length - 1;
        } else if (last >= 0x80) {
          let i = buf.length - 1;
          while (i > 0 && (buf[i] & 0xC0) === 0x80) i--;
          const start = buf[i];
          const seqLen = start >= 0xF0 ? 4 : start >= 0xE0 ? 3 : start >= 0xC0 ? 2 : 1;
          if (buf.length - i < seqLen) end = i;
        }
        const text = buf.subarray(0, end).toString('utf8');
        if (text) onText(text);
      });
    });
  });
}

module.exports = { sendJSON, sse, readBody, serveStatic, tailStreamFile };
