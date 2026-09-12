'use strict';
/*
 * lib/context.js —— 会话压缩（compact）的摘要存取层。
 *
 * 流程：POST /api/session/compact 把旧会话全文 → 本地模型摘要 →
 *   摘要挂到「新建的压缩续聊会话」名下（pendingSummary）→
 *   用户在新会话发第一条消息时，chat 路由取出摘要前缀注入 prompt 一次即焚。
 *
 * 为什么注入点在用户 prompt 而非 system prompt：与 lib/autonomy.js 同理——
 * 不触碰 gateway 侧 system prompt 的 KV cache 前缀（实测 97% 命中 → 首字 34.7s）。
 * 为什么「取后即焚」：摘要只需要进一次对话历史，之后由 Hermes 会话自身承载。
 */

const pending = new Map();   // sessionId -> summary text

function setPendingSummary(sessionId, summary) {
  pending.set(sessionId, String(summary || ''));
}

/** 取出并删除（一次性）。无则返回 null。 */
function takePendingSummary(sessionId) {
  const s = pending.get(sessionId);
  pending.delete(sessionId);
  return s || null;
}

/**
 * 把摘要拼接到 prompt 首部（带任务衔接说明）。
 * @param {string} prompt 原始 prompt
 * @param {string} summary 摘要文本
 */
function withSummary(prompt, summary) {
  const head = `【前情摘要 · 来自上一会话】\n${summary}\n\n（以上为上一会话的要点总结，供你理解背景。下面是用户的最新指令。）`;
  return head + '\n\n' + prompt;
}

module.exports = { setPendingSummary, takePendingSummary, withSummary };
