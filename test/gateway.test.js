#!/usr/bin/env node
'use strict';
/* =============================================================================
 * test/gateway.test.js —— gateway 客户端纯函数单元测试（node:test，不打网络）
 *
 * 覆盖两块此前完全没有自动化断言、且出错时表现极其隐蔽的逻辑：
 *   A. SSE 帧解析（lib/gateway.js createSSEParser）
 *      - LF / CRLF / CR 三种行终结符
 *      - 一个 chunk 含多帧（粘包）
 *      - 一帧拆在两个 chunk（含 UTF-8 汉字被切成两半的极端情形）
 *      - 流尾没有空行收尾（残帧）
 *      - 多行 data、心跳注释、id/retry 头
 *   B. config.yaml 的 key 提取（extractKey / cleanScalar）
 *      - 裸值 / 双引号 / 单引号 / 行内注释
 *      - 不能误抓同文件里别的插件的 key
 *
 * 之所以单独成文件：这两块是 gateway 链路最底层，一旦回归，上层只有"UI 转圈"或
 * "401" 这类没有指向性的现象，排查成本极高。
 * ========================================================================== */

const test = require('node:test');
const assert = require('node:assert');
const { createSSEParser, MIN_KEY_LEN, _internal } = require('../lib/gateway');
const { extractKey, cleanScalar } = _internal;

/* ==================== A. SSE 解析器 ==================== */

/** 便捷：喂一串 chunk，返回全部帧 */
function run(chunks) {
  const p = createSSEParser();
  const frames = [];
  for (const c of chunks) frames.push(...p.push(c));
  frames.push(...p.flush());
  return frames;
}

test('SSE：单帧 LF', () => {
  const f = run(['event: assistant.delta\ndata: {"delta":"hi"}\n\n']);
  assert.strictEqual(f.length, 1);
  assert.deepStrictEqual(f[0], { name: 'assistant.delta', data: '{"delta":"hi"}' });
  assert.strictEqual(JSON.parse(f[0].data).delta, 'hi');
});

test('SSE：CRLF 必须同样能炸帧（只认 \\n 会整条流不吐帧）', () => {
  const f = run(['event: assistant.delta\r\ndata: {"delta":"hi"}\r\n\r\n']);
  assert.strictEqual(f.length, 1, 'CRLF 下应解析出 1 帧');
  assert.strictEqual(JSON.parse(f[0].data).delta, 'hi');
});

test('SSE：CR（老式行终结符）同样支持', () => {
  const f = run(['event: done\rdata: {}\r\r']);
  assert.strictEqual(f.length, 1);
  assert.strictEqual(f[0].name, 'done');
});

test('SSE：一个 chunk 含多帧（粘包）', () => {
  const f = run([
    'event: assistant.delta\ndata: {"delta":"a"}\n\n' +
    'event: assistant.delta\ndata: {"delta":"b"}\n\n' +
    'event: done\ndata: {}\n\n',
  ]);
  assert.deepStrictEqual(f.map(x => x.name), ['assistant.delta', 'assistant.delta', 'done']);
  assert.deepStrictEqual(f.slice(0, 2).map(x => JSON.parse(x.data).delta), ['a', 'b']);
});

test('SSE：一帧被拆成多个 chunk（切点落在多字节字符中间）', () => {
  const whole = 'event: assistant.delta\ndata: {"delta":"你好，赫尔墨斯"}\n\n';
  const bytes = Buffer.from(whole, 'utf8');
  // 找第一个 UTF-8 续字节（0b10xxxxxx）作为切点 —— 必然落在某个汉字内部
  let cut = -1;
  for (let i = 0; i < bytes.length; i++) {
    if ((bytes[i] & 0xc0) === 0x80) { cut = i; break; }
  }
  assert.ok(cut > 0, '测试前提：payload 必须含多字节字符');
  // 复刻 chatStream 的真实调用方式：必须用同一个 TextDecoder 且 stream:true，
  // 让它把落在边界上的悬空字节留到下一块。切忌 Buffer#toString('utf8')——
  // 那会把半个汉字解成 U+FFFD，是测试自身失真，不是解析器的错。
  const dec = new TextDecoder();
  const p = createSSEParser();
  const part1 = dec.decode(bytes.slice(0, cut), { stream: true });
  const part2 = dec.decode(bytes.slice(cut), { stream: true }) + dec.decode();
  assert.notStrictEqual(part1.length, 0, '测试前提：第一块非空');
  const a = p.push(part1);
  const frames = [...p.push(part2), ...p.flush()];
  assert.deepStrictEqual(a, [], '不完整的行不应提前炸帧');
  assert.strictEqual(frames.length, 1, '拼齐后应得到完整一帧');
  assert.strictEqual(JSON.parse(frames[0].data).delta, '你好，赫尔墨斯');
});

test('SSE：全角标点与 emoji 不被 trim / parse 破坏', () => {
  // JSON 里嵌引号必须写成 \\\"，否则 JSON.parse 会 SyntaxError（本用例就是在防这个回归）
  const payload = '{"delta":"你好，世界 🚀 — \\"引号\\" \\n 换行　全角空格"}';
  const f = run([`event: assistant.delta\ndata: ${payload}\n\n`]);
  assert.strictEqual(f.length, 1);
  const d = JSON.parse(f[0].data).delta;
  assert.strictEqual(d, '你好，世界 🚀 — "引号" \n 换行　全角空格');
});

test('SSE：多行 data 按 \\n 连接', () => {
  const f = run(['event: done\ndata: {"a":1,\ndata: "b":2}\n\n']);
  assert.strictEqual(f.length, 1);
  assert.deepStrictEqual(JSON.parse(f[0].data), { a: 1, b: 2 });
});

test('SSE：流尾残帧（无空行收尾）', () => {
  const f = run(['event: done\ndata: {"ok":true}']);
  assert.strictEqual(f.length, 1);
  assert.strictEqual(f[0].name, 'done');
  assert.strictEqual(JSON.parse(f[0].data).ok, true);
});

test('SSE：心跳注释与 id/retry 头不产生帧', () => {
  const f = run([': ping\nid: 42\nretry: 1000\n\n', 'event: done\ndata: {}\n\n']);
  assert.deepStrictEqual(f.map(x => x.name), ['done']);
});

test('SSE：坏 JSON 帧被跳过但不影响后续帧', () => {
  const f = run(['event: assistant.delta\ndata: {oops\n\n', 'event: done\ndata: {}\n\n']);
  // 解析器只负责吐帧；坏帧由调用侧 try/catch 跳过
  assert.strictEqual(f.length, 2);
  assert.strictEqual(f[0].name, 'assistant.delta');
  assert.strictEqual(f[1].name, 'done');
});

/* ==================== B. key 提取 ==================== */

const YAML_TPL = (keyLine) => `\
gateway:
  platforms:
    some_other:
      key: should-not-be-picked
    api_server:
      enabled: true
      extra:
        host: 127.0.0.1
        port: 8642
        ${keyLine}
`;

test('key：裸值', () => {
  assert.strictEqual(extractKey(YAML_TPL('key: abcdefghijklmnop')), 'abcdefghijklmnop');
});

test('key：双引号值', () => {
  assert.strictEqual(extractKey(YAML_TPL('key: "abcdefghijklmnop"')), 'abcdefghijklmnop');
});

test('key：单引号值', () => {
  assert.strictEqual(extractKey(YAML_TPL("key: 'abcdefghijklmnop'")), 'abcdefghijklmnop');
});

test('key：行内注释要剥掉', () => {
  assert.strictEqual(extractKey(YAML_TPL('key: abcdefghijklmnop   # 这是注释')), 'abcdefghijklmnop');
});

test('key：引号 + 引号外的行内注释', () => {
  assert.strictEqual(extractKey(YAML_TPL('key: "abcdefghijklmnop"  # 注释')), 'abcdefghijklmnop');
});

test('key：引号内带 # 不当作注释', () => {
  assert.strictEqual(extractKey(YAML_TPL('key: "abc#defghijklmnop"')), 'abc#defghijklmnop');
});

test('key：不误抓同文件里其它插件的 key', () => {
  const k = extractKey(YAML_TPL('key: abcdefghijklmnop'));
  assert.notStrictEqual(k, 'should-not-be-picked');
  assert.strictEqual(k, 'abcdefghijklmnop');
});

test('key：完全没有 key → 空串（不是 undefined）', () => {
  assert.strictEqual(extractKey('gateway:\n  platforms: {}\n'), '');
});

test('cleanScalar：去注释 / 去引号 / trim', () => {
  assert.strictEqual(cleanScalar('  abc  '), 'abc');
  assert.strictEqual(cleanScalar('"abc"'), 'abc');
  assert.strictEqual(cleanScalar("'abc'"), 'abc');
  assert.strictEqual(cleanScalar('abc # x'), 'abc');
  assert.strictEqual(cleanScalar('"a#b" # x'), 'a#b');
});

test('MIN_KEY_LEN 为 16（与 api_server 侧一致）', () => {
  assert.strictEqual(MIN_KEY_LEN, 16);
});
