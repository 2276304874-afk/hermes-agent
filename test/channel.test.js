'use strict';
/* =============================================================================
 * test/channel.test.js —— 渠道适配抽象层（阶段 0）的契约锁
 *
 * 这个模块**没有接任何真实渠道**，所以它的价值全在「契约本身对不对」：
 *   A) 安全闸门必须真的拦得住 —— 网页钩子式(push)适配器、缺闸门、想放宽危险操作的，
 *      必须在**注册那一刻**就被拒，而不是等到线上出事；
 *   B) 三职责门面（normalizeInbound/renderOutbound/verifyAuth）形状正确；
 *   C) 参考适配器 webAdapter 真的符合本契约（否则模板本身就是错的）。
 * ========================================================================== */

const test = require('node:test');
const assert = require('node:assert');
const ch = require('../lib/channel');

function goodAdapter(over = {}) {
  return {
    id: 'demo',
    label: '演示渠道',
    inbound: 'pull',
    gates: Object.fromEntries(ch.REQUIRED_GATES.map((g) => [g, true])),
    normalizeInbound: () => ({ channel: 'demo', senderId: 'u1', text: 'hi' }),
    renderOutbound: () => ({ to: 'u1', text: 'ok' }),
    verifyAuth: () => true,
    ...over,
  };
}

/* ---------- A. 安全闸门 ---------- */

test('拒绝 webhook/push 式适配器（ClawJacked 病根：要开入站端口）', () => {
  assert.throws(
    () => ch.assertAdapter(goodAdapter({ inbound: 'push' })),
    /inbound 必须是 'pull'/,
  );
  assert.throws(
    () => ch.assertAdapter(goodAdapter({ inbound: undefined })),
    /inbound 必须是 'pull'/,
  );
});

test('拒绝声明 mayGrantDangerous:true 的适配器（危险操作只能由本机 UI 授予）', () => {
  assert.throws(
    () => ch.assertAdapter(goodAdapter({ mayGrantDangerous: true })),
    /mayGrantDangerous/,
  );
});

test('缺任一必需闸门都要被拒，且错误里点名是哪一个', () => {
  for (const g of ch.REQUIRED_GATES) {
    const gates = { ...goodAdapter().gates };
    delete gates[g];
    assert.throws(
      () => ch.assertAdapter(goodAdapter({ gates })),
      new RegExp(g),
      `缺闸门 ${g} 时应当报错并点名`,
    );
  }
});

test('缺三职责任一方法都要被拒', () => {
  for (const fn of ['normalizeInbound', 'renderOutbound', 'verifyAuth']) {
    const a = goodAdapter();
    delete a[fn];
    assert.throws(() => ch.assertAdapter(a), new RegExp(fn));
  }
});

test('缺 id / 非对象 → 被拒', () => {
  assert.throws(() => ch.assertAdapter(null), /必须是对象/);
  assert.throws(() => ch.assertAdapter(goodAdapter({ id: '   ' })), /缺少非空 id/);
});

/* ---------- B. 门面与注册表 ---------- */

test('注册后可用 id 解析，且 id 必须唯一', () => {
  ch._clearAdaptersForTest();
  ch.registerAdapter(goodAdapter());
  assert.strictEqual(ch.getAdapter('demo').label, '演示渠道');
  assert.throws(() => ch.registerAdapter(goodAdapter()), /已注册/);
  assert.throws(() => ch.getAdapter('nope'), /未注册的渠道/);
  ch._clearAdaptersForTest();
});

test('门面 normalizeInbound 会把结果规整成统一 MsgContext 形状', async () => {
  ch._clearAdaptersForTest();
  ch.registerAdapter(goodAdapter());
  const ctx = await ch.normalizeInbound('demo', { any: 'payload' });
  assert.deepStrictEqual(Object.keys(ctx).sort(), [
    'attachments', 'channel', 'raw', 'receivedAt', 'senderId', 'text', 'threadId',
  ]);
  assert.strictEqual(ctx.channel, 'demo');
  assert.strictEqual(ctx.text, 'hi');
  assert.deepStrictEqual(ctx.attachments, []);
  assert.ok(ctx.receivedAt > 0);
  ch._clearAdaptersForTest();
});

test('门面 renderOutbound 规整入参（缺失字段不炸，给默认值）', async () => {
  ch._clearAdaptersForTest();
  ch.registerAdapter(goodAdapter({
    renderOutbound: (out) => ({ echo: out.text, n: out.attachments.length, replyTo: out.replyTo }),
  }));
  const out = await ch.renderOutbound('demo', {});
  assert.deepStrictEqual(out, { echo: '', n: 0, replyTo: null });
  ch._clearAdaptersForTest();
});

test('门面 verifyAuth 归一化成布尔', async () => {
  ch._clearAdaptersForTest();
  ch.registerAdapter(goodAdapter({ verifyAuth: () => 1 }));
  assert.strictEqual(await ch.verifyAuth('demo', {}), true);
  ch._clearAdaptersForTest();
});

/* ---------- C. 参考适配器自身必须合规 ---------- */

test('webAdapter 符合本契约，且不越权放行危险操作', () => {
  assert.doesNotThrow(() => ch.assertAdapter(ch.webAdapter));
  assert.strictEqual(ch.webAdapter.inbound, 'pull');
  assert.strictEqual(ch.webAdapter.mayGrantDangerous, false);
});

test('webAdapter：/api/chat body → MsgContext → SSE 帧 可往返', async () => {
  const ctx = await ch.webAdapter.normalizeInbound({ prompt: '你好', sessionId: 'api_x' });
  assert.strictEqual(ctx.channel, 'web');
  assert.strictEqual(ctx.text, '你好');
  assert.strictEqual(ctx.threadId, 'api_x');

  const frame = await ch.webAdapter.renderOutbound(ch.makeOutbound({ text: '在的' }));
  assert.strictEqual(frame.event, 'token');
  assert.strictEqual(frame.data.text, '在的');
});

test('webAdapter：Bearer 头形状判定（无头/非 Bearer 一律 false）', () => {
  assert.strictEqual(ch.webAdapter.verifyAuth({ headers: { authorization: 'Bearer abc' } }), true);
  assert.strictEqual(ch.webAdapter.verifyAuth({ headers: {} }), false);
  assert.strictEqual(ch.webAdapter.verifyAuth({ headers: { authorization: 'Token abc' } }), false);
  assert.strictEqual(ch.webAdapter.verifyAuth({}), false);
});
