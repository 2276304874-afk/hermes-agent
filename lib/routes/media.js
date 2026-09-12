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
    // 项目模式：body 带 files 数组 [{path(相对路径), data(base64)}] + project 名称 →
    //   整目录落盘到 ~/.hermes/uploads/projects/<项目名>-<ts>/，返回项目根路径。
    router.add('POST', '/api/upload', async (req, res) => {
      const raw = await readBody(req, 24 * 1024 * 1024);
      let b = {};
      try { b = JSON.parse(raw || '{}'); } catch { return sendJSON(res, 400, { error: 'bad json' }); }

      /* ---- 项目（多文件）模式 ---- */
      if (Array.isArray(b.files) && b.files.length) {
        const MAX_FILES = 200, MAX_FILE = 2 * 1024 * 1024, MAX_TOTAL = 16 * 1024 * 1024;
        const proj = String(b.project || 'project').split(/[/\\]/).pop().replace(/[^A-Za-z0-9._\-\u4e00-\u9fff]+/g, '_').slice(-60) || 'project';
        if (b.files.length > MAX_FILES) return sendJSON(res, 413, { error: `文件数超过 ${MAX_FILES} 上限（请排除 node_modules 等目录）` });
        const dir = path.join(`${HOME}/.hermes/uploads/projects`, `${Date.now()}-${proj}`);
        // 两阶段：先全部校验（路径合法 + 尺寸上限），再统一写入——避免中途失败残留半截项目
        const prepared = [];
        let total = 0;
        for (const f of b.files) {
          const rel = String(f.path || '');
          if (!rel || rel.includes('..') || path.isAbsolute(rel)) return sendJSON(res, 400, { error: '非法相对路径: ' + rel.slice(0, 80) });
          const buf = Buffer.from(String(f.data || ''), 'base64');
          if (!buf.length) continue;
          if (buf.length > MAX_FILE) return sendJSON(res, 413, { error: `单文件超过 2MB: ${rel.slice(0, 80)}` });
          total += buf.length;
          if (total > MAX_TOTAL) return sendJSON(res, 413, { error: '项目总量超过 16MB 上限' });
          const dest = path.join(dir, rel);
          if (!dest.startsWith(dir + path.sep) && dest !== dir) return sendJSON(res, 400, { error: '路径越界: ' + rel.slice(0, 80) });
          prepared.push({ dest, buf });
        }
        if (!prepared.length) return sendJSON(res, 400, { error: '没有可落盘的文件' });
        try {
          for (const it of prepared) {
            fs.mkdirSync(path.dirname(it.dest), { recursive: true });
            fs.writeFileSync(it.dest, it.buf);
          }
          return sendJSON(res, 200, { ok: true, project: proj, dir, count: prepared.length, path: dir });
        } catch (e) {
          return sendJSON(res, 500, { error: 'save failed: ' + e.message });
        }
      }

      /* ---- 单文件模式（原行为不变） ---- */
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
