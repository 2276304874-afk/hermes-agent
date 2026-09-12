'use strict';
/* =============================================================================
 * lib/stopjudge.js —— 停止条件裁判（服务端强制层）
 *
 * 为什么需要它（这是与 MiMo-Code 对照后唯一确认的真缺口）：
 *   提示词层面的"跑偏"治理已经做过了（lib/autonomy.js 的三色纪律 + 任务边界守卫），
 *   但提示词只能"请求"模型别打转，模型照样会。真实复现过两种跑偏：
 *     ① 上下文被吃满后失忆，把"做旅行网站"退化成写 hello-world 原型 demo（跨模型确定性复现）；
 *     ② 反复用同样的参数重试同一条命令，每次都拿到同样的失败结果，绕不出来。
 *   这两类都不是"错"，而是**停不下来** —— 缺一个不依赖模型自觉的外部裁判。
 *
 * 判据（都只依赖 state.db 里已轮询到的行，不额外调模型、不加延迟）：
 *   D1 repeat     同一工具调用（名字+参数）在一次 run 内重复 ≥N 次           → warn
 *   D2 same_result 同一调用 + 工具返回内容完全相同 ≥M 次（= 卡死，不是探索）  → hard
 *   D3 budget     一次 run 内工具调用总数超阈值（失控式刷工具）               → hard
 *
 * 设计取舍：
 *   · **只报告，不中断**。默认绝不 abort —— 长任务里"看起来在重复"是常态
 *     （轮询、渐进重试）。裁判的价值在于让用户及时看到"它在打转"，
 *     而不是替用户做决定。要强制中断需显式设置 HERMES_JUDGE_ABORT=1。
 *   · 判据必须高精度低召回：宁可漏报，也不能把正常长任务误判成跑偏 ——
 *     误报会让用户不再相信这个提示（狼来了）。
 *   · 同一结论只报一次（fired 去重）：每轮都刷同一条告警等于没有告警。
 * ========================================================================== */

const crypto = require('crypto');

function intEnv(name, dflt) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}

const REPEAT_LIMIT = intEnv('HERMES_JUDGE_REPEAT_LIMIT', 3);
const DUP_RESULT_LIMIT = intEnv('HERMES_JUDGE_DUP_RESULT_LIMIT', 2);
const CALL_BUDGET = intEnv('HERMES_JUDGE_CALL_BUDGET', 40);

function sha1(s) { return crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 10); }

/** 把工具参数归一化成稳定签名。对象键排序，避免键序差异造成"同一次调用两种签名"。 */
function normalizeArgs(args) {
  if (args == null) return '';
  let v = args;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return v.trim(); } }
  if (v === null || typeof v !== 'object') return String(v);
  const walk = (x) => {
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === 'object') {
      const out = {};
      for (const k of Object.keys(x).sort()) out[k] = walk(x[k]);
      return out;
    }
    return x;
  };
  try { return JSON.stringify(walk(v)); } catch { return String(v); }
}

/** 从一条 assistant 行抽出全部工具调用签名 —— `工具名@参数摘要`。 */
function signaturesOf(row) {
  if (!row || row.role !== 'assistant' || !row.tool_calls) return [];
  let calls;
  try { calls = JSON.parse(row.tool_calls); } catch { return []; }
  const arr = Array.isArray(calls) ? calls : [calls];
  const out = [];
  for (const c of arr) {
    const f = (c && c.function) || c || {};
    const name = f.name || 'tool';
    out.push(`${name}@${sha1(normalizeArgs(f.arguments))}:${name}`);
  }
  return out;
}

/** 工具结果的可比较正文（去掉 id/时间戳等易变包装，只留实际内容）。 */
function resultDigest(row) {
  if (!row || row.role !== 'tool') return '';
  let raw = String(row.content == null ? '' : row.content);
  try {
    const c = JSON.parse(raw);
    if (c && typeof c === 'object') {
      raw = c.output != null ? String(c.output) : (c.error != null ? 'ERR:' + c.error : JSON.stringify(c));
    }
  } catch { /* 非 JSON：原样比较（正常分支） */ }
  return sha1(raw.trim());
}

/**
 * 建一个本轮 run 的裁判。用法：
 *   const j = createJudge();
 *   j.observe(rowsFromDB)   // 每轮把新消息喂进来，返回当前裁决
 *   j.result()              // 只读当前裁决
 * 返回 {level:'ok'|'warn'|'hard', code, message, evidence:{tool,calls,hits}}
 */
function createJudge(opts = {}) {
  const repeatLimit = opts.repeatLimit || REPEAT_LIMIT;
  const dupLimit = opts.dupResultLimit || DUP_RESULT_LIMIT;
  const budget = opts.callBudget || CALL_BUDGET;

  const calls = new Map();   // sig -> {name, count, results:Map<resultDigest,count>}
  let lastSig = '';          // 最近一次工具调用的签名（tool 结果行归属到它）
  let total = 0;
  let current = { level: 'ok', code: '', message: '', evidence: {} };

  const RANK = { ok: 0, warn: 1, hard: 2 };

  function raise(level, code, message, evidence) {
    if (RANK[level] < RANK[current.level]) return false;   // 不允许低级别覆盖高级别（hard 不被 warn 冲掉）
    if (current.code === code) return false;               // 同一结论只报一次
    current = { level, code, message, evidence };
    return true;
  }

  function step(row) {
    const sigs = signaturesOf(row);
    if (sigs.length) {
      total += sigs.length;
      for (const s of sigs) {
        const e = calls.get(s) || { name: s.split('@')[0], count: 0, results: new Map() };
        e.count++;
        calls.set(s, e);
        lastSig = s;
        if (e.count >= repeatLimit) {
          raise('warn', 'repeat',
            `同一工具调用已重复 ${e.count} 次（${e.name}）：若这一轮没有新信息，说明方向不对 —— 停下汇报卡点，不要继续同样重试。`,
            { tool: e.name, calls: total, hits: e.count });
        }
      }
      return;
    }
    if (row && row.role === 'tool') {
      // 归属到最近一次工具调用（state.db 行序：assistant(tool_calls) → tool(result)）。
      // ⚠️ 不能用「Map 里最后一个」—— Map 保插入序，重复调用老签名时它不在末尾。
      const last = lastSig ? calls.get(lastSig) : null;
      if (!last) return;
      const d = resultDigest(row);
      if (!d) return;
      const n = (last.results.get(d) || 0) + 1;
      last.results.set(d, n);
      // n = 该结果正文在这次调用上出现的次数；dupLimit=2 表示"第二次拿到同样的返回"即判卡死
      if (n >= dupLimit) {
        raise('hard', 'same_result',
          `同一工具调用已第 ${n} 次拿到完全相同的返回（${last.name}）—— 这是卡死而非探索，建议中止本轮并汇报。`,
          { tool: last.name, calls: total, hits: n });
      }
      if (total >= budget) {
        raise('hard', 'budget',
          `本轮工具调用已达 ${total} 次仍未见收敛 —— 可能是任务描述过宽或模型失控，建议停下检查方向。`,
          { calls: total, hits: total });
      }
    }
  }

  return {
    observe(rows) {
      const news = [];
      for (const r of (rows || [])) { const before = current.code; step(r); if (current.code !== before) news.push(current); }
      return { state: current, transitions: news };
    },
    result() { return current; },
    stats() { return { calls: total, distinct: calls.size, repeatLimit, dupLimit, budget }; },
  };
}

module.exports = {
  createJudge, signaturesOf, normalizeArgs,
  limits: { REPEAT_LIMIT, DUP_RESULT_LIMIT, CALL_BUDGET },
};
