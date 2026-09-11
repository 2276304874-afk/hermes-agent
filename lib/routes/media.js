'use strict';
/*
 * 多模态与文件路由：视觉理解 / 语音转写 / 文件上传落盘 / 追问推荐。
 * 全部在认证闸门之后。这几个接口请求体较大，各自放宽了 readBody 上限。
 */

const fs = require('fs');
const path = require('path');
const { HOME } = require('../config');
const { sendJSON, readBody } = require('../http');
const { describeImage, transcribeAudio, suggestFollowups, optimizePrompt } = require('../ollama');
const { resolveModel } = require('../cloud');

module.exports = {
  register(router) {

    // C4: 多模态理解（body 上限放宽到 8MB，容纳压缩后的 base64 图/音频）
    router.add('POST', '/api/vision', async (req, res) => {
      const raw = await readBody(req, 8 * 1024 * 1024);
      let b = {};
      try { b = JSON.parse(raw || '{}'); } catch { return sendJSON(res, 400, { error: 'bad json' }); }
      const img = String(b.image || '');
      if (!img) return sendJSON(res, 400, { error: 'image required' });
      const r = await describeImage(img, String(b.prompt || '').slice(0, 500));
      return sendJSON(res, r.ok ? 200 : 502, r.ok ? { text: r.text } : { error: r.error });
    });

    // 本地语音转写：前端录音（WAV base64）→ gemma4:e4b 原生音频 → 文字。
    // 替代走云端的 webkitSpeechRecognition，音频不出本机（local-first）。
    router.add('POST', '/api/transcribe', async (req, res) => {
      const raw = await readBody(req, 16 * 1024 * 1024);
      let b = {};
      try { b = JSON.parse(raw || '{}'); } catch { return sendJSON(res, 400, { error: 'bad json' }); }
      const audio = String(b.audio || '');
      if (!audio) return sendJSON(res, 400, { error: 'audio required' });
      const r = await transcribeAudio(audio);
      return sendJSON(res, r.ok ? 200 : 502, r.ok ? { text: r.text } : { error: r.error });
    });

    // B1: 文件上传落盘（大文本/二进制不适合内联 prompt，存 ~/.hermes/uploads 后
    // 把路径注入对话，让 Hermes 用自己的文件工具读取。base64 上限 20MB ≈ 落盘 15MB）
    router.add('POST', '/api/upload', async (req, res) => {
      const raw = await readBody(req, 24 * 1024 * 1024);
      let b = {};
      try { b = JSON.parse(raw || '{}'); } catch { return sendJSON(res, 400, { error: 'bad json' }); }
      const name = String(b.name || 'file').split(/[/\\]/).pop().slice(-120) || 'file';
      const data = String(b.data || '');
      if (!data) return sendJSON(res, 400, { error: 'data required' });
      const buf = Buffer.from(data, 'base64');
      if (!buf.length) return sendJSON(res, 400, { error: 'empty file' });
      if (buf.length > 15 * 1024 * 1024) return sendJSON(res, 413, { error: '文件超过 15MB 上限' });
      const dir = `${HOME}/.hermes/uploads`;
      try {
        fs.mkdirSync(dir, { recursive: true });
        // 时间戳前缀防覆盖 + 文件名只保留安全字符（中文保留）
        const safe = `${Date.now()}-${name.replace(/[^A-Za-z0-9._\-\u4e00-\u9fff]+/g, '_')}`;
        const p = path.join(dir, safe);
        fs.writeFileSync(p, buf);
        return sendJSON(res, 200, { ok: true, path: p, name: safe });
      } catch (e) {
        return sendJSON(res, 500, { error: 'save failed: ' + e.message });
      }
    });

    // 豆包式"为你推荐"：答案完成后用当前模型生成 3 条追问（前台非阻塞调用，失败静默返回空）
    // 模型调用实现已下沉到 lib/ollama.js 的 suggestFollowups（与其它 Ollama 调用同处一地）
    router.add('POST', '/api/suggest', async (req, res) => {
      const b = JSON.parse(await readBody(req) || '{}');
      const answer = String(b.answer || '').slice(-1500).trim();
      const m = resolveModel(String(b.model || ''));
      if (!answer || m.cloud) return sendJSON(res, 200, { suggestions: [] });
      const suggestions = await suggestFollowups(m.model, answer);
      return sendJSON(res, 200, { suggestions });
    });

    // 提示词优化：用户输入口语化文本 → 本地模型改写为更易命中技能的结构化提示词
    // think:false + 低温度 → 确定性改写，不发散；30s 超时（本地模型通常 3-8s）
    router.add('POST', '/api/optimize', async (req, res) => {
      const b = JSON.parse(await readBody(req) || '{}');
      const text = String(b.text || '').trim();
      if (!text) return sendJSON(res, 400, { error: 'text required' });
      if (text.length > 2000) return sendJSON(res, 400, { error: 'text too long (max 2000 chars)' });
      const r = await optimizePrompt(text);
      return sendJSON(res, r.ok ? 200 : 502, r.ok ? { text: r.text } : { error: r.error });
    });
  },
};
