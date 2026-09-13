'use strict';
/* =============================================================================
 * lib/knowledge.js —— 本地知识库（检索 + 查看器数据源）
 *
 * 数据源是三个 Markdown，不需要数据库也不需要独立进程：
 *   .workbuddy/kb_inbox.md      自动捕获的经验（由 kb/capture.py 写）
 *   .workbuddy/kb_distilled.md  蒸馏后的技能（由 kb/distill.py 写）
 *   MEMORY.md（项目级 + 用户级） 长期记忆
 *
 * 检索是「混合」两路（2026-09-13 起，借鉴 OpenClaw 的 hybrid retrieval）：
 *   ① 字面路：委托 kb/kb.py recall（FTS5 trigram + LIKE 兜底），score = token 覆盖率(0~1)。
 *   ② 语义路：复用 bge-m3（lib/skills.js 已在跑）给 KB 条目建向量，余弦相似度(0~1)。
 *   两路同尺度(0~1)，按 text 去重取较高分合并 —— 解决「中文两字词 trigram 召不回、
 *   同义异词（写爬虫 vs 抓网页）命中不了」的短板。
 *   向量不可用/条目为空时自动退化为纯字面路（原行为），不阻塞。
 *
 * ⚠️ 文件名用 knowledge.js 而非 kb.js：routes/ 下已有一个 kb.js（路由），
 *    同名会让人在 require 时看错目录。
 *
 * 一切失败静默降级（返回空数组 / 空串），KB 不可用不该让聊天挂掉。
 * ========================================================================== */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const {
  WORKSPACE, KB_PYTHON, KB_SCRIPT, KB_EMBED_FILE,
  KB_INBOX, KB_DISTILLED, KB_MEM_PROJ, KB_MEM_USER,
} = require('./config');
const { kbListFromBlocks } = require('./parse');
const { embedTexts, cosine } = require('./skills');

/* ---------- ① 字面路：kb.py recall（FTS5 trigram） ---------- */
// 返回命中数组（含 score）；任何异常都静默降级为空数组
function ftsHits(query) {
  let out;
  try {
    out = spawnSync(KB_PYTHON, [KB_SCRIPT, 'recall', '--json', query], {
      timeout: 3000, encoding: 'utf8', env: { ...process.env },
    });
  } catch (e) { return []; }
  if (!out || out.error || !out.stdout) return [];
  try {
    const hits = JSON.parse(out.stdout);
    return Array.isArray(hits) ? hits : [];
  } catch (e) { return []; }
}

/* ---------- ② 语义路：bge-m3 向量 + 余弦 ---------- */
// 大条目（整份 MEMORY.md）按固定窗口切块，避免单条超长导致嵌入质量下降/超限。
const KB_CHUNK_CHARS = 400;
const KB_MAX_CHUNKS = 1200;      // 上限护栏：防 KB 异常膨胀时一次性嵌入过重
const KB_VEC_MIN = 0.50;         // 语义路入场阈值（实测：真正相关 ≈0.65，无关 ≈0.20；0.50 保护注入 prompt 的精度，可调）

function kbChunks(entries) {
  const out = [];
  for (const e of entries) {
    const text = String(e.text || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const src = e.src || '', section = e.section || '';
    if (text.length <= KB_CHUNK_CHARS) { out.push({ src, section, text }); continue; }
    for (let i = 0; i < text.length; i += KB_CHUNK_CHARS) {
      out.push({ src, section, text: text.slice(i, i + KB_CHUNK_CHARS) });
      if (out.length >= KB_MAX_CHUNKS) return out;
    }
  }
  return out;
}

/* ---------- 增量嵌入（性能关键，勿退回全量重嵌）----------
 * 为什么必须增量：`embedTexts` 把**整批文本塞进一个 HTTP 请求**（超时 120s）。
 * KB 有 ~1200 块，而 kb-sync 每 30 分钟就可能改动 kb_inbox/kb_distilled →
 * 指纹一变就全量重嵌 = 单次请求内阻塞几十秒。而 recallContext 在**每个新会话**都会跑，
 * 于是「KB 一变，下一次新会话首 token 就被拖住」——正好打在本项目最在意的首字延迟上。
 * 实测证据：路由冒烟里 `/api/kb/search`、`/api/kb` 两条查询在 KB 内容变更后的那一轮
 * 双双超过 15s 超时而失败（52/2），下一次跑又全绿（54/0）。
 *
 * 做法：把向量按**块内容哈希**存起来（而非按整份指纹），指纹变化时只嵌「新出现的块」。
 * KB 是追加型增长，故绝大多数块原样复用 → 通常只嵌个位数块。 */
const KB_EMBED_VERSION = 2;

function chunkHash(text) {
  return crypto.createHash('sha1').update(text).digest('hex');
}

/**
 * 纯函数：给定 chunks 与已有「内容哈希 → 向量」表，算出还需嵌入哪些块、以及最终 items。
 * 抽成纯函数是因为「增量」的正确性全在这里，必须可单测。
 */
function planEmbed(chunks, byHash) {
  const missing = [];
  const items = [];
  for (const c of chunks) {
    const h = chunkHash(c.text);
    const vec = byHash ? byHash[h] : null;
    if (Array.isArray(vec) && vec.length) items.push({ src: c.src, section: c.section, text: c.text, hash: h, vec });
    else missing.push({ src: c.src, section: c.section, text: c.text, hash: h });
  }
  return { missing, items };
}

let kbEmbedCache = null;   // { key, items } —— 本次进程内的最终索引
let kbVecByHash = null;    // { hash: vec } —— 跨指纹复用的向量本体（增量嵌入的真正依据）
let kbInflight = null;     // 并发去重：同一次重建只跑一遍
let kbVecMigrated = false; // 本次是否由 v1 迁移而来（迁移后即使无需嵌入也要落一次 v2，免得每次启动都重迁）

function loadVecByHash() {
  if (kbVecByHash) return kbVecByHash;
  kbVecByHash = {};
  let j = null;
  try { j = JSON.parse(fs.readFileSync(KB_EMBED_FILE, 'utf8')); } catch { return kbVecByHash; }
  if (j && j.v === KB_EMBED_VERSION && j.byHash && typeof j.byHash === 'object') {
    kbVecByHash = j.byHash;
  } else if (j && Array.isArray(j.items)) {
    // v1 → v2 迁移：老格式存的是 items[{text,vec}]，按其 text 重建哈希表，
    // 避免「升级一次 = 全量重嵌一次」。
    for (const it of j.items) {
      if (it && typeof it.text === 'string' && Array.isArray(it.vec) && it.vec.length) {
        kbVecByHash[chunkHash(it.text)] = it.vec;
      }
    }
    kbVecMigrated = true;
  }
  return kbVecByHash;
}

function saveVecByHash(key, chunks) {
  // 只保留当前 chunks 用到的向量：否则哈希表会随 KB 演化无限膨胀（磁盘 + 内存）
  const keep = {};
  for (const c of chunks) { const h = chunkHash(c.text); if (kbVecByHash[h]) keep[h] = kbVecByHash[h]; }
  kbVecByHash = keep;
  try { fs.writeFileSync(KB_EMBED_FILE, JSON.stringify({ v: KB_EMBED_VERSION, key, byHash: keep }), { mode: 0o600 }); }
  catch { /* 写不进去只影响下次启动要重算，不影响本次结果 */ }
}

async function buildKbIndex(chunks, key) {
  const byHash = loadVecByHash();
  const { missing, items } = planEmbed(chunks, byHash);
  if (!missing.length) {                       // 全部命中缓存 → 零模型调用
    kbEmbedCache = { key, items };
    // v1 迁移来的：此刻顺手落一次 v2（否则每次启动都要重迁一遍 406 条哈希）
    if (kbVecMigrated) { saveVecByHash(key, chunks); kbVecMigrated = false; }
    return kbEmbedCache;
  }
  const vecs = await embedTexts(missing.map(c => c.text));
  if (!vecs) return { key, items: [] };        // 嵌入不可用 → 空索引（调用方退化为字面路）
  missing.forEach((c, i) => {
    const v = vecs[i];
    if (Array.isArray(v) && v.length) { byHash[c.hash] = v; items.push({ src: c.src, section: c.section, text: c.text, hash: c.hash, vec: v }); }
  });
  kbEmbedCache = { key, items };
  saveVecByHash(key, chunks);
  kbVecMigrated = false;
  return kbEmbedCache;
}

async function ensureKbIndex() {
  const chunks = kbChunks(kbListEntries('all'));
  const key = crypto.createHash('sha1').update(chunks.map(c => c.text).join('\n')).digest('hex');
  if (kbEmbedCache && kbEmbedCache.key === key) return kbEmbedCache;
  if (kbInflight) return kbInflight;           // 并发请求共享同一次重建，不重复嵌入
  kbInflight = buildKbIndex(chunks, key).finally(() => { kbInflight = null; });
  return kbInflight;
}

async function vectorHits(query, top = 5) {
  const idx = await ensureKbIndex();
  if (!idx.items.length) return [];
  const qv = await embedTexts([query]);
  if (!qv || !qv[0]) return [];
  return idx.items
    .map(it => ({ source: it.src, section: it.section, text: it.text, score: cosine(qv[0], it.vec) }))
    .filter(h => h.score >= KB_VEC_MIN)
    .sort((a, b) => b.score - a.score)
    .slice(0, top);
}

/* ---------- 混合检索：两路合并 ---------- */
// 返回命中数组（元素含 source/section/text/score）。语义路失败时自动退化为纯字面路。
async function recallHits(query) {
  const fts = ftsHits(query);
  let vec = [];
  try { vec = await vectorHits(query); } catch { vec = []; }
  if (!vec.length) return fts;
  if (!fts.length) return vec;
  // 按 text 前 80 字去重，取两路中较高的 score；同强度时保留字面路（其 section/source 更准）
  const merged = new Map();
  for (const h of fts) merged.set(String(h.text || '').slice(0, 80), h);
  for (const h of vec) {
    const k = String(h.text || '').slice(0, 80);
    const cur = merged.get(k);
    if (!cur || (h.score ?? 0) > (cur.score ?? 0)) merged.set(k, h);
  }
  return [...merged.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

// 新会话时根据 prompt 检索 kb，返回可前缀进 prompt 的上下文块；任何异常都静默降级为 ''
async function recallContext(query) {
  const hits = await recallHits(query);
  if (!hits.length) return Promise.resolve('');
  // 相关性阈值：最佳命中覆盖率低于阈值视为弱相关，不注入（避免无关任务被历史经验污染）
  const RECALL_MIN_SCORE = 0.15;
  if ((hits[0].score ?? 0) < RECALL_MIN_SCORE) return Promise.resolve('');
  const lines = hits.slice(0, 3).map(h => {
    let t = (h.text || '').replace(/\s+/g, ' ').trim();
    if (t.length > 300) t = t.slice(0, 300) + '…';
    return `- (${h.section || '经验'}) ${t}`;
  });
  if (!lines.length) return Promise.resolve('');
  return Promise.resolve(`[自动召回的相关历史经验，回答时请酌情参考]\n${lines.join('\n')}\n[/自动召回]`);
}

/* ---------- 知识库查看器（KB Integration：把 4174 serve.py 的能力统一到 4173） ----------
 * viewer.html 本体是只读展示层，真正的"功能"在其后端 serve.py 的 3 个接口。
 * 这里在主服务内复用同一数据源直接实现 list / search / status，
 * 使赫尔墨斯特工（UI + 智能体）拥有单一可调用的 KB 入口，不再依赖独立 4174 进程。 */
function readKB(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } }

// 文件 IO 留在这一层；解析逻辑委托给 lib/parse.js 的 kbListFromBlocks（纯函数，可单测）
function kbListEntries(cat = 'all') {
  return kbListFromBlocks({
    inbox: readKB(KB_INBOX),
    distilled: readKB(KB_DISTILLED),
    memoryFiles: [KB_MEM_PROJ, KB_MEM_USER]
      .map(p => ({ src: path.relative(WORKSPACE, p), text: readKB(p) }))
      .filter(m => m.text),
  }, cat);
}

module.exports = {
  recallHits, recallContext, kbListEntries,
  // 纯函数导出仅为单测服务（增量嵌入的正确性在此，无 I/O 副作用）
  _internal: { kbChunks, planEmbed, chunkHash },
};
