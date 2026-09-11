'use strict';
/* =============================================================================
 * test/cloud.test.js —— 从 server.js 拆出的纯函数用例（P1-3 第三步配套）
 *
 * 为什么补这一层：resolveModel / maskKey 原本埋在 server.js 中段，只有跑起服务
 * 才碰得到；拆进 lib/cloud.js 后成了零副作用纯函数，可以被直接断言。
 *
 * 最值钱的两条是**回退语义**：
 *   - 未知本地模型名 → 必须回落到 DEFAULT_MODEL（否则前端传幽灵模型名就报错）
 *   - 不完整的 cloud: 串 → 必须回落本地（否则会拿空 model 去请求云端）
 * 这两条一旦回归，表现是"下拉选某模型就失败"，很难从日志看出根因。
 * ========================================================================== */

const test = require('node:test');
const assert = require('node:assert');
const { resolveModel, maskKey, PROVIDER_PRESETS } = require('../lib/cloud');
const { DEFAULT_MODEL, LOCAL_MODELS } = require('../lib/config');

test('resolveModel: 白名单内的本地模型原样返回', () => {
  for (const m of LOCAL_MODELS) {
    assert.deepStrictEqual(resolveModel(m), { cloud: false, model: m });
  }
});

test('resolveModel: 未知/空白本地模型名回落到默认模型', () => {
  for (const bad of ['', null, undefined, 'ghost-model', 'qwen2.5:7b', 'hermes-local']) {
    assert.deepStrictEqual(resolveModel(bad), { cloud: false, model: DEFAULT_MODEL },
      `输入 ${JSON.stringify(bad)} 应回落 ${DEFAULT_MODEL}`);
  }
});

test('resolveModel: 合法的 cloud: 串被拆成 providerId + model', () => {
  const r = resolveModel('cloud:deepseek/deepseek-chat');
  assert.deepStrictEqual(r, { cloud: true, providerId: 'deepseek', model: 'deepseek-chat' });
});

test('resolveModel: 含斜杠的云端模型名不被截断', () => {
  // 只切第一个 '/'，模型名里的分隔符要保留（如 vendor/model 形式）
  const r = resolveModel('cloud:openai-api/vendor/model-x');
  assert.strictEqual(r.providerId, 'openai-api');
  assert.strictEqual(r.model, 'vendor/model-x');
});

test('resolveModel: 不合法的 cloud: 串回落本地（不拿空 model 去请求云端）', () => {
  const bad = [
    'cloud:',                    // 无 provider
    'cloud:deepseek',            // 无斜杠
    'cloud:deepseek/',           // 空模型名
    'cloud:/deepseek-chat',      // 空 providerId
    'cloud:unknown-provider/x',  // provider 不在预设表里
  ];
  for (const b of bad) {
    assert.deepStrictEqual(resolveModel(b), { cloud: false, model: DEFAULT_MODEL },
      `输入 ${b} 应回落本地`);
  }
});

test('maskKey: 空值返回空，短 key 全遮，长 key 露首尾各 4 位', () => {
  assert.strictEqual(maskKey(''), '');
  assert.strictEqual(maskKey(null), '');
  assert.strictEqual(maskKey('12345678'), '****');                    // 恰好 8 位 → 全遮
  assert.strictEqual(maskKey('sk-abcdefghijklmn'), 'sk-a****klmn');
});

test('PROVIDER_PRESETS: 每个预设都有 label / env / base', () => {
  for (const [id, p] of Object.entries(PROVIDER_PRESETS)) {
    assert.ok(p.label, `${id} 缺 label`);
    assert.ok(p.env, `${id} 缺 env`);
    assert.ok(/^https?:\/\//.test(p.base), `${id} 的 base 不是 URL`);
  }
});
