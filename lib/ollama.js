'use strict';
/* =============================================================================
 * lib/ollama.js —— 本地 Ollama 调用（状态探测 / 多模态 / 预热门 / 追问生成）
 *
 * 全部用 node:http 手写，不引任何依赖（local-first 硬约束）。
 * 所有函数**失败即退化**：返回 null / {ok:false} / []，绝不抛错——
 * 调用方是 HTTP 请求路径，Ollama 没开不该让 UI 拿到 500。
 *
 * 2026-09-10 起视觉/音频改由 gemma4:e4b 原生承担（原来用独立 llava:7b，
 * 16G 内存下单驻留必然触发模型换载）。所以 VISION_MODEL === DEFAULT_MODEL。
 * ========================================================================== */

const http = require('http');
const { OLLAMA, DEFAULT_MODEL, VISION_MODEL, KEEP_ALIVE } = require('./config');

/* ---------- L4: Ollama 运行状态 ----------
 * ps = 驻留内存模型（空闲 5 分钟自动卸载，为空是常态）；tags = 全部已装模型数。
 * A3 增强：无驻留时前端用 available 计数显示"可用 N 个模型"，避免误读为 Ollama 没模型。 */
function ollamaGet(p, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get(OLLAMA + p, { timeout: timeoutMs || 3000 }, (r) => {
      let buf = '';
      r.on('data', d => buf += d);
      r.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function ollamaStatus() {
  const [ps, tags] = await Promise.all([ollamaGet('/api/ps'), ollamaGet('/api/tags')]);
  if (!ps) return { up: false, models: [], available: 0 };
  return {
    up: true,
    models: (ps.models || []).map(m => ({
      name: m.name, sizeGb: Math.round((m.size || 0) / 1073741824 * 10) / 10,
      context: (m.size_info && m.size_info.context) || null, expires: m.expires_at || null
    })),
    available: (tags && tags.models || []).length
  };
}

/* ---------- 模型是否驻留（仅查 /api/ps，2s 超时，失败一律视为 false）----------
 * 用途：聊天开始前非阻塞探测目标模型是否已在显存，未驻留则尽早给前端「模型加载中」提示，
 * 避免冷加载（16G 下同机其他模型换载争抢）期间界面 5 分钟静默转圈（审计 2026-09-13 复现 200s 静默挂起）。
 * 仅作提示用途，故任何异常都降级成 false（不阻塞、不报错）。 */
async function isModelResident(model) {
  const ps = await ollamaGet('/api/ps', 2000);
  if (!ps || !Array.isArray(ps.models)) return false;
  return ps.models.some(m => (m.name || '') === model || (m.name || '').startsWith(model + ':'));
}

// 同步探测 Ollama 在线状态（超时 2s，失败视为离线），供 /api/kb/status 使用
function ollamaStatusSync() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: 11434, path: '/api/tags', timeout: 2000 }, (r) => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => {
        try { const j = JSON.parse(d); resolve({ running: true, models: (j.models || []).map(m => m.name) }); }
        catch { resolve({ running: false, models: [] }); }
      });
    });
    req.on('timeout', () => { try { req.destroy(); } catch { /* 已结束/已销毁时 destroy 会抛，无害 */ } resolve({ running: false, models: [] }); });
    req.on('error', () => resolve({ running: false, models: [] }));
  });
}

/* ---------- C4: 多模态理解（图片 / 音频） ----------
 * base64 媒体放进 messages[].images —— Ollama 对图片和音频用的是同一个字段。
 * 不走 Hermes 主链路（Hermes 是纯文本 agent），识别结果以文本注入对话上下文。
 * think:false —— OCR/转写不需要推理链：gemma4 默认会先吐 1.4k 字思考，
 * 既白烧 token，又可能把输出额度占满导致 message.content 为空。 */
function multimodalAsk(base64Data, prompt, timeoutMs) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: VISION_MODEL,
      messages: [{ role: 'user', content: prompt, images: [base64Data] }],
      stream: false,
      keep_alive: KEEP_ALIVE,
      think: false,
      options: { num_predict: 2048 }
    });
    const req = http.request(OLLAMA + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      timeout: timeoutMs || 300000
    }, (r) => {
      let buf = '';
      r.on('data', d => buf += d);
      r.on('end', () => {
        try {
          const j = JSON.parse(buf);
          if (j.error) return resolve({ ok: false, error: String(j.error) });
          const mm = j.message || {};
          // 兜底：万一某模型仍带思考且额度被占满，退化用 thinking 字段（总比返回空好）
          const msg = (mm.content || '').trim() || (mm.thinking || '').trim();
          resolve({ ok: true, text: String(msg).trim() });
        } catch {
          resolve({ ok: false, error: '解析多模态响应失败: ' + buf.slice(0, 300) });
        }
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: '多模态请求失败: ' + e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: '多模态响应超时' }); });
    req.end(body);
  });
}

const describeImage = (imageB64, prompt) => multimodalAsk(
  imageB64,
  prompt || '描述这张图片的内容；如果包含文字或代码，逐字提取。',
  300000
);

const transcribeAudio = (audioB64) => multimodalAsk(
  audioB64,
  '逐字转写这段音频里的语音（中文）。只输出转写文本，不要任何解释或前后缀；若没有可辨识语音，输出空字符串。',
  180000
);

/* ---------- Ollama 模型保活 ----------
 * 空 body 的 /api/generate 只做「加载 + 续期」，不产生输出。 */
function prewarmOllama(model) {
  const body = JSON.stringify({ model, keep_alive: KEEP_ALIVE });
  const req = http.request(OLLAMA + '/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' } }, () => {});
  req.on('error', () => {});
  req.end(body);
}

/* ---------- 豆包式"为你推荐"：答案完成后生成 3 条追问 ----------
 * 非阻塞性质：调用方（media 路由）在失败时静默返回空数组。
 * think:false —— 同多模态理由：这类小任务不需要推理链，否则 token 全耗在 reasoning 里。 */
function suggestFollowups(model, answer) {
  const body = JSON.stringify({
    model: model || DEFAULT_MODEL,
    messages: [
      { role: 'system', content: '根据这段AI回答，提出3个用户最可能追问的简短问题。只输出一个JSON字符串数组，格式如 ["问题1","问题2","问题3"]，禁止输出任何其他内容，每个问题不超过18个字。' },
      { role: 'user', content: answer }
    ],
    stream: false, keep_alive: KEEP_ALIVE,
    think: false,
    options: { temperature: 0.4, num_predict: 130 }
  });
  return new Promise((resolve) => {
    const rq = http.request(OLLAMA + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout: 45000 }, (r) => {
      let buf = '';
      r.on('data', d => buf += d);
      r.on('end', () => {
        try {
          const content = String(JSON.parse(buf).message.content || '');
          // B3（审计 2026-09-13 加固）：先整体解析（模型听话直接给纯 JSON 数组时最稳）；
          // 失败再回退到「截取首个 [ … ] 区间」——模型若夹带解释性文字或正文里出现括号，
          // 旧写法 content.slice(indexOf('[')…) 会切到错误区间导致整列追问丢失。两道都失败才返回空。
          let arr = [];
          try { arr = JSON.parse(content); }
          catch {
            const s = content.slice(content.indexOf('['), content.lastIndexOf(']') + 1);
            arr = JSON.parse(s);
          }
          resolve(Array.isArray(arr) ? arr.filter(x => typeof x === 'string' && x.trim()).slice(0, 3) : []);
        } catch { resolve([]); }
      });
    });
    rq.on('error', () => resolve([]));
    rq.on('timeout', () => { rq.destroy(); resolve([]); });
    rq.end(body);
  });
}

/* ---------- 提示词优化：把口语化输入改写为更易命中技能的结构化提示 ----------
 * think:false + 低 temperature → 确定性改写，不发散。
 * 返回 {ok:true, text:string} 或 {ok:false, error:string}。 */
function optimizePrompt(text) {
  const body = JSON.stringify({
    model: DEFAULT_MODEL,
    messages: [
      { role: 'system', content: '你是提示词优化助手。用户会输入一段口语化的中文指令或问题。你的任务是：\n1. 保持原意不变，不添加用户未提及的功能或需求\n2. 改写为更清晰、更完整、更结构化的表达\n3. 补充必要的上下文（如"用本地模型""在赫尔墨斯特工项目中"等隐含约束）\n4. 输出只包含改写后的提示词本身，不要解释、不要前缀、不要引号包裹\n5. 如果原文已经足够清晰，可以小幅润色但不要大幅重写\n6. 输出语言与输入一致（中文输入→中文输出）' },
      { role: 'user', content: text }
    ],
    stream: false, keep_alive: KEEP_ALIVE,
    think: false,
    options: { temperature: 0.3, num_predict: 500 }
  });
  return new Promise((resolve) => {
    const rq = http.request(OLLAMA + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout: 30000 }, (r) => {
      let buf = '';
      r.on('data', d => buf += d);
      r.on('end', () => {
        try {
          const j = JSON.parse(buf);
          if (j.error) return resolve({ ok: false, error: String(j.error) });
          resolve({ ok: true, text: String(j.message.content || '').trim() });
        } catch { resolve({ ok: false, error: '解析响应失败' }); }
      });
    });
    rq.on('error', (e) => resolve({ ok: false, error: e.message }));
    rq.on('timeout', () => { rq.destroy(); resolve({ ok: false, error: '优化超时' }); });
    rq.end(body);
  });
}

/* ---------- 会话压缩：把长会话 Markdown 摘要为要点 ----------
 * think:false 防止 token 烧在 reasoning；num_ctx 拉满以容纳整段历史。
 * 返回 {ok:true, text} 或 {ok:false, error}。 */
function summarizeHistory(text) {
  const body = JSON.stringify({
    model: DEFAULT_MODEL,
    messages: [
      { role: 'system', content: '你是会话压缩助手。把给定的对话历史压缩成不超过 500 字的要点摘要，供开启新会话续聊使用。必须保留：1. 用户的最终目标与关键约束 2. 已完成的改动及涉及文件路径 3. 遗留问题与下一步计划 4. 重要决定及其原因。用简洁的条目列出，不要客套话，不要评论，只输出摘要本身。' },
      { role: 'user', content: String(text || '').slice(0, 48000) }
    ],
    stream: false, keep_alive: KEEP_ALIVE,
    think: false,
    options: { temperature: 0.2, num_predict: 900 }
  });
  return new Promise((resolve) => {
    const rq = http.request(OLLAMA + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout: 180000 }, (r) => {
      let buf = '';
      r.on('data', d => buf += d);
      r.on('end', () => {
        try {
          const j = JSON.parse(buf);
          if (j.error) return resolve({ ok: false, error: String(j.error) });
          resolve({ ok: true, text: String(j.message.content || '').trim() });
        } catch { resolve({ ok: false, error: '解析响应失败' }); }
      });
    });
    rq.on('error', (e) => resolve({ ok: false, error: e.message }));
    rq.on('timeout', () => { rq.destroy(); resolve({ ok: false, error: '摘要超时' }); });
    rq.end(body);
  });
}

module.exports = {
  ollamaGet, ollamaStatus, ollamaStatusSync, isModelResident,
  multimodalAsk, describeImage, transcribeAudio,
  prewarmOllama, suggestFollowups, optimizePrompt, summarizeHistory,
};
