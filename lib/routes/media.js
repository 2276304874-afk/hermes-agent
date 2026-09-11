'use strict';
/*
 * 多模态与文件路由：视觉理解 / 语音转写 / 文件上传落盘 / 追问推荐。
 * 全部在认证闸门之后。这几个接口请求体较大，各自放宽了 readBody 上限。
 */

module.exports = {
  register(router, ctx) {
    const {
      sendJSON, readBody, describeImage, transcribeAudio, fs, path, HOME,
      resolveModel, http, OLLAMA,
    } = ctx;

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
    router.add('POST', '/api/suggest', async (req, res) => {
      const b = JSON.parse(await readBody(req) || '{}');
      const answer = String(b.answer || '').slice(-1500).trim();
      const m = resolveModel(String(b.model || ''));
      if (!answer || m.cloud) return sendJSON(res, 200, { suggestions: [] });
      const body = JSON.stringify({
        model: m.model,
        messages: [
          { role: 'system', content: '根据这段AI回答，提出3个用户最可能追问的简短问题。只输出一个JSON字符串数组，格式如 ["问题1","问题2","问题3"]，禁止输出任何其他内容，每个问题不超过18个字。' },
          { role: 'user', content: answer }
        ],
        stream: false, keep_alive: '2h',
        think: false,                       // qwen3.5 思考模型：关闭思考直出正文（否则 token 全耗在 reasoning 里）
        options: { temperature: 0.4, num_predict: 130 }
      });
      const suggestions = await new Promise((resolve) => {
        const rq = http.request(OLLAMA + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout: 45000 }, (r) => {
          let buf = '';
          r.on('data', d => buf += d);
          r.on('end', () => {
            try {
              const content = String(JSON.parse(buf).message.content || '');
              const s = content.slice(content.indexOf('['), content.lastIndexOf(']') + 1);
              const arr = JSON.parse(s);
              resolve(Array.isArray(arr) ? arr.filter(x => typeof x === 'string' && x.trim()).slice(0, 3) : []);
            } catch { resolve([]); }
          });
        });
        rq.on('error', () => resolve([]));
        rq.on('timeout', () => { rq.destroy(); resolve([]); });
        rq.end(body);
      });
      return sendJSON(res, 200, { suggestions });
    });
  },
};
