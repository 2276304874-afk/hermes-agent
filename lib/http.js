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

/* ---------- 响应写出护栏（P0-2 崩溃根因修复） ----------
 * 为什么必须有这两道检查：http.createServer 的兜底 catch 会在 handler 抛错后再调
 * sendJSON(res, 500)，但 handler 可能已经写出响应头（SSE 路径发起就是在第 41 行
 * writeHead 的），此时 writeHead 会抛 ERR_HTTP_HEADERS_SENT。这个二次异常会逃出
 * catch → 变成 unhandledRejection → 进程退出。已用最小实验证实该路径真实致命。
 *
 * 所以这里的原则：**写之前先看能不能写，绝不二次写头；写失败只记录、不抛出。**
 * 另：'error' 事件在 EventEmitter 上若无监听者即为致命 —— 见 server.js 的 res.on('error')。
 */
function sendJSON(res, code, obj) {
  if (res.headersSent || res.writableEnded) {
    // 走到这里说明「handler 先写了响应，随后又抛错，兜底 catch 想再写 500」。
    // 客户端已经拿到部分响应，无法再纠正，只能记一笔供排查。
    console.error(`[http] 丢弃 ${code} 响应：响应头已发出（handler 在写出响应之后才抛错？）`);
    return false;
  }
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
  return true;
}

/* SSE 写出：客户端断开或本轮已结束时静默丢弃。
 * 必要性：tailStreamFile 的回调是异步的（fs.stat → open → read），完全可能在客户端
 * 已断开、res 已 end 之后才触发。没有这道判断，回调里的写入就落在已结束的响应上；
 * 虽然 Node 22 对此是静默 no-op（实测），但依赖实现细节是脆的，显式判断更可靠。 */
function sse(res, event, data) {
  if (res.writableEnded || res.destroyed) return false;
  let body;
  try {
    body = JSON.stringify(data);
  } catch (e) {
    // 序列化失败（循环引用 / BigInt / getter 抛错）。这类错误属于**代码缺陷**，
    // 必须暴露到日志，但它是同步抛在请求路径上，直接冒泡会炸掉整轮 → 记录并跳过本帧。
    console.error('[http] SSE 序列化失败', event, e && (e.message || e));
    return false;
  }
  // 维持两句 write 的既有写出契约（单测按此断言，勿合并）：先 event 行再 data 行 + 空行。
  try {
    res.write(`event: ${event}\n`);
    res.write(`data: ${body}\n\n`);
    return true;
  } catch (e) {
    // 客户端已断开时 write 会抛 EPIPE / ERR_STREAM_DESTROYED。这是**正常终止**而非故障，
    // 既不记 ERROR 噪声也不再抛（再抛会经 uncaughtException 拖垮整轮），返回 false 让调用方知情。
    return false;
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const max = limit || BODY_LIMIT;
    let buf = '';
    let settled = false;
    const settle = (fn, v) => { if (!settled) { settled = true; fn(v); } };

    req.on('data', d => {
      buf += d;
      // 超限：pause 停止读取（保留 socket 让 server.js 的 catch 能把 413 写出去），
      // reject 带 statusCode=413 供兜底分支识别；响应 flush 完由 server.js 负责 destroy。
      // 旧写法当场 req.destroy() → 客户端只见 ConnectionReset，拿不到准确错误（实测复现）。
      if (buf.length > max) {
        const err = new Error('body too large');
        err.statusCode = 413;
        try { req.pause(); } catch { /* 已结束 */ }
        settle(reject, err);
      }
    });
    req.on('end', () => settle(resolve, buf));
    req.on('error', (e) => settle(reject, e));
    // 客户端中途断开：'aborted'（旧名）/ 'close'（新名）。
    // 不处理的话 Promise 永不 settle → handler 挂起 → 连接与它拉起的子进程都不释放。
    // settled 标志保证正常 'end' 之后的 'close' 不会把已 resolve 的结果改成 reject。
    req.on('aborted', () => settle(reject, new Error('client aborted')));
    req.on('close', () => settle(reject, new Error('client closed before body end')));
  });
}

/* ---------- 前端版本戳 ----------
 * 取 public/ 目录内所有文件的【最大 mtime】。
 *
 * 为什么是"全目录"而不是单个 index.html：前端 2026-09-11 拆成
 * index.html + app.css + app.js 三个文件后，只盯 index.html 的 mtime 会导致
 * 「改了 JS/CSS，页面却不提示刷新」—— 提示条机制静默失效，且症状不像故障。
 *
 * 返回：字符串（毫秒时间戳）或 null（目录不可读）。null 时调用方跳过替换，
 * 页面上的 `'__UI_VERSION__'` 占位符保持字面量，前端对比逻辑会自行跳过
 * （它显式排除了等于字面量 '__UI_VERSION__' 的情况）。
 */
function publicVersion() {
  let newest = 0;
  try {
    for (const name of fs.readdirSync(PUBLIC_DIR)) {
      try {
        const st = fs.statSync(path.join(PUBLIC_DIR, name));
        if (st.isFile() && st.mtimeMs > newest) newest = st.mtimeMs;
      } catch { /* 单个条目读不到不影响其余 */ }
    }
  } catch { /* 目录读不到 → 返回 null */ }
  return newest ? String(newest) : null;
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
    // 前端资源一律不缓存，保证改完刷新即生效（本地单用户，宁可靠性不省这点带宽）。
    // 为此把 .js/.css 也纳入 no-cache —— 前端拆分后它们变成独立请求，若沿用
    // max-age=300 会出现「index.html 是新的、app.js 还是旧缓存」的半新半旧状态，
    // 症状是点击无反应或报 null，且极难定位。
    const headers = { 'Content-Type': ct };
    if (ext === '.html' || ext === '.js' || ext === '.css') {
      headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
    } else {
      headers['Cache-Control'] = 'max-age=300';
    }
    let body = data;
    if (ext === '.html' && data.includes('__UI_VERSION__')) {
      // 版本戳 = public/ 目录内最大 mtime：老浏览器无视 no-store 缓存旧页面时，
      // 页面自身可对比 /api/health 的 uiVersion 弹"点击刷新"提示条
      try {
        const ver = publicVersion();
        if (ver) {
          // 只替换带引号的字符串字面量，避免误伤 window.__UI_VERSION__ 变量名
          let text = data.toString('utf8').split("'__UI_VERSION__'").join("'" + ver + "'");
          // 资源 URL 版本戳（__ASSET_VER__）：app.css/app.js 带 ?v=版本 加载。
          // Chromium 内存缓存在同标签页软刷新时会无视 no-store 复用资源——一旦
          // 某次刷新撞上文件写一半拿到截断 CSS，普通刷新永远复用坏缓存（键=URL 不变）。
          // 文件一改版本号就变 → URL 变 → 内存缓存必然失效（2026-09-13 实锤修法）。
          text = text.split('__ASSET_VER__').join(ver);
          body = Buffer.from(text);
        }
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
        // ⚠️ 只推进「已经解码」的字节数（曾是 offsetRef.pos = st.size）。
        // 写成 st.size 会把尾部那半个多字节序列一并跳过 —— 它永远不会再被读到，
        // 表现为流里偶尔丢字/乱码。现在把这些字节留给下一轮，与后续写入的续字节
        // 拼回完整字符。
        offsetRef.pos += end;
        if (text) onText(text);
      });
    });
  });
}

module.exports = { sendJSON, sse, readBody, serveStatic, tailStreamFile, publicVersion };
