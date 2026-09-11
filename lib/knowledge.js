'use strict';
/* =============================================================================
 * lib/knowledge.js —— 本地知识库（检索 + 查看器数据源）
 *
 * 数据源是三个 Markdown，不需要数据库也不需要独立进程：
 *   .workbuddy/kb_inbox.md      自动捕获的经验（由 kb/capture.py 写）
 *   .workbuddy/kb_distilled.md  蒸馏后的技能（由 kb/distill.py 写）
 *   MEMORY.md（项目级 + 用户级） 长期记忆
 *
 * 检索委托给 kb/kb.py recall（FTS5 trigram），它才是索引的主人；
 * 这里只做「调它 + 兜底」。列举/状态则直接读文件，不走 python（省一次进程开销）。
 *
 * ⚠️ 文件名用 knowledge.js 而非 kb.js：routes/ 下已有一个 kb.js（路由），
 *    同名会让人在 require 时看错目录。
 *
 * 一切失败静默降级（返回空数组 / 空串），KB 不可用不该让聊天挂掉。
 * ========================================================================== */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  WORKSPACE, KB_PYTHON, KB_SCRIPT,
  KB_INBOX, KB_DISTILLED, KB_MEM_PROJ, KB_MEM_USER,
} = require('./config');
const { kbListFromBlocks } = require('./parse');

// 运行 kb.py recall，返回命中数组（含 score）；任何异常都静默降级为空数组
function recallHits(query) {
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

// 新会话时根据 prompt 检索 kb，返回可前缀进 prompt 的上下文块；任何异常都静默降级为 ''
function recallContext(query) {
  const hits = recallHits(query);
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

module.exports = { recallHits, recallContext, kbListEntries };
