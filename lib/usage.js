'use strict';
/* =============================================================================
 * lib/usage.js —— 用量日志的长期落盘与聚合（P3-12）
 *
 * 动机：此前 recordUsage 只写内存环形缓冲（最近 60 轮），服务一重启就归零 ——
 * "首字延迟 / tokens per sec / 工具调用数"的趋势永远无从比较，后续任何性能优化
 * 都缺一个数据前提。
 *
 * 设计取舍（都是刻意的，别顺手改成"更完善"的写法）：
 *   · JSONL 追加（一行一条）：崩溃/断电最多丢最后一行，不需要读-改-写整个文件。
 *   · best-effort：写失败绝不抛给调用方 —— 聊天路径不能因为"记日志"而失败；
 *     但**首次**失败会打一行 warn，否则"趋势数据突然断档"将无从解释。
 *   · 大小守护：超过 maxBytes 时保留尾部 keepLines 行后整体重写（与日志截断同思路）。
 *   · 聚合是纯函数 summarize()，文件 IO 单独一层 —— 纯函数才能单测，IO 留在这里。
 *   · 路径可注入（usageFile(env) / 各函数的 file 参数）：测试绝不碰真实
 *     ~/.hermes/usage.jsonl，也沿用项目里 resolvePython(home, env) 的同款约定。
 * ========================================================================== */

const fs = require('fs');
const { USAGE_FILE } = require('./config');

const MAX_BYTES = 5 * 1024 * 1024;   // 单文件上限 5MB（约 2 万轮，够用很久）
const KEEP_LINES = 2000;             // 超限后保留的尾部行数
const TAIL_READ_BYTES = 256 * 1024;  // 聚合时最多从尾部读多少字节
const TAIL_MAX_LINES = 3000;         // 聚合时最多解析多少行

// 解析落盘路径：环境变量优先（便于测试与临时切换），否则用 config 里的默认值
function usageFile(env = process.env) {
  return (env && env.HERMES_USAGE_FILE) || USAGE_FILE;
}

let appendWarned = false;

// 追加一条用量记录。best-effort：任何异常都吞掉，但首次失败会告警一次。
function appendUsage(rec, file = usageFile()) {
  try {
    fs.appendFileSync(file, JSON.stringify(rec) + '\n');
    trimIfOversized(file);
  } catch (e) {
    if (!appendWarned) {
      appendWarned = true;
      console.warn(`[usage] 追加用量日志失败（${file}）：${e.message} → 趋势数据将断档（同错不再重复提示）`);
    }
  }
}

/* 超过上限就保留尾部 keepLines 行后整体重写。
 * 返回 true 表示确实做了裁剪（便于单测断言）。 */
function trimIfOversized(file = usageFile(), maxBytes = MAX_BYTES, keepLines = KEEP_LINES) {
  let st;
  try { st = fs.statSync(file); } catch { return false; }
  if (st.size <= maxBytes) return false;
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    fs.writeFileSync(file, lines.slice(-keepLines).join('\n') + '\n');
    console.warn(`[usage] 用量日志超限（${st.size} 字节）→ 已裁剪至尾部 ${keepLines} 行`);
    return true;
  } catch (e) {
    console.warn(`[usage] 裁剪用量日志失败（${file}）：${e.message}`);
    return false;
  }
}

/* 读尾部若干字节并解析成记录数组。
 * 注意：从文件中间开始读的第一行必然是半截 JSON —— 必须丢掉，
 * 否则每次聚合都会静默少一条（或解析失败被过滤掉，看起来像"数据丢了"）。 */
function readUsageTail(file = usageFile(), maxBytes = TAIL_READ_BYTES) {
  let fd = null;
  try {
    const st = fs.statSync(file);
    if (!st.size) return [];
    const start = Math.max(0, st.size - maxBytes);
    const len = st.size - start;
    const buf = Buffer.alloc(len);
    fd = fs.openSync(file, 'r');
    const read = fs.readSync(fd, buf, 0, len, start);
    let text = buf.toString('utf8', 0, read);
    if (start > 0) {
      const nl = text.indexOf('\n');
      text = nl === -1 ? '' : text.slice(nl + 1);
    }
    return text.split('\n').filter(Boolean)
      .slice(-TAIL_MAX_LINES)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(r => r && typeof r === 'object');
  } catch {
    return [];
  } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch { /* 关不掉也不影响结论 */ } }
  }
}

const avgOf = (rows, pick) => {
  const v = rows.map(pick).filter(x => typeof x === 'number' && isFinite(x));
  if (!v.length) return null;
  return Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100;
};

/* 聚合成"趋势摘要"（纯函数，可单测）。
 * now 可注入，避免测试依赖真实时钟。 */
function summarize(recs, now = Date.now()) {
  const rows = (recs || []).filter(r => r && typeof r === 'object');
  const since = ms => rows.filter(r => typeof r.ts === 'number' && now - r.ts <= ms);
  const d1 = since(24 * 3600 * 1000);
  const d7 = since(7 * 24 * 3600 * 1000);
  const tsList = rows.map(r => (typeof r.ts === 'number' ? r.ts : null)).filter(t => t != null);
  return {
    total: rows.length,
    last24h: d1.length,
    last7d: d7.length,
    // 均值只按最近 24h 算：跨模型/跨版本的旧数据混进来会掩盖真实变化
    avgFirstTokenSec24h: avgOf(d1, r => r.firstTokenSec),
    avgTokPerSec24h: avgOf(d1, r => r.tokPerSec),
    avgElapsedSec24h: avgOf(d1, r => r.elapsedSec),
    toolCallsTotal: rows.reduce((a, r) => a + (r.toolCalls || 0), 0),
    localRuns: rows.filter(r => !r.cloud).length,
    cloudRuns: rows.filter(r => r.cloud).length,
    firstTs: tsList.length ? Math.min(...tsList) : null,
    lastTs: tsList.length ? Math.max(...tsList) : null,
  };
}

// 一步到位：读落盘文件 → 聚合摘要
function usageSummary(file = usageFile()) {
  return summarize(readUsageTail(file));
}

module.exports = {
  usageFile, appendUsage, trimIfOversized, readUsageTail, summarize, usageSummary,
  MAX_BYTES, KEEP_LINES,
};
