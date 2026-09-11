'use strict';
/*
 * 工具箱路由（L5）：MCP 服务 / 定时任务 / 技能 / 记忆 的读写界面。
 * 全部在认证闸门之后。技能列表走直扫目录（scanLocalSkills），绕开 CLI 列宽截断。
 * 三个 CLI 解析点带 warnIfParseEmpty —— 输出有内容却解析 0 条会告警，防格式变更后静默失效。
 */

const { parseMcpList, parseCronList, warnIfParseEmpty } = require('../parse');

module.exports = {
  register(router, ctx) {
    const {
      sendJSON, readBody, runHermes, fs,
      scanLocalSkills, ensureSkillIndex, embedTexts, cosine,
      MEMORY_FILE, USER_FILE, MEMORY_DIR,
    } = ctx;

    /* ---------- L5: MCP 服务管理 ---------- */
    router.add('GET', '/api/mcp', async (req, res) => {
      const r = await runHermes(['mcp', 'list']);
      const servers = parseMcpList(r.out);
      warnIfParseEmpty('mcp list', r.out, servers.length);
      return sendJSON(res, 200, { servers, raw: r.out.slice(0, 2000) });
    });

    router.add('POST', '/api/mcp/add', async (req, res) => {
      const b = JSON.parse(await readBody(req) || '{}');
      const name = String(b.name || '').trim();
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) return sendJSON(res, 400, { error: '名称仅限字母数字-_（1-64 位）' });
      const args = ['mcp', 'add', name];
      if (b.url) args.push('--url', String(b.url).trim());
      else if (b.command) {
        args.push('--command', String(b.command).trim());
        for (const a of (Array.isArray(b.args) ? b.args : String(b.args || '').split(/\s+/))) {
          if (String(a).trim()) args.push(String(a).trim());
        }
      } else return sendJSON(res, 400, { error: '需要 url 或 command' });
      // add 可能询问 "Save config anyway? [y/N]" → 自动应答 y
      const r = await runHermes(args, 'y\n');
      return sendJSON(res, r.code === 0 ? 200 : 500, { ok: r.code === 0, message: (r.out + r.err).slice(-300) });
    });

    router.add('POST', '/api/mcp/remove', async (req, res) => {
      const b = JSON.parse(await readBody(req) || '{}');
      const name = String(b.name || '').trim();
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) return sendJSON(res, 400, { error: 'bad name' });
      const r = await runHermes(['mcp', 'remove', name], 'y\n');
      return sendJSON(res, r.code === 0 ? 200 : 500, { ok: r.code === 0, message: (r.out + r.err).slice(-300) });
    });

    /* ---------- L5: 定时任务 ---------- */
    router.add('GET', '/api/cron', async (req, res) => {
      const [list, status] = await Promise.all([runHermes(['cron', 'list']), runHermes(['cron', 'status'])]);
      const jobs = parseCronList(list.out);
      warnIfParseEmpty('cron list', list.out, jobs.length);
      return sendJSON(res, 200, {
        jobs,
        gatewayOk: /running|✓/.test(status.out) && !/not running/.test(status.out),
        raw: list.out.slice(0, 3000)
      });
    });

    router.add('POST', '/api/cron/create', async (req, res) => {
      const b = JSON.parse(await readBody(req) || '{}');
      const schedule = String(b.schedule || '').trim();
      const prompt = String(b.prompt || '').trim();
      const name = String(b.name || '').trim().slice(0, 60);
      if (!schedule || /\n/.test(schedule)) return sendJSON(res, 400, { error: 'schedule 必填（如 30m / every 2h / 0 9 * * *）' });
      if (!prompt || prompt.length > 2000) return sendJSON(res, 400, { error: 'prompt 必填（≤2000 字符）' });
      const args = ['cron', 'create', schedule, prompt];
      if (name) args.push('--name', name);
      const r = await runHermes(args);
      return sendJSON(res, r.code === 0 ? 200 : 500, { ok: r.code === 0, message: (r.out + r.err).slice(-400) });
    });

    router.add('POST', '/api/cron/action', async (req, res) => {
      const b = JSON.parse(await readBody(req) || '{}');
      const id = String(b.id || '').trim();
      const action = String(b.action || '');
      if (!/^[0-9a-f]{6,}$/.test(id)) return sendJSON(res, 400, { error: 'bad job id' });
      if (!['pause', 'resume', 'run', 'remove'].includes(action)) return sendJSON(res, 400, { error: 'bad action' });
      // remove 需要交互确认 y
      const r = await runHermes(['cron', action, id], action === 'remove' ? 'y\n' : null);
      return sendJSON(res, r.code === 0 ? 200 : 500, { ok: r.code === 0, message: (r.out + r.err).slice(-300) });
    });

    /* ---------- L5: 技能管理 ---------- */
    router.add('GET', '/api/skills', (req, res) => {
      return sendJSON(res, 200, { skills: scanLocalSkills() });
    });

    router.add('POST', '/api/skills/search', async (req, res) => {
      const b = JSON.parse(await readBody(req) || '{}');
      const q = String(b.query || '').trim().slice(0, 100);
      if (!q) return sendJSON(res, 400, { error: 'query required' });
      const r = await runHermes(['skills', 'search', q]);
      return sendJSON(res, 200, { raw: (r.out || r.err).slice(0, 4000) });
    });

    // 本地语义检索：bge-m3 嵌入 → 余弦相似度 → 返回最相关的已装技能（自然语言找技能）
    router.add('POST', '/api/skills/find', async (req, res) => {
      const b = JSON.parse(await readBody(req) || '{}');
      const q = String(b.query || '').trim().slice(0, 200);
      if (!q) return sendJSON(res, 400, { error: 'query required' });
      const idx = await ensureSkillIndex();
      if (!idx.items.length) return sendJSON(res, 200, { matches: [], fallback: true });
      const qv = await embedTexts([q]);
      if (!qv || !qv[0]) return sendJSON(res, 200, { matches: [], fallback: true });
      const matches = idx.items
        .map(it => ({ name: it.name, description: it.description, score: cosine(qv[0], it.vec) }))
        .sort((x, y) => y.score - x.score)
        .slice(0, Number(b.top) || 8);
      return sendJSON(res, 200, { matches });
    });

    router.add('POST', '/api/skills/install', async (req, res) => {
      const b = JSON.parse(await readBody(req) || '{}');
      const name = String(b.name || '').trim().slice(0, 100);
      if (!name || /\s/.test(name)) return sendJSON(res, 400, { error: 'bad skill name' });
      const r = await runHermes(['skills', 'install', name], 'y\n');
      return sendJSON(res, r.code === 0 ? 200 : 500, { ok: r.code === 0, message: (r.out + r.err).slice(-400) });
    });

    router.add('POST', '/api/skills/uninstall', async (req, res) => {
      const b = JSON.parse(await readBody(req) || '{}');
      const name = String(b.name || '').trim().slice(0, 100);
      if (!name || /\s/.test(name)) return sendJSON(res, 400, { error: 'bad skill name' });
      const r = await runHermes(['skills', 'uninstall', name], 'y\n');
      return sendJSON(res, r.code === 0 ? 200 : 500, { ok: r.code === 0, message: (r.out + r.err).slice(-400) });
    });

    /* ---------- L5: 记忆（MEMORY.md / USER.md 直读直写） ---------- */
    router.add('GET', '/api/memory', (req, res) => {
      let memory = '', user = '';
      try { memory = fs.readFileSync(MEMORY_FILE, 'utf8'); } catch {}
      try { user = fs.readFileSync(USER_FILE, 'utf8'); } catch {}
      return sendJSON(res, 200, { memory, user });
    });

    router.add('POST', '/api/memory/save', async (req, res) => {
      const b = JSON.parse(await readBody(req) || '{}');
      const which = b.which === 'user' ? USER_FILE : MEMORY_FILE;
      // 防御：只允许写固定路径的两个记忆文件
      if (which !== MEMORY_FILE && which !== USER_FILE) return sendJSON(res, 400, { error: 'bad target' });
      const content = String(b.content || '');
      if (content.length > 200_000) return sendJSON(res, 400, { error: '内容过大（>200KB）' });
      try {
        fs.mkdirSync(MEMORY_DIR, { recursive: true });
        fs.writeFileSync(which, content, { mode: 0o600 });
        return sendJSON(res, 200, { ok: true });
      } catch (e) {
        return sendJSON(res, 500, { error: e.message });
      }
    });
  },
};
