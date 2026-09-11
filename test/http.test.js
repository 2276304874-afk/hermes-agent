'use strict';
/* =============================================================================
 * test/http.test.js —— lib/http.js 的崩溃防护与流式正确性回归网（P0-2）
 *
 * 这组用例锁定的都是「实测确认真实可达」的致命路径，以及本次修掉的流式缺陷。
 * 它们一旦回归，现象是「服务在某个请求上直接消失，日志里只剩一行丢弃响应」——
 * 属于最难排查的一类故障，所以必须由测试守住，而不是靠人记得。
 *
 * mock 的 writeHead / write 故意在误用时【抛错】（复刻 Node 的
 * ERR_HTTP_HEADERS_SENT / ERR_STREAM_WRITE_AFTER_END）——这样「护栏生效」
 * 才是可证伪的：如果哪天有人删掉 sendJSON 里的前置检查，用例立刻红。
 * ========================================================================== */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const { sendJSON, sse, readBody, serveStatic, tailStreamFile, publicVersion } = require('../lib/http');

/* ---------- mock：误用即抛错 ---------- */
function mockRes(state = {}) {
  const calls = [];
  let headersSent = !!state.headersSent;
  let writableEnded = !!state.writableEnded;
  const res = {
    destroyed: !!state.destroyed,
    get headersSent() { return headersSent; },
    get writableEnded() { return writableEnded; },
    writeHead(code, headers) {
      if (headersSent) throw Object.assign(new Error('writeHead after headers sent'), { code: 'ERR_HTTP_HEADERS_SENT' });
      headersSent = true; calls.push(['writeHead', code, headers]); return this;
    },
    // 允许注入自定义 write —— 用于模拟「socket 已断、write 抛 EPIPE」等崩溃场景
    write: state.write || function (s) {
      if (writableEnded) throw Object.assign(new Error('write after end'), { code: 'ERR_STREAM_WRITE_AFTER_END' });
      calls.push(['write', s]); return true;
    },
    end(s) { writableEnded = true; calls.push(['end', s]); return this; },
  };
  return { res, calls };
}

/* 静默 console.error 并把它收到的内容交回 —— 顺带断言「确实记了日志」，
 * 因为 P0-2 的另一半问题就是 handler 异常此前完全静默、零排查线索。 */
function captureStderr(fn) {
  const orig = console.error;
  const lines = [];
  console.error = (...a) => lines.push(a.map(x => (x && x.message) || String(x)).join(' '));
  try { const result = fn(); return { result, lines }; } finally { console.error = orig; }
}

function mockReq() {
  const req = new EventEmitter();
  req.destroyed = false;
  req.destroy = () => { req.destroyed = true; };
  return req;
}

/* 用于异步写出（serveStatic）的响应捕获 */
function captureRes() {
  let resolveDone;
  const done = new Promise(r => { resolveDone = r; });
  const state = { calls: [], headersSent: false, writableEnded: false };
  const res = {
    get headersSent() { return state.headersSent; },
    get writableEnded() { return state.writableEnded; },
    writeHead(code, headers) { state.headersSent = true; state.calls.push(['writeHead', code, headers]); return this; },
    end(body) {
      state.writableEnded = true;
      state.calls.push(['end', body]);
      const h = state.calls.find(c => c[0] === 'writeHead');
      resolveDone({ code: h ? h[1] : null, headers: h ? h[2] : {}, body });
    },
  };
  return { res, done };
}

/* ============================ sendJSON ============================ */

test('sendJSON：正常路径写头 + 结束', () => {
  const { res, calls } = mockRes();
  assert.strictEqual(sendJSON(res, 200, { a: 1 }), true);
  assert.deepStrictEqual(calls, [
    ['writeHead', 200, { 'Content-Type': 'application/json; charset=utf-8' }],
    ['end', '{"a":1}'],
  ]);
});

test('sendJSON：响应头已发出时不得二次写头（P0-2 崩溃根因）', () => {
  const { res, calls } = mockRes({ headersSent: true });
  const { result, lines } = captureStderr(() => sendJSON(res, 500, { error: 'x' }));
  // 旧代码在这里抛 ERR_HTTP_HEADERS_SENT，二次异常逃出 server.js 的 catch →
  // unhandledRejection → 进程退出。现在必须静默丢弃并留痕。
  assert.strictEqual(result, false);
  assert.strictEqual(calls.length, 0, '不应产生任何写入');
  assert.strictEqual(lines.length, 1, '应记录一行日志（不能再静默）');
  assert.match(lines[0], /丢弃 500 响应/);
});

test('sendJSON：响应已结束时同样丢弃而不是抛错', () => {
  const { res, calls } = mockRes({ writableEnded: true });
  const { result, lines } = captureStderr(() => sendJSON(res, 500, { error: 'x' }));
  assert.strictEqual(result, false);
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(lines.length, 1);
});

/* ============================ sse ============================ */

test('sse：产出合法的 event/data 分帧', () => {
  const { res, calls } = mockRes();
  assert.strictEqual(sse(res, 'token', { text: '中' }), true);
  assert.deepStrictEqual(calls, [
    ['write', 'event: token\n'],
    ['write', 'data: {"text":"中"}\n\n'],
  ]);
});

test('sse：数据里的换行被转义，不会破坏分帧', () => {
  const { res, calls } = mockRes();
  sse(res, 'token', { text: 'a\nb' });
  // JSON.stringify 会把 \n 变成 \\n —— 否则一行 data 会被拆成两行，SSE 解析错乱
  assert.strictEqual(calls[1][1], 'data: {"text":"a\\nb"}\n\n');
});

/* ---- 崩溃防护：sse 处在「客户端半途断开」的第一线。
 *      它是在异步回调里被调用的（tail 轮询 / 工具事件），一旦抛错就会变成
 *      unhandledRejection → 历史上 P0-2 正是这条链路把整个服务拖崩。 ---- */
test('sse：socket 已断导致 write 抛错 → 返回 false，绝不外抛', () => {
  const boom = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
  const { res } = mockRes({
    write: () => { throw boom; },
  });
  assert.strictEqual(sse(res, 'token', { text: 'x' }), false, '断连必须表现为 false，而非异常');
});

test('sse：序列化失败（循环引用）→ 返回 false，绝不外抛', () => {
  const { res, calls } = mockRes();
  const cyclic = {};
  cyclic.self = cyclic;                       // JSON.stringify 会抛 TypeError
  assert.strictEqual(sse(res, 'token', { bad: cyclic }), false);
  assert.strictEqual(calls.length, 0, '序列化失败不得产生任何半截写入');
});

test('sse：响应已结束 → 丢弃，零写入（异步 tail 回调晚到的场景）', () => {
  const { res, calls } = mockRes({ writableEnded: true });
  assert.strictEqual(sse(res, 'token', { text: 'x' }), false);
  assert.strictEqual(calls.length, 0);
});

test('sse：连接已销毁 → 丢弃，零写入', () => {
  const { res, calls } = mockRes({ destroyed: true });
  assert.strictEqual(sse(res, 'token', { text: 'x' }), false);
  assert.strictEqual(calls.length, 0);
});

/* ============================ readBody ============================ */

test('readBody：正常收完返回原文', async () => {
  const req = mockReq();
  const p = readBody(req);
  req.emit('data', '{"a":');
  req.emit('data', '1}');
  req.emit('end');
  assert.strictEqual(await p, '{"a":1}');
});

test('readBody：超出上限 → 拒绝，且错误信息准确指向超限', async () => {
  const req = mockReq();
  const p = readBody(req, 8);
  req.emit('data', 'x'.repeat(20));
  await assert.rejects(p, /body too large/);
  assert.strictEqual(req.destroyed, true, '超限应销毁请求，停止继续收数据');
});

test('readBody：客户端中途断开 → 拒绝（而不是永久挂起）', async () => {
  const req = mockReq();
  const p = readBody(req);
  req.emit('data', '{');
  req.emit('aborted');
  // 旧实现只监听 data/end/error，客户端 abort 时 Promise 永不 settle →
  // handler 挂起 → 连接与它拉起的子进程都不释放。
  await assert.rejects(p, /client aborted/);
});

test('readBody：正常 end 之后再来的 close 不得把已成功的结果改成失败', async () => {
  const req = mockReq();
  const p = readBody(req);
  req.emit('data', 'ok');
  req.emit('end');
  req.emit('close');   // Node 在正常结束之后也会补一个 close
  assert.strictEqual(await p, 'ok');
});

test('readBody：请求流错误 → 拒绝并带出原因', async () => {
  const req = mockReq();
  const p = readBody(req);
  req.emit('error', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
  await assert.rejects(p, /socket hang up/);
});

/* ============================ serveStatic ============================ */

test('serveStatic：拒绝路径穿越', async () => {
  const { res, done } = captureRes();
  serveStatic({ url: '/../server.js', method: 'GET' }, res);
  assert.strictEqual((await done).code, 403);
});

test('serveStatic：文件不存在 → 404', async () => {
  const { res, done } = captureRes();
  serveStatic({ url: '/no-such-file-xyz.txt', method: 'GET' }, res);
  assert.strictEqual((await done).code, 404);
});

test('serveStatic：index.html 注入真实版本戳（占位符不留存）', async () => {
  const { res, done } = captureRes();
  serveStatic({ url: '/', method: 'GET' }, res);
  const r = await done;
  assert.strictEqual(r.code, 200);
  const body = Buffer.isBuffer(r.body) ? r.body.toString('utf8') : String(r.body);
  assert.ok(!body.includes("'__UI_VERSION__'"), '占位符应已被替换成真实 mtime');
  assert.match(body, /window\.__UI_VERSION__ = '\d+\.?\d*'/);
  assert.match(r.headers['Cache-Control'], /no-cache/);
});

test('serveStatic：.js 发 no-cache + 正确 MIME（防半新半旧缓存）', async () => {
  const { res, done } = captureRes();
  serveStatic({ url: '/app.js', method: 'GET' }, res);
  const r = await done;
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.headers['Content-Type'], 'text/javascript; charset=utf-8');
  // 前端拆分后 .js 若沿用 max-age 会出现「新 HTML + 旧 JS」，症状是点击无反应
  assert.match(r.headers['Cache-Control'], /no-cache/);
});

test('publicVersion：返回数字字符串（供前端比对）', () => {
  const v = publicVersion();
  assert.strictEqual(typeof v, 'string');
  assert.match(v, /^\d+\.?\d*$/);
});

/* ============================ tailStreamFile ============================ */

test('tailStreamFile：文件不存在 → 不回调也不抛错', async () => {
  let called = false;
  tailStreamFile('/no/such/hermes-stream.txt', { pos: 0 }, () => { called = true; });
  await new Promise(r => setTimeout(r, 60));
  assert.strictEqual(called, false);
});

test('tailStreamFile：只读增量，不重复吐已读内容', async () => {
  const f = path.join(os.tmpdir(), `hermes-tail-inc-${process.pid}.txt`);
  fs.writeFileSync(f, 'abc');
  const offset = { pos: 0 };
  let got = '';
  const once = () => new Promise(r => { tailStreamFile(f, offset, t => { got += t; }); setTimeout(r, 60); });
  await once();
  assert.strictEqual(got, 'abc');
  fs.appendFileSync(f, 'de');
  await once();
  assert.strictEqual(got, 'abcde');
  await once();
  assert.strictEqual(got, 'abcde', '无新增时不应重复输出');
  fs.unlinkSync(f);
});

test('tailStreamFile：尾部半个多字节序列不丢字符', async () => {
  const f = path.join(os.tmpdir(), `hermes-tail-utf8-${process.pid}.txt`);
  const ch = '中';                              // 3 字节：E4 B8 AD
  const buf = Buffer.from(ch, 'utf8');
  fs.writeFileSync(f, buf.subarray(0, 2));      // 先只落前 2 字节（模拟写到一半被读到）
  const offset = { pos: 0 };
  let got = '';
  const once = () => new Promise(r => { tailStreamFile(f, offset, t => { got += t; }); setTimeout(r, 60); });

  await once();
  assert.strictEqual(got, '', '不完整序列不应产出文本');
  // 关键：偏移不能推进到文件末尾。旧实现写 offsetRef.pos = st.size，
  // 这 2 个字节就被永久跳过，字符从此丢失。
  assert.strictEqual(offset.pos, 0, '未解码的字节不得推进偏移');

  fs.appendFileSync(f, buf.subarray(2));        // 补齐续字节
  await once();
  assert.strictEqual(got, ch, '补齐后应拼回完整字符');
  fs.unlinkSync(f);
});
