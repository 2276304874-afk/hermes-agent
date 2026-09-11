'use strict';
/* =============================================================================
 * lib/state.js —— 服务运行期可变状态（单例）
 *
 * ⚠️ 为什么单独一个文件而不是分散在各处：
 *    CommonJS 模块是**单例缓存**——同一路径只求值一次。把这些可变容器放在这里，
 *    所有 require 它的模块拿到的是**同一个引用**，写入方（如 chat 路由）与读取方
 *    （如 system 路由）天然一致。
 *    反面做法是在各模块各 `new Map()`，那样 /api/stop 会永远找不到正在跑的进程。
 *
 * 内容：
 *   active   —— runId / sessionId → 正在运行的 Hermes 子进程（供 /api/stop 终止）
 *   usageLog —— 最近 60 轮用量环形缓冲（L4），并同步落盘（P3-12，见 lib/usage.js）
 * ========================================================================== */

const { appendUsage } = require('./usage');

// runId|sessionId -> child process
const active = new Map();

/* ---------- L4: 用量环形日志（最近 60 轮，内存态）----------
 * P3-12: 每条同时**落盘**到 ~/.hermes/usage.jsonl（长期趋势用）。
 * 保留内存缓冲是为了让 /api/usage 的 runs 立即可读、不依赖磁盘。 */
const usageLog = [];
function recordUsage(rec) {
  const row = { ts: Date.now(), ...rec };
  usageLog.push(row);
  if (usageLog.length > 60) usageLog.shift();
  appendUsage(row);   // best-effort：写失败不会影响本轮聊天
}

module.exports = { active, usageLog, recordUsage };
