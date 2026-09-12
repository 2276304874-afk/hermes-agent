'use strict';
/* =============================================================================
 * scripts/model-bench.js —— 14b 模型对比实验 · 微基准（零依赖 node ≥18）
 *
 * 用法:  node scripts/model-bench.js <model1> <model2> ...
 * 输出:  /tmp/model-bench/results.json（逐模型逐项指标）
 *
 * 指标（全部取自 Ollama 官方计时字段，避免自测口径误差）:
 *   loadSec        冷加载耗时（先 keep_alive:0 卸载，再发 1 token 请求）
 *   ttftSec        首字延迟：~15K token 模拟 system prompt（对应真实 agent prefill 场景）
 *   prefillTokPerSec  prefill 吞吐（prompt_eval_count / prompt_eval_duration）
 *   genTokPerSec      生成吞吐（eval_count / eval_duration）
 *   jsonOk/3       工具调用 JSON 合规率（agent 场景的硬前提）
 *   memGB          模型磁盘体积（16G 统一内存下的间接资源约束）
 * ========================================================================== */
const fs = require('fs');
const OLLAMA = 'http://127.0.0.1:11434';

const post = (path, body, timeoutMs = 600000) => fetch(OLLAMA + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
});

// ~15K token 的模拟 system prompt（贴近真实 agent 场景的 prefill 体量）
function bigSystemPrompt() {
  const para = '你是本地智能体，遵守隐私边界，所有推理在本地完成。' +
    '可用工具包括终端、文件读写与搜索；执行前需确认影响范围，危险操作必须停下来询问用户。' +
    '输出需结构化：先给结论，再给依据，最后列改动文件与遗留风险。';
  let s = para;
  while (s.length < 60000) s += '\n' + para + '（附则 ' + (s.length % 97) + '）';
  return s;
}

async function unload(model) {
  await post('/api/generate', { model, keep_alive: 0, prompt: '' }, 30000).catch(() => {});
}

async function measureLoad(model) {
  const t0 = Date.now();
  await post('/api/generate', { model, prompt: 'hi', stream: false, options: { num_predict: 1 } });
  return (Date.now() - t0) / 1000;
}

// 流式请求：首块时间 = TTFT；末块携带官方 eval 统计
async function chatStream(model, messages) {
  const t0 = Date.now();
  let ttft = null, stats = null, text = '';
  const resp = await post('/api/chat', { model, messages, stream: true });
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
      if (!line) continue;
      let j; try { j = JSON.parse(line); } catch { continue; }
      if (ttft === null && j.message && j.message.content) ttft = (Date.now() - t0) / 1000;
      if (j.message && j.message.content) text += j.message.content;
      if (j.done && j.prompt_eval_count != null) {
        stats = {
          promptTokens: j.prompt_eval_count,
          prefillTokPerSec: Math.round(j.prompt_eval_count / (j.prompt_eval_duration / 1e9)),
          genTokPerSec: j.eval_count ? Math.round(j.eval_count / (j.eval_duration / 1e9)) : null,
          genTokens: j.eval_count || 0,
        };
      }
    }
  }
  return { ttft, stats, text };
}

async function jsonCompliance(model) {
  const sys = '你是工具调用引擎。只输出一个 JSON 对象，格式：{"tool":"terminal","command":"<命令>"}，禁止输出任何其他文字。';
  const cases = ['列出当前目录的文件', '查看 disk 使用情况', '显示 node 版本'];
  let ok = 0;
  for (const c of cases) {
    try {
      const r = await post('/api/chat', {
        model, stream: false,
        messages: [{ role: 'system', content: sys }, { role: 'user', content: c }],
        options: { temperature: 0.1, num_predict: 200 },
      }, 120000);
      const j = await r.json();
      const t = (j.message && j.message.content || '').trim()
        .replace(/^```(json)?/i, '').replace(/```$/, '').trim();
      const obj = JSON.parse(t);
      if (obj && typeof obj.command === 'string' && obj.command.length > 0) ok++;
    } catch { /* 记失败 */ }
  }
  return ok;
}

async function benchOne(model) {
  console.log(`\n=== ${model} ===`);
  const r = { model };
  r.memGB = Number(await post('/api/show', { model }).then(x => x.json())
    .then(d => ((d.size || 0) / 1e9).toFixed(1)).catch(() => null));
  await unload(model);
  r.loadSec = Number((await measureLoad(model)).toFixed(1));
  console.log(`  冷加载: ${r.loadSec}s · 磁盘 ${r.memGB}GB`);

  const long = await chatStream(model, [
    { role: 'system', content: bigSystemPrompt() },
    { role: 'user', content: '用一句话回答：1+1等于几？' },
  ]);
  r.ttftSec = Number(long.ttft.toFixed(1));
  r.promptTokens = long.stats ? long.stats.promptTokens : null;
  r.prefillTokPerSec = long.stats ? long.stats.prefillTokPerSec : null;
  r.genTokPerSec = long.stats ? long.stats.genTokPerSec : null;
  console.log(`  TTFT(${r.promptTokens} tok): ${r.ttftSec}s · prefill ${r.prefillTokPerSec} tok/s · 生成 ${r.genTokPerSec} tok/s`);

  r.jsonOk = await jsonCompliance(model);
  console.log(`  JSON 工具调用合规: ${r.jsonOk}/3`);
  await unload(model);   // 给下一个模型腾内存
  return r;
}

(async () => {
  const models = process.argv.slice(2);
  if (!models.length) { console.error('用法: node scripts/model-bench.js <model...>'); process.exit(1); }
  const results = [];
  for (const m of models) results.push(await benchOne(m));
  fs.mkdirSync('/tmp/model-bench', { recursive: true });
  fs.writeFileSync('/tmp/model-bench/results.json', JSON.stringify(results, null, 2));
  console.log('\n结果已写入 /tmp/model-bench/results.json');
})().catch(e => { console.error('BENCH_FAIL:', e.message); process.exit(1); });
