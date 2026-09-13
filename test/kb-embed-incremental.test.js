'use strict';
/* =============================================================================
 * test/kb-embed-incremental.test.js —— ③ KB 向量索引「增量嵌入」的行为锁
 *
 * 为什么单独测这个：`embedTexts` 把整批文本塞进**一个** HTTP 请求（超时 120s）。
 * KB 有 ~1200 块，若指纹一变就全量重嵌，单次请求内会阻塞几十秒 ——
 * 而 recallContext 在**每个新会话**都跑，于是「KB 一变，下一次新会话首 token 被拖住」。
 * 实测症状：KB 内容变更后那一轮路由冒烟，`/api/kb/search` 与 `/api/kb` 双双 15s 超时失败。
 *
 * 故这里锁的是 planEmbed 的三条不变量：
 *   ① 内容未变的块必须复用（不重嵌）；
 *   ② 只有新块进 missing；
 *   ③ 新块与旧块的向量都要出现在 items 里（不能只给结果的一半）。
 * ========================================================================== */

const test = require('node:test');
const assert = require('node:assert');
const { _internal } = require('../lib/knowledge');

const { planEmbed, chunkHash, kbChunks } = _internal;

test('内容未变的块全部复用 → missing 为空（零模型调用）', () => {
  const chunks = [{ src: 'a', section: 's', text: '爱丽丝' }, { src: 'a', section: 's', text: '鲍勃' }];
  const byHash = { [chunkHash('爱丽丝')]: [1, 0], [chunkHash('鲍勃')]: [0, 1] };
  const { missing, items } = planEmbed(chunks, byHash);
  assert.deepStrictEqual(missing, []);
  assert.strictEqual(items.length, 2);
  assert.deepStrictEqual(items[0].vec, [1, 0]);
});

test('只有新块进 missing（KB 追加型增长的常态）', () => {
  const byHash = { [chunkHash('爱丽丝')]: [1, 0] };
  const chunks = [
    { src: 'a', section: 's', text: '爱丽丝' },
    { src: 'a', section: 's', text: '查理' },   // 新增
  ];
  const { missing, items } = planEmbed(chunks, byHash);
  assert.strictEqual(missing.length, 1, '只应嵌新增的 1 块');
  assert.strictEqual(missing[0].text, '查理');
  assert.ok(missing[0].hash, 'missing 元素须带 hash，供嵌入后回填');
  assert.strictEqual(items.length, 1, '已缓存的 1 块应直接进 items');
  assert.strictEqual(items[0].text, '爱丽丝');
});

test('空哈希表 → 全量进 missing（首次运行路径）', () => {
  const chunks = [{ src: 'a', section: 's', text: 'x' }, { src: 'a', section: 's', text: 'y' }];
  assert.strictEqual(planEmbed(chunks, {}).missing.length, 2);
  assert.strictEqual(planEmbed(chunks, null).missing.length, 2, 'null 表也要安全');
});

test('空向量的缓存条目视为缺失（不能拿空向量参与余弦）', () => {
  const byHash = { [chunkHash('爱丽丝')]: [] };   // 空向量 = 无效缓存
  const { missing, items } = planEmbed([{ src: 'a', section: 's', text: '爱丽丝' }], byHash);
  assert.strictEqual(missing.length, 1);
  assert.strictEqual(items.length, 0);
});

test('哈希按内容而非位置：相同内容的不同位置块共享缓存', () => {
  const byHash = { [chunkHash('重复')]: [0.5, 0.5] };
  const { missing, items } = planEmbed([
    { src: 'a', section: 's1', text: '重复' },
    { src: 'b', section: 's2', text: '重复' },
  ], byHash);
  assert.strictEqual(missing.length, 0);
  assert.strictEqual(items.length, 2, '两块都要出结果（各自保留自己的 src/section）');
  assert.strictEqual(items[1].section, 's2');
});

test('kbChunks：短条目单块、长条目按 400 字切并带 src/section', () => {
  const short = kbChunks([{ src: 'a', section: 's', text: '短' }]);
  assert.strictEqual(short.length, 1);
  const long = kbChunks([{ src: 'a', section: 's', text: 'x'.repeat(950) }]);
  assert.strictEqual(long.length, 3, '950 字 → 400/400/150 三块');
  assert.strictEqual(long[2].text.length, 150);
  assert.strictEqual(long[0].src, 'a');
  assert.strictEqual(long[0].section, 's');
});
