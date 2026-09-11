#!/usr/bin/env node
'use strict';

/* ---------- 全局崩溃日志（防止静默死） ----------
 * 之前进程多次崩溃但 stdout/err 无任何错误信息，无法定位原因。
 * 捕获所有未处理异常和 Promise 拒绝，打印完整堆栈到 stderr 再退出。 */
process.on('uncaughtException', (e) => {
  console.error('[FATAL uncaughtException]', e.message);
  console.error(e.stack);
  // 给 stderr 时间刷新再退出（launchd 的 StandardErrorPath 是延迟写入的）
  setTimeout(() => process.exit(1), 100);
});
process.on('unhandledRejection', (reason, p) => {
  console.error('[FATAL unhandledRejection]', p, 'reason:', reason);
  if (reason && reason.stack) console.error(reason.stack);
});

/*
 * 赫尔墨斯特工 · Hermes Web UI 后端 (L3)
 * 无第三方依赖。通过 spawn 调用本地 Hermes CLI 作为引擎，并以 SSE 把
 * Hermes 运行时的「思考 / 工具调用 / 工具结果 / 逐 token 回答」实时推给前端。
 *
 * 实时进度来源（双通道）：
 *   1. token 流（L3 真流式）：oneshot.py 打了补丁 —— 当 HERMES_STREAM_FILE 存在时，
 *      agent.stream_delta_callback 把 assistant 文本 delta 逐块追加到该文件；
 *      本服务 tail 该文件，以 SSE `token` 事件流出。
 *   2. DB 轮询：Hermes 把每条消息写入 ~/.hermes/state.db 的 messages 表，
 *      node:sqlite 只读长连接 + WAL 模式，把新增行作为 SSE `msg` 事件流出。
 *
 * 云端 API 后端（L3）：Hermes 内置 provider 注册表（deepseek/alibaba/zai/kimi/...），
 * API key 走环境变量注入，无需改 config.yaml。模型名格式 `cloud:<providerId>/<model>`；
 * 发起对话前做健康检查（chat/completions max_tokens=1），失败自动降级本地 hermes-local。
 *
 * 安全模型：
 *   1. 所有 /api/* 请求需 Bearer token（启动时生成/读取，存 ~/.hermes/ui_token）。
 *   2. Hermes 高风险命令由 pre_tool_call hook（hooks/safety_check.py）拦截。
 *      用户在前端批准后，本次请求带 allowDangerous=true → 注入 HERMES_UI_BYPASS_SAFETY=1。
 *   3. 静态文件用 path.resolve + path.relative 防路径穿越。
 *   4. 请求体上限 100KB，prompt 截断到 8000 字符。
 *   5. 云端 key 明文存 ~/.hermes/cloud_providers.json（0600），API 返回时打码。
 *
 * 关键约束（来自部署实践）：
 *   - 必须删除 PYTHONPATH —— WorkBuddy 注入的 sitecustomize 会劫持 mkdir。
 *   - 本地请求必须 NO_PROXY=127.0.0.1,localhost，否则被代理拦截返回 502。
 *   - -z（oneshot）模式内部强制 yolo，故 --yolo 标志本身无意义；安全靠 hook。
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
// P1-3 拆分第一步：纯解析层抽到 lib/parse.js（零副作用、可 node:test 直测）
const P = require('./lib/parse');
const {
  warnIfParseEmpty, parseSessions, parseCronList, parseMcpList, kbParseBlocks,
} = P;

const PORT = process.env.PORT || 4173;
const HOST = process.env.HOST || '127.0.0.1';   // D4: 局域网访问设 HOST=0.0.0.0（token 认证已就位）
const HOME = process.env.HOME;
const WORKSPACE = process.env.HERMES_WORKSPACE || __dirname;
// 本地知识库检索（方案乙）：自动召回历史经验，注入新会话 prompt
// P2-9: Python 路径运行时解析 —— 实现已移至 lib/parse.js（可单测）
const KB_PYTHON = P.resolvePython(HOME);
const KB_SCRIPT = path.join(WORKSPACE, 'kb', 'kb.py');
const HERMES = `${HOME}/.hermes/venvs/hermes/bin/hermes`;
const DB_PATH = `${HOME}/.hermes/state.db`;
const SKILLS_DIR = `${HOME}/.hermes/skills`;
const PUBLIC_DIR = path.join(WORKSPACE, 'public');
const TOKEN_FILE = `${HOME}/.hermes/ui_token`;
const CLOUD_FILE = `${HOME}/.hermes/cloud_providers.json`;
const OLLAMA = 'http://127.0.0.1:11434';
// 2026-09-10 换装 gemma4:e4b：一个多模态模型同时承担对话/工具/视觉/音频。
// 列表为「偏好序」，实际下拉在 /api/models 里与已装模型取交集（避免列出不存在的模型）。
// 注意：这里只放「确实装过」的模型。/api/tags 不可达时会直接回退到本列表，
// 列了不存在的模型 → 下拉里出现选了就报错的幽灵项（qwen2.5:7b / hermes-local 已删除，勿再加回）。
const LOCAL_MODELS = ['hermes-local-gemma4', 'gemma4:e4b'];
const DEFAULT_MODEL = 'hermes-local-gemma4';
const BODY_LIMIT = 100 * 1024;   // 100 KB
const PROMPT_LIMIT = 8000;        // 字符
const POLL_MS = 150;              // DB / stream 文件轮询周期
const KEEP_ALIVE = '2h';          // Ollama 模型驻留时长

/* ---------- D2: launchd 捕获日志健康守护 ----------
 * launchd 的 StandardOutPath/StandardErrorPath 无内置轮转；崩溃循环可能写爆磁盘。
 * 服务启动时检查：单文件超 10MB 则截断保留尾部 1MB（防呆，正常只有几 KB）。 */
const LOG_FILES = [
  `${HOME}/Library/Logs/hermes-ui.out.log`,
  `${HOME}/Library/Logs/hermes-ui.err.log`,
];
function trimOversizedLogs() {
  try {
    for (const f of LOG_FILES) {
      if (!fs.existsSync(f)) continue;
      const st = fs.statSync(f);
      if (st.size > 10 * 1024 * 1024) {
        const fd = fs.openSync(f, 'r+');
        const tail = 1024 * 1024;
        const buf = Buffer.alloc(tail);
        fs.readSync(fd, buf, 0, tail, st.size - tail);
        fs.ftruncateSync(fd, tail);
        fs.writeSync(fd, buf, 0, tail, 0);
        fs.closeSync(fd);
        console.log(`[log] ${f} 超 10MB，已截断保留尾部 1MB`);
      }
    }
  } catch (e) { /* 日志守护失败不影响服务 */ }
}

/* ---------- B1: 上传文件生命周期 ----------
 * /api/upload 只进不出会慢慢吃磁盘：启动时 + 每 24h 清扫一次，
 * 删除 mtime 超过 UPLOAD_RETENTION_DAYS 的文件（默认 7 天）。失败不影响服务。 */
const UPLOADS_DIR = `${HOME}/.hermes/uploads`;
const UPLOAD_RETENTION_DAYS = 7;
function cleanStaleUploads() {
  try {
    if (!fs.existsSync(UPLOADS_DIR)) return;
    const cutoff = Date.now() - UPLOAD_RETENTION_DAYS * 86400 * 1000;
    let removed = 0;
    for (const f of fs.readdirSync(UPLOADS_DIR)) {
      const p = path.join(UPLOADS_DIR, f);
      try {
        if (fs.statSync(p).isFile() && fs.statSync(p).mtimeMs < cutoff) {
          fs.unlinkSync(p);
          removed++;
        }
      } catch { /* 单个文件失败跳过 */ }
    }
    if (removed) console.log(`[uploads] 清扫过期上传文件 ${removed} 个（>${UPLOAD_RETENTION_DAYS} 天）`);
  } catch (e) { /* 清扫失败不影响服务 */ }
}

const active = new Map(); // runId|sessionId -> child process

/* ---------- 云端 provider 预设（对齐 Hermes 内置注册表 hermes_cli/auth.py） ---------- */
const PROVIDER_PRESETS = {
  'deepseek':       { label: 'DeepSeek',       env: 'DEEPSEEK_API_KEY',  baseEnv: 'DEEPSEEK_BASE_URL',  base: 'https://api.deepseek.com/v1' },
  'alibaba':        { label: '通义千问 Qwen',   env: 'DASHSCOPE_API_KEY', baseEnv: 'DASHSCOPE_BASE_URL', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  'zai':            { label: '智谱 GLM',       env: 'GLM_API_KEY',       baseEnv: 'GLM_BASE_URL',       base: 'https://open.bigmodel.cn/api/paas/v4' },
  'kimi-coding-cn': { label: 'Kimi (中国)',    env: 'KIMI_CN_API_KEY',   baseEnv: '',                   base: 'https://api.moonshot.cn/v1' },
  'kimi-coding':    { label: 'Kimi (国际)',    env: 'KIMI_API_KEY',      baseEnv: 'KIMI_BASE_URL',      base: 'https://api.moonshot.ai/v1' },
  'xai':            { label: 'xAI Grok',       env: 'XAI_API_KEY',       baseEnv: 'XAI_BASE_URL',       base: 'https://api.x.ai/v1' },
  'openai-api':     { label: 'OpenAI/兼容端点', env: 'OPENAI_API_KEY',    baseEnv: 'OPENAI_BASE_URL',    base: 'https://api.openai.com/v1' },
};

/* ---------- L4: oneshot 流式补丁自愈 ----------
 * 真流式依赖对 ~/.hermes/hermes-agent/hermes_cli/oneshot.py 的一处补丁
 * （HERMES_STREAM_FILE）。`hermes update` 会覆盖该文件，因此每次启动自检：
 * 补丁在 → ok；补丁丢但锚点在 → 自动重打；锚点也没了（版本大变）→ 报告需人工适配。
 */
const ONESHOT_PATH = `${HOME}/.hermes/hermes-agent/hermes_cli/oneshot.py`;
const PATCH_MARKER = 'HERMES_STREAM_FILE';
const PATCH_ANCHOR = '        agent.stream_delta_callback = None\n        agent.tool_gen_callback = None';
const PATCH_REPLACEMENT = `        # Web UI 真流式补丁（由 server.js 自愈写入，hermes update 后会自动重打）：
        # HERMES_STREAM_FILE 存在时，assistant 文本 delta 逐块追加到该文件供 UI tail。
        _ui_stream_file = os.environ.get("HERMES_STREAM_FILE")
        if _ui_stream_file:
            _ui_sf = open(_ui_stream_file, "a", encoding="utf-8")

            def _ui_stream_delta(text):
                if text:
                    try:
                        _ui_sf.write(text)
                        _ui_sf.flush()
                    except Exception:
                        pass

            agent.stream_delta_callback = _ui_stream_delta
        else:
            agent.stream_delta_callback = None
        agent.tool_gen_callback = None`;

function ensureOneshotPatch() {
  try {
    const src = fs.readFileSync(ONESHOT_PATH, 'utf8');
    if (src.includes(PATCH_MARKER)) return { ok: true, applied: false };
    if (!src.includes(PATCH_ANCHOR)) {
      return { ok: false, applied: false, reason: '未找到补丁锚点（Hermes 版本可能已升级，需人工适配流式补丁）' };
    }
    const next = src.replace(PATCH_ANCHOR, PATCH_REPLACEMENT);
    if (next === src) return { ok: false, applied: false, reason: '锚点匹配但替换无效' };
    fs.writeFileSync(ONESHOT_PATH, next, { mode: 0o644 });
    return { ok: true, applied: true };
  } catch (e) {
    return { ok: false, applied: false, reason: e.message };
  }
}

/* ---------- L4: 用量环形日志（最近 60 轮，内存态） ---------- */
const usageLog = [];
function recordUsage(rec) {
  usageLog.push({ ts: Date.now(), ...rec });
  if (usageLog.length > 60) usageLog.shift();
}

/* ---------- L4: Ollama 运行状态（http.get，不引依赖） ----------
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

/* ---------- C4: 多模态理解（图片 / 音频）—— 2026-09-10 改由 gemma4:e4b 原生承担 ----------
 * 旧方案用独立 llava:7b 做视觉，16G 单驻留下「看图 + 推理」必触发 1-2 次模型换载。
 * 现改为与对话共用同一模型（gemma4:e4b 原生多模态）：
 *   1) 看图不再换载（同一个已加载实例直接带 images 请求）；
 *   2) OCR / 图表理解明显强于 llava:7b。
 * 音频同理（gemma4 e2b/e4b 支持音频输入，用于本地语音转写，替代走云端的
 * webkitSpeechRecognition）。base64 媒体放进 messages[].images 字段——Ollama 对
 * 图片/音频用的是同一个字段。
 * 不走 Hermes 主链路（Hermes 是纯文本 agent），识别结果以文本注入对话上下文。
 */
const VISION_MODEL = DEFAULT_MODEL;   // 视觉/音频与对话同模型，杜绝换载
function multimodalAsk(base64Data, prompt, timeoutMs) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: VISION_MODEL,
      messages: [{ role: 'user', content: prompt, images: [base64Data] }],
      stream: false,
      keep_alive: KEEP_ALIVE,
      // OCR/转写不需要推理链：关掉思考可少生成上千 token（gemma4 默认会先吐 1.4k 字思考），
      // 也避免思考占满输出额度导致 message.content 为空。
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

/* ---------- Token 认证 ---------- */
function loadToken() {
  if (process.env.HERMES_TOKEN) return process.env.HERMES_TOKEN;
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
      if (t) return t;
    }
  } catch {}
  const t = crypto.randomBytes(24).toString('hex');
  try { fs.writeFileSync(TOKEN_FILE, t, { mode: 0o600 }); } catch {}
  return t;
}
const TOKEN = loadToken();
function checkAuth(req) {
  const h = req.headers['authorization'] || '';
  return h.startsWith('Bearer ') && h.slice(7) === TOKEN;
}

/* ---------- Hermes 环境 ---------- */
function hermesEnv(opts = {}) {
  const env = { ...process.env };
  delete env.PYTHONPATH;
  env.NO_PROXY = '127.0.0.1,localhost';
  env.no_proxy = '127.0.0.1,localhost';
  env.http_proxy = ''; env.https_proxy = '';
  env.HTTP_PROXY = ''; env.HTTPS_PROXY = '';
  // 用户批准后放行本次请求的高风险命令
  if (opts.allowDangerous) env.HERMES_UI_BYPASS_SAFETY = '1';
  // L3 真流式：oneshot.py 补丁读取该路径，逐块追加 assistant 文本 delta
  if (opts.streamFile) env.HERMES_STREAM_FILE = opts.streamFile;
  // L3 云端后端：注入 provider API key / 自定义 base_url
  if (opts.extraEnv) Object.assign(env, opts.extraEnv);
  return env;
}

/* ---------- SQLite 只读轮询（长连接 + WAL） ---------- */
let db = null;
function getDB() {
  if (db) return db;
  const { DatabaseSync } = require('node:sqlite');
  db = new DatabaseSync(DB_PATH, { readonly: true });
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}
function withDB(fn) {
  try { return fn(getDB()); } catch (e) { /* 单次查询失败不致命 */ return null; }
}
function latestSessionId() {
  return withDB(d => { const r = d.prepare('SELECT id FROM sessions ORDER BY id DESC LIMIT 1').get(); return r ? r.id : null; });
}
function maxMessageId(sid) {
  return withDB(d => { const r = d.prepare('SELECT max(id) AS m FROM messages WHERE session_id=?').get(sid); return r && r.m ? r.m : 0; }) || 0;
}
function newMessages(sid, afterId) {
  return withDB(d => d.prepare(
    'SELECT id, role, tool_name, content, tool_calls, display_kind, reasoning, timestamp FROM messages WHERE session_id=? AND id>? ORDER BY id'
  ).all(sid, afterId)) || [];
}

// P1-4 解析保鲜告警、P1-3 各解析函数实现均已在 lib/parse.js，顶部统一 require。

function runSessionsList(limit = 30) {
  return new Promise((resolve) => {
    const p = spawn(HERMES, ['sessions', 'list', '--limit', String(limit)], { env: hermesEnv() });
    let out = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', () => {});
    p.on('close', () => {
      const rows = parseSessions(out);
      warnIfParseEmpty('sessions list', out, rows.length);
      resolve(rows);
    });
  });
}

// L4: 通用 hermes 子命令执行（sessions rename/delete 等）
// L5: stdinText 用于自动应答 CLI 的交互确认（如 cron remove 的 y/N）
function runHermes(argsArr, stdinText) {
  return new Promise((resolve) => {
    const p = spawn(HERMES, argsArr, { env: hermesEnv() });
    let out = '', err = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    p.on('close', code => resolve({ code, out, err: (err + out).slice(-500) }));
    if (stdinText != null) { p.stdin.write(stdinText); p.stdin.end(); }
  });
}

/* ---------- L5: 工具箱（MCP / 定时任务 / 技能 / 记忆） ---------- */
const MEMORY_DIR = `${HOME}/.hermes/memories`;
const MEMORY_FILE = `${MEMORY_DIR}/MEMORY.md`;
const USER_FILE = `${MEMORY_DIR}/USER.md`;

// cron list 解析（parseCronList）已在 lib/parse.js

// 直扫技能目录（绕开 CLI skills list 的列宽截断，name 保真实完整）
// 每个技能 = <SKILLS_DIR>/<name>/SKILL.md；额外读 frontmatter 的 name/description 供"点一下注入脚手架"
function scanLocalSkills() {
  const skills = [];
  let entries = [];
  try { entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true }); } catch { return skills; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const md = path.join(SKILLS_DIR, e.name, 'SKILL.md');
    if (!fs.existsSync(md)) continue;
    let name = e.name, description = '';
    try {
      const raw = fs.readFileSync(md, 'utf8').slice(0, 2500);
      const m = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
      if (m) {
        const g = m[1].match(/^name:\s*['"]?([^'"\n]+)['"]?$/m); if (g) name = g[1].trim();
        const d = m[1].match(/^(?:description|summary):\s*['"]?([^'"\n]+)['"]?$/m); if (d) description = d[1].trim().slice(0, 220);
      }
    } catch {}
    skills.push({ name, category: '', source: 'local', trust: 'local', status: 'enabled', description });
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

/* ---------- 技能语义检索（bge-m3 本地嵌入）----------
 * 用本地 bge-m3（纯文本嵌入模型，1024 维）给「技能名 + 描述」建向量索引，让
 * "帮我看张图 / 写个爬虫" 这种自然语言能直接命中技能，而不是靠字面匹配。
 * 索引按技能集合指纹在内存 + 磁盘缓存；技能增删后指纹变化即自动重建。
 * 若 bge-m3 未安装/不可用 → 返回空索引，前端降级为字面过滤。
 */
const EMBED_MODEL = 'bge-m3';
const SKILL_EMBED_FILE = `${HOME}/.hermes/.skill_embeddings.json`;
let skillEmbedCache = null;   // { key, items:[{name,description,vec}] }

function embedTexts(texts) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ model: EMBED_MODEL, input: texts, keep_alive: '30m' });
    const req = http.request(OLLAMA + '/api/embed', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout: 120000
    }, (r) => {
      let buf = '';
      r.on('data', d => buf += d);
      r.on('end', () => {
        try {
          const j = JSON.parse(buf);
          const arr = j.embeddings || (j.embedding ? [j.embedding] : null);
          resolve(Array.isArray(arr) && arr.length ? arr : null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end(body);
  });
}
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / ((Math.sqrt(na) * Math.sqrt(nb)) || 1);
}
async function ensureSkillIndex() {
  const skills = scanLocalSkills();
  const key = crypto.createHash('sha1')
    .update(skills.map(s => s.name + '|' + (s.description || '')).join('\n')).digest('hex');
  if (skillEmbedCache && skillEmbedCache.key === key) return skillEmbedCache;
  if (!skillEmbedCache) {                      // 首次：尝试磁盘缓存（跨重启复用）
    try {
      const j = JSON.parse(fs.readFileSync(SKILL_EMBED_FILE, 'utf8'));
      if (j.key === key && Array.isArray(j.items) && j.items.length) { skillEmbedCache = j; return j; }
    } catch {}
  }
  const inputs = skills.map(s => `${s.name}\n${s.description || ''}`.trim());
  const vecs = await embedTexts(inputs);
  if (!vecs) return { key, items: [] };        // 嵌入不可用 → 空索引（前端降级）
  const items = skills
    .map((s, i) => ({ name: s.name, description: s.description || '', vec: vecs[i] || [] }))
    .filter(x => x.vec.length);
  skillEmbedCache = { key, items };
  try { fs.writeFileSync(SKILL_EMBED_FILE, JSON.stringify(skillEmbedCache), { mode: 0o600 }); } catch {}
  return skillEmbedCache;
}

// skills list / mcp list 解析（parseSkillsList / parseMcpList）已在 lib/parse.js
// 注：parseSkillsList 当前无调用方（技能走 scanLocalSkills 直扫目录），保留在 lib 层备查。

const SESSION_ID_RE = /^\d{8}_\d{6}_[0-9a-f]{6}$/;

// L4: 由 state.db 消息直接生成会话 Markdown（不依赖 hermes export 的文件落盘行为）
function buildSessionMarkdown(sid, rows) {
  const lines = [`# Hermes 会话 ${sid}`, '', `> 导出时间：${new Date().toLocaleString()}`, ''];
  for (const r of rows) {
    if (r.role === 'user') {
      lines.push('## 👤 用户', '', String(r.content || '').trim(), '');
    } else if (r.role === 'assistant') {
      if (r.tool_calls) {
        try {
          const calls = JSON.parse(r.tool_calls);
          for (const c of (Array.isArray(calls) ? calls : [calls])) {
            const f = c.function || c;
            const name = f.name || 'tool';
            let args = f.arguments;
            if (typeof args === 'string') { try { args = JSON.parse(args); } catch {} }
            const cmd = (args && (args.command || args.path || args.file_path)) || '';
            lines.push(`### 🔧 工具调用：${name}`, '', '```', String(cmd || JSON.stringify(args)), '```', '');
          }
        } catch {}
      }
      if (r.content && String(r.content).trim()) lines.push('## 🤖 助手', '', String(r.content).trim(), '');
    } else if (r.role === 'tool') {
      let out = r.content || '';
      try {
        const c = JSON.parse(out);
        out = c.output != null ? String(c.output) : (c.error ? '错误: ' + c.error : JSON.stringify(c, null, 1));
      } catch {}
      lines.push('<details><summary>工具结果</summary>', '', '```', String(out).slice(0, 4000), '```', '', '</details>', '');
    }
  }
  return lines.join('\n');
}

/* ---------- 云端 provider 配置存储 ---------- */
function loadCloudProviders() {
  try {
    const raw = JSON.parse(fs.readFileSync(CLOUD_FILE, 'utf8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw; // {id: {apiKey, baseUrl, models[]}}
  } catch {}
  return {};
}
function saveCloudProviders(map) {
  fs.writeFileSync(CLOUD_FILE, JSON.stringify(map, null, 2), { mode: 0o600 });
}
function maskKey(k) {
  const s = String(k || '');
  if (!s) return '';
  return s.length <= 8 ? '****' : s.slice(0, 4) + '****' + s.slice(-4);
}

/* ---------- 云端健康检查（60s 缓存） ---------- */
const healthCache = new Map(); // id -> {ok, ts, latencyMs, error}
async function providerHealth(id, cfg, force = false) {
  const cached = healthCache.get(id);
  if (!force && cached && Date.now() - cached.ts < 60_000) return cached;
  const preset = PROVIDER_PRESETS[id] || {};
  const base = (cfg.baseUrl || preset.base || '').replace(/\/+$/, '');
  const result = { ok: false, ts: Date.now(), latencyMs: 0, error: '' };
  const t0 = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    const r = await fetch(base + '/chat/completions', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.apiKey },
      body: JSON.stringify({ model: (cfg.models && cfg.models[0]) || 'test', messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false })
    });
    clearTimeout(timer);
    result.latencyMs = Date.now() - t0;
    if (r.status === 200) result.ok = true;
    else if (r.status === 401 || r.status === 403) result.error = 'API key 无效 (' + r.status + ')';
    else if (r.status === 404) result.error = '模型不存在或路径错误 (404)';
    else if (r.status === 429) { result.ok = true; result.error = '限流中，但可达'; } // 429 = 可达
    else result.error = 'HTTP ' + r.status;
  } catch (e) {
    result.latencyMs = Date.now() - t0;
    result.error = e.name === 'AbortError' ? '连接超时 (10s)' : ('网络错误: ' + e.message);
  }
  healthCache.set(id, result);
  return result;
}

/* ---------- 模型解析 ---------- */
// 'hermes-local' → {cloud:false, model:'hermes-local'}
// 'cloud:deepseek/deepseek-chat' → {cloud:true, providerId:'deepseek', model:'deepseek-chat'}
function resolveModel(value) {
  const v = String(value || '');
  if (v.startsWith('cloud:')) {
    const rest = v.slice(6);
    const slash = rest.indexOf('/');
    if (slash > 0) {
      const providerId = rest.slice(0, slash);
      const model = rest.slice(slash + 1);
      if (PROVIDER_PRESETS[providerId] && model) return { cloud: true, providerId, model };
    }
  }
  return { cloud: false, model: LOCAL_MODELS.includes(v) ? v : DEFAULT_MODEL };
}

/* ---------- Ollama 模型保活 ---------- */
function prewarmOllama(model) {
  const body = JSON.stringify({ model, keep_alive: KEEP_ALIVE });
  const req = http.request(OLLAMA + '/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' } }, () => {});
  req.on('error', () => {});
  req.end(body);
}

function sendJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function sse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/* ---------- 静态文件（防路径穿越） ---------- */
function serveStatic(req, res) {
  const urlPath = (req.url.split('?')[0] === '/') ? '/index.html' : req.url.split('?')[0];
  const decoded = decodeURIComponent(urlPath);
  // 去掉前导 /，避免 path.resolve 把它当绝对路径（/ → 根目录）
  const relative = decoded.startsWith('/') ? decoded.slice(1) : decoded;
  // path.resolve 把 .. 折叠，再用 path.relative 确认结果仍在 PUBLIC_DIR 内
  const resolved = path.resolve(PUBLIC_DIR, relative);
  const rel = path.relative(PUBLIC_DIR, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  fs.readFile(resolved, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    const ext = path.extname(resolved).toLowerCase();
    const ct = ext === '.html' ? 'text/html; charset=utf-8'
      : ext === '.js' ? 'text/javascript; charset=utf-8'
      : ext === '.css' ? 'text/css; charset=utf-8'
      : ext === '.json' ? 'application/json; charset=utf-8'
      : ext === '.svg' ? 'image/svg+xml'
      : ext === '.png' ? 'image/png'
      : ext === '.ico' ? 'image/x-icon'
      : 'application/octet-stream';
    // HTML 不缓存，保证 UI 更新刷新即生效；静态资源短缓存
    const headers = { 'Content-Type': ct };
    if (ext === '.html') headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
    else headers['Cache-Control'] = 'max-age=300';
    let body = data;
    if (ext === '.html' && data.includes('__UI_VERSION__')) {
      // 版本戳 = index.html 的 mtime：老浏览器无视 no-store 缓存旧页面时，
      // 页面自身可对比 /api/health 的 uiVersion 弹"点击刷新"提示条
      try {
        const ver = String(fs.statSync(resolved).mtimeMs);
        // 只替换带引号的字符串字面量，避免误伤 window.__UI_VERSION__ 变量名
        body = Buffer.from(data.toString('utf8').split("'__UI_VERSION__'").join("'" + ver + "'"));
        headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
      } catch { /* 版本戳失败按原样返回 */ }
    }
    res.writeHead(200, headers);
    res.end(body);
  });
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const max = limit || BODY_LIMIT;
    let buf = '';
    req.on('data', d => {
      buf += d;
      if (buf.length > max) { req.destroy(); reject(new Error('body too large')); }
    });
    req.on('end', () => resolve(buf));
    req.on('error', reject);
  });
}

/* ---------- token 流 tail ----------
 * stream file 由 oneshot 补丁逐块追加。轮询 stat：文件增长 → 读出增量字节，
 * 以 SSE `token` 事件推送。读按 UTF-8 边界安全处理（丢弃尾部不完整多字节序列）。
 */
function tailStreamFile(file, offsetRef, onText) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return;
    if (st.size <= offsetRef.pos) return;
    fs.open(file, 'r', (err2, fd) => {
      if (err2) return;
      const len = st.size - offsetRef.pos;
      const buf = Buffer.alloc(len);
      fs.read(fd, buf, 0, len, offsetRef.pos, (err3) => {
        fs.close(fd, () => {});
        if (err3) return;
        offsetRef.pos = st.size;
        // 丢弃尾部不完整 UTF-8 多字节序列，避免半个汉字渲染成乱码
        let end = buf.length;
        const last = buf[buf.length - 1];
        if (last >= 0xC0) {
          end = buf.length - 1;
        } else if (last >= 0x80) {
          let i = buf.length - 1;
          while (i > 0 && (buf[i] & 0xC0) === 0x80) i--;
          const start = buf[i];
          const seqLen = start >= 0xF0 ? 4 : start >= 0xE0 ? 3 : start >= 0xC0 ? 2 : 1;
          if (buf.length - i < seqLen) end = i;
        }
        const text = buf.subarray(0, end).toString('utf8');
        if (text) onText(text);
      });
    });
  });
}

/* ---------- 本地知识库自动召回（方案乙） ---------- */
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

/* ---------- 知识库查看器（KB Integration: 把 4174 serve.py 能力统一到 4173） ----------
 * viewer.html 本体是只读展示层，真正的"功能"在其后端 serve.py 的 3 个接口。
 * 这里在主服务内复用同一数据源（kb_inbox.md / kb_distilled.md / MEMORY.md）直接实现
 * list / search / status，使赫尔墨斯特工（UI + 智能体）拥有单一可调用的 KB 入口，
 * 不再依赖独立 4174 进程。search 复用已有 recallHits（= kb.py recall）。 */
const KB_INBOX = path.join(WORKSPACE, '.workbuddy', 'kb_inbox.md');
const KB_DISTILLED = path.join(WORKSPACE, '.workbuddy', 'kb_distilled.md');
const KB_MEM_PROJ = path.join(WORKSPACE, '.workbuddy', 'memory', 'MEMORY.md');
const KB_MEM_USER = path.join(HOME, '.workbuddy', 'MEMORY.md');

function _readKB(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } }

// 按标题行切块（原 _kbParseBlocks）实现已移至 lib/parse.js 的 kbParseBlocks（纯函数，可单测）。

// 文件 IO 留在这一层；解析逻辑委托给 lib/parse.js 的 kbListFromBlocks（纯函数，可单测）
function kbListEntries(cat = 'all') {
  return P.kbListFromBlocks({
    inbox: _readKB(KB_INBOX),
    distilled: _readKB(KB_DISTILLED),
    memoryFiles: [KB_MEM_PROJ, KB_MEM_USER]
      .map(p => ({ src: path.relative(WORKSPACE, p), text: _readKB(p) }))
      .filter(m => m.text),
  }, cat);
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
    req.on('timeout', () => { try { req.destroy(); } catch {} resolve({ running: false, models: [] }); });
    req.on('error', () => resolve({ running: false, models: [] }));
  });
}

/* ---------- SSE 聊天端点 ---------- */
async function handleChat(req, res) {
  let body;
  try { body = JSON.parse(req.bodyText || ''); } catch { body = {}; }
  const rawPrompt = (body.prompt || '').trim();
  if (!rawPrompt) { sendJSON(res, 400, { error: 'empty prompt' }); return; }
  // prompt 超长截断，避免把上下文撑爆或被用来打满内存
  const prompt = rawPrompt.length > PROMPT_LIMIT ? rawPrompt.slice(0, PROMPT_LIMIT) + '…' : rawPrompt;
  const allowDangerous = body.allowDangerous === true;
  const runId = crypto.randomUUID();

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('retry: 3000\n\n');

  // ---- 模型解析 + 云端健康检查 + 自动降级 ----
  const chosen = resolveModel(body.model);
  let model = chosen.model;
  let extraEnv = null;
  let providerArgs = [];
  if (chosen.cloud) {
    const providers = loadCloudProviders();
    const cfg = providers[chosen.providerId];
    const preset = PROVIDER_PRESETS[chosen.providerId];
    sse(res, 'notice', { message: `正在检测云端接口 ${preset.label} …` });
    if (!cfg || !cfg.apiKey) {
      sse(res, 'notice', { message: `云端 ${preset.label} 未配置 API key，已降级到本地 ${DEFAULT_MODEL}` });
    } else {
      const hc = await providerHealth(chosen.providerId, cfg);
      if (hc.ok) {
        extraEnv = { [preset.env]: cfg.apiKey };
        if (cfg.baseUrl && preset.baseEnv) extraEnv[preset.baseEnv] = cfg.baseUrl;
        providerArgs = ['--provider', chosen.providerId];
        model = chosen.model;
        sse(res, 'notice', { message: `云端 ${preset.label} 可达 (${hc.latencyMs}ms)，使用 ${chosen.model}` });
      } else {
        sse(res, 'notice', { message: `云端不可达（${hc.error}），已自动降级到本地 ${DEFAULT_MODEL}` });
      }
    }
    if (!providerArgs.length) { chosen.cloud = false; model = DEFAULT_MODEL; }
  }

  const args = [];
  let sessionId = body.sessionId || null;
  if (sessionId) args.push('--resume', sessionId);
  // 新会话：自动召回相关历史经验并前缀进 prompt；
  // 续轮（有 sessionId）已由 Hermes 自带上下文承载，不重复注入，避免噪声。
  let finalPrompt = prompt;
  if (!sessionId) {
    const ctx = await recallContext(prompt);
    if (ctx) finalPrompt = ctx + '\n\n' + prompt;
  }
  // 注意：-z 模式内部强制 yolo，--yolo 标志多余已移除；安全由 pre_tool_call hook 负责。
  args.push('-z', finalPrompt, '--cli', '--in', WORKSPACE);
  args.push('-m', model, ...providerArgs);

  const streamFile = path.join(os.tmpdir(), `hermes-stream-${runId}.txt`);
  const t0 = Date.now();
  const baseline = latestSessionId();           // 用于识别「本次新建」的会话
  let lastMsgId = sessionId ? maxMessageId(sessionId) : 0; // 续轮只推新增消息
  let exited = false;
  let firstTokenMs = null, tokenChars = 0, lastTokenAt = null, toolCallCount = 0;
  const streamOffset = { pos: 0 };

  const child = spawn(HERMES, args, { env: hermesEnv({ allowDangerous, streamFile, extraEnv }), cwd: WORKSPACE });
  active.set(runId, child);
  if (sessionId) active.set(sessionId, child);

  sse(res, 'ready', { runId, sessionId, allowDangerous, model, cloud: chosen.cloud });

  const finish = () => {
    clearInterval(timer);
    if (sessionId) active.delete(sessionId);
    active.delete(runId);
    try { fs.unlink(streamFile, () => {}); } catch {}
  };
  child.on('close', () => { exited = true; });
  child.on('error', e => { exited = true; sse(res, 'error', { message: e.message }); });

  const timer = setInterval(() => {
    try {
      // 1) token 流（真流式，仅本地模型跑 Hermes 引擎时有效）
      tailStreamFile(streamFile, streamOffset, (text) => {
        if (firstTokenMs == null) firstTokenMs = Date.now() - t0;
        lastTokenAt = Date.now();
        tokenChars += text.length;
        sse(res, 'token', { text });
      });
      // 2) DB 轮询（消息行 = 权威记录）
      if (!sessionId) {
        const cur = latestSessionId();
        if (cur && cur !== baseline) { sessionId = cur; sse(res, 'session', { sessionId }); active.set(sessionId, child); }
      }
      if (sessionId) {
        const rows = newMessages(sessionId, lastMsgId);
        for (const r of rows) {
          lastMsgId = r.id;
          if (r.role === 'tool') toolCallCount++;
          sse(res, 'msg', {
            id: r.id, role: r.role, toolName: r.tool_name,
            content: r.content, toolCalls: r.tool_calls,
            displayKind: r.display_kind, reasoning: r.reasoning, ts: r.timestamp
          });
        }
      }
      if (exited) {
        const elapsed = (Date.now() - t0) / 1000;
        // 粗略 tokens/sec：只按生成窗口（首 token → 末 token）计，排除 Hermes 启动耗时
        // 中文 ≈ 1 字/token，英文 ≈ 4 字符/token，取 2.5 折中
        const genWindowSec = firstTokenMs != null && lastTokenAt ? (lastTokenAt - t0 - firstTokenMs) / 1000 : 0;
        const charsPerSec = genWindowSec > 0.5 && tokenChars > 0 ? Math.round(tokenChars / genWindowSec / 2.5) : null;
        sse(res, 'done', {
          elapsed: elapsed.toFixed(1), sessionId,
          firstTokenMs: firstTokenMs != null ? (firstTokenMs / 1000).toFixed(1) : null,
          charsPerSec
        });
        recordUsage({
          sessionId, model, cloud: !!chosen.cloud,
          elapsedSec: Math.round(elapsed * 10) / 10,
          firstTokenSec: firstTokenMs != null ? Math.round(firstTokenMs / 100) / 10 : null,
          tokPerSec: charsPerSec, toolCalls: toolCallCount,
          prompt: prompt.slice(0, 60)
        });
        finish();
        res.end();
        // 本地模型保活：运行结束后把驻留时间续到 2h
        if (!chosen.cloud) prewarmOllama(model);
      }
    } catch (e) { /* 忽略单次轮询异常 */ }
  }, POLL_MS);

  req.on('close', () => {
    clearInterval(timer);
    if (!exited) { try { child.kill('SIGTERM'); } catch {} }
    try { fs.unlink(streamFile, () => {}); } catch {}
    try { res.end(); } catch {}
  });
}

const server = http.createServer(async (req, res) => {
  try {
    // ---------- KB Integration: 知识库查看器（公开、只读、仅 127.0.0.1）----------
    // 与静态文件同级、认证前暴露：viewer.html 是只读内部页面，原 4174 服务也无认证。
    if (req.method === 'GET' && (req.url === '/kb' || req.url.startsWith('/kb/'))) {
      return fs.readFile(path.join(WORKSPACE, 'kb', 'viewer.html'), (err, data) => {
        if (err) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
        res.end(data);
      });
    }
    if (req.method === 'GET' && req.url.startsWith('/api/kb/list')) {
      const m = (req.url.split('?')[1] || '').match(/(?:^|&)cat=([^&]*)/);
      return sendJSON(res, 200, kbListEntries(m ? decodeURIComponent(m[1]) : 'all'));
    }
    if (req.method === 'GET' && req.url.startsWith('/api/kb/search')) {
      const m = (req.url.split('?')[1] || '').match(/(?:^|&)q=([^&]*)/);
      const q = m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : '';
      const hits = q ? recallHits(q) : [];
      const results = hits.slice(0, 50).map(h => ({ cat: 'search', type: h.section || '', src: h.source || '', text: h.text || '', score: h.score }));
      return sendJSON(res, 200, { query: q, count: results.length, results });
    }
    if (req.method === 'GET' && req.url.startsWith('/api/kb/status')) {
      const entries = kbListEntries('all');
      const counts = { inbox: 0, distilled: 0, memory: 0 };
      for (const e of entries) if (e.cat in counts) counts[e.cat]++;
      const ollama = await ollamaStatusSync();
      return sendJSON(res, 200, { kb_port: PORT, counts, total: entries.length, ollama });
    }

    // 静态文件无需认证（登录页要能加载）
    if (req.method === 'GET' && !req.url.startsWith('/api/')) {
      return serveStatic(req, res);
    }
    // 所有 /api/* 必须带 token
    if (!checkAuth(req)) {
      return sendJSON(res, 401, { error: 'unauthorized' });
    }

    if (req.method === 'GET' && req.url.startsWith('/api/sessions')) {
      return sendJSON(res, 200, { sessions: await runSessionsList(30) });
    }
    if (req.method === 'GET' && req.url.startsWith('/api/history')) {
      const u = new URL(req.url, 'http://127.0.0.1');
      const sid = (u.searchParams.get('session') || '').trim();
      if (!sid) return sendJSON(res, 400, { error: 'session required' });
      const rows = withDB(d => d.prepare(
        'SELECT id, role, tool_name, content, tool_calls, display_kind, reasoning, timestamp FROM messages WHERE session_id=? ORDER BY id'
      ).all(sid)) || [];
      return sendJSON(res, 200, { sessionId: sid, messages: rows });
    }
    // L4: 会话重命名
    if (req.method === 'POST' && req.url.startsWith('/api/session/rename')) {
      const b = JSON.parse(await readBody(req) || '{}');
      const sid = String(b.id || '').trim();
      const title = String(b.title || '').trim();
      if (!SESSION_ID_RE.test(sid)) return sendJSON(res, 400, { error: 'bad session id' });
      if (!title || title.length > 80) return sendJSON(res, 400, { error: '标题需 1-80 字符' });
      const r = await runHermes(['sessions', 'rename', sid, title]);
      return sendJSON(res, r.code === 0 ? 200 : 500, r.code === 0 ? { ok: true } : { error: 'rename failed: ' + r.err });
    }
    // L4: 会话删除
    if (req.method === 'POST' && req.url.startsWith('/api/session/delete')) {
      const b = JSON.parse(await readBody(req) || '{}');
      const sid = String(b.id || '').trim();
      if (!SESSION_ID_RE.test(sid)) return sendJSON(res, 400, { error: 'bad session id' });
      const r = await runHermes(['sessions', 'delete', sid, '--yes']);
      return sendJSON(res, r.code === 0 ? 200 : 500, r.code === 0 ? { ok: true } : { error: 'delete failed: ' + r.err });
    }
    // L4: 导出会话 Markdown（附件下载）
    if (req.method === 'GET' && req.url.startsWith('/api/session/export')) {
      const u = new URL(req.url, 'http://127.0.0.1');
      const sid = (u.searchParams.get('session') || '').trim();
      if (!SESSION_ID_RE.test(sid)) return sendJSON(res, 400, { error: 'bad session id' });
      const rows = withDB(d => d.prepare(
        'SELECT role, tool_name, content, tool_calls, timestamp FROM messages WHERE session_id=? ORDER BY id'
      ).all(sid)) || [];
      res.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="hermes-${sid}.md"`
      });
      return res.end(buildSessionMarkdown(sid, rows));
    }
    // L4: 健康（含流式补丁状态）
    if (req.method === 'GET' && req.url.startsWith('/api/health')) {
      let uiVersion = null;
      try { uiVersion = String(fs.statSync(path.join(PUBLIC_DIR, 'index.html')).mtimeMs); } catch { /* 版本探测失败不阻断 */ }
      return sendJSON(res, 200, { ok: true, uptimeSec: Math.round(process.uptime()), patch: patchState, uiVersion });
    }
    // L4: Ollama 运行状态
    if (req.method === 'GET' && req.url.startsWith('/api/status')) {
      return sendJSON(res, 200, { ollama: await ollamaStatus() });
    }
    // L4: 近轮用量
    if (req.method === 'GET' && req.url.startsWith('/api/usage')) {
      return sendJSON(res, 200, { runs: usageLog.slice(-30).reverse() });
    }
    if (req.method === 'GET' && req.url.startsWith('/api/models')) {
      const providers = loadCloudProviders();
      // 只列真实已装的本地模型（与 /api/tags 取交集），避免下拉出现不存在的模型。
      // 纯 embedding 模型（bge-m3 等，capabilities 仅含 embedding）排除在对话下拉外。
      const norm = s => String(s || '').replace(/:latest$/, '');
      const tags = await ollamaGet('/api/tags');
      let local;
      if (tags && Array.isArray(tags.models)) {
        const chatModels = tags.models
          .filter(m => !(m.capabilities || []).includes('embedding'))
          .map(m => m.name);
        const chatSet = new Set(chatModels.map(norm));
        const seen = new Set();
        local = [];
        for (const m of LOCAL_MODELS) {            // 偏好序优先
          if (chatSet.has(norm(m)) && !seen.has(norm(m))) { local.push({ value: norm(m), label: norm(m) }); seen.add(norm(m)); }
        }
        for (const m of chatModels) {              // 其余已装模型补在后面
          if (!seen.has(norm(m))) { local.push({ value: m, label: m }); seen.add(norm(m)); }
        }
      } else {
        local = LOCAL_MODELS.map(m => ({ value: m, label: m }));
      }
      const cloud = [];
      for (const [id, cfg] of Object.entries(providers)) {
        const preset = PROVIDER_PRESETS[id];
        if (!preset || !cfg.apiKey) continue;
        for (const m of (cfg.models || [])) {
          if (m) cloud.push({ value: `cloud:${id}/${m}`, label: `${preset.label} · ${m}` });
        }
      }
      return sendJSON(res, 200, { local, cloud, default: DEFAULT_MODEL });
    }
    if (req.method === 'GET' && req.url.startsWith('/api/providers')) {
      const providers = loadCloudProviders();
      const out = {};
      for (const [id, cfg] of Object.entries(providers)) {
        out[id] = {
          label: (PROVIDER_PRESETS[id] || {}).label || id,
          apiKeyMasked: maskKey(cfg.apiKey),
          hasKey: !!cfg.apiKey,
          baseUrl: cfg.baseUrl || (PROVIDER_PRESETS[id] || {}).base || '',
          models: cfg.models || [],
          health: healthCache.get(id) || null
        };
      }
      return sendJSON(res, 200, { providers: out, presets: PROVIDER_PRESETS });
    }
    if (req.method === 'POST' && req.url.startsWith('/api/providers/save')) {
      const b = JSON.parse(await readBody(req) || '{}');
      const id = String(b.id || '').trim();
      if (!PROVIDER_PRESETS[id]) return sendJSON(res, 400, { error: 'unknown provider id' });
      const providers = loadCloudProviders();
      const prev = providers[id] || {};
      providers[id] = {
        apiKey: (b.apiKey && String(b.apiKey).trim()) || prev.apiKey || '',
        baseUrl: (b.baseUrl != null ? String(b.baseUrl).trim() : prev.baseUrl || ''),
        models: Array.isArray(b.models) ? b.models.map(s => String(s).trim()).filter(Boolean) : (prev.models || [])
      };
      if (!providers[id].apiKey) return sendJSON(res, 400, { error: 'apiKey required' });
      saveCloudProviders(providers);
      return sendJSON(res, 200, { ok: true, apiKeyMasked: maskKey(providers[id].apiKey) });
    }
    if (req.method === 'POST' && req.url.startsWith('/api/providers/delete')) {
      const b = JSON.parse(await readBody(req) || '{}');
      const providers = loadCloudProviders();
      delete providers[b.id];
      saveCloudProviders(providers);
      return sendJSON(res, 200, { ok: true });
    }
    if (req.method === 'POST' && req.url.startsWith('/api/provider/health')) {
      const b = JSON.parse(await readBody(req) || '{}');
      const providers = loadCloudProviders();
      const cfg = providers[b.id];
      if (!cfg) return sendJSON(res, 404, { error: 'provider not configured' });
      const hc = await providerHealth(b.id, cfg, true);
      return sendJSON(res, 200, hc);
    }
    if (req.method === 'POST' && req.url.startsWith('/api/prewarm')) {
      const b = JSON.parse(await readBody(req) || '{}');
      const m = resolveModel(b.model);
      if (m.cloud) return sendJSON(res, 200, { ok: false, error: '云端模型无需预热' });
      prewarmOllama(m.model);
      return sendJSON(res, 200, { ok: true, model: m.model });
    }
    // C4: 多模态理解（body 上限放宽到 8MB，容纳压缩后的 base64 图/音频）
    if (req.method === 'POST' && req.url.startsWith('/api/vision')) {
      const raw = await readBody(req, 8 * 1024 * 1024);
      let b = {};
      try { b = JSON.parse(raw || '{}'); } catch { return sendJSON(res, 400, { error: 'bad json' }); }
      const img = String(b.image || '');
      if (!img) return sendJSON(res, 400, { error: 'image required' });
      const r = await describeImage(img, String(b.prompt || '').slice(0, 500));
      return sendJSON(res, r.ok ? 200 : 502, r.ok ? { text: r.text } : { error: r.error });
    }
    // 本地语音转写：前端录音（WAV base64）→ gemma4:e4b 原生音频 → 文字。
    // 替代走云端的 webkitSpeechRecognition，音频不出本机（local-first）。
    if (req.method === 'POST' && req.url.startsWith('/api/transcribe')) {
      const raw = await readBody(req, 16 * 1024 * 1024);
      let b = {};
      try { b = JSON.parse(raw || '{}'); } catch { return sendJSON(res, 400, { error: 'bad json' }); }
      const audio = String(b.audio || '');
      if (!audio) return sendJSON(res, 400, { error: 'audio required' });
      const r = await transcribeAudio(audio);
      return sendJSON(res, r.ok ? 200 : 502, r.ok ? { text: r.text } : { error: r.error });
    }
    // B1: 文件上传落盘（大文本/二进制不适合内联 prompt，存 ~/.hermes/uploads 后
    // 把路径注入对话，让 Hermes 用自己的文件工具读取。base64 上限 20MB ≈ 落盘 15MB）
    if (req.method === 'POST' && req.url.startsWith('/api/upload')) {
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
    }
    // 豆包式"为你推荐"：答案完成后用当前模型生成 3 条追问（前台非阻塞调用，失败静默返回空）
    if (req.method === 'POST' && req.url.startsWith('/api/suggest')) {
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
    }
    if (req.method === 'GET' && req.url.startsWith('/api/auth')) {
      return sendJSON(res, 200, { ok: true });
    }
    /* ---------- 知识库 slash 命令 /kb 的召回接口 ---------- */
    if (req.method === 'GET' && req.url.startsWith('/api/kb')) {
      const q = (req.url.split('?')[1] || '');
      const m = q.match(/(?:^|&)q=([^&]*)/);
      const query = m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : '';
      const hits = query ? recallHits(query) : [];
      // 相关性阈值：与自动召回一致，弱相关不返回（前端按"未找到"提示）
      const RECALL_MIN_SCORE = 0.15;
      const filtered = hits.filter(h => (h.score ?? 0) >= RECALL_MIN_SCORE);
      const slim = (filtered.length ? filtered : hits).slice(0, 6).map(h => ({
        section: h.section || '经验', source: h.source || '', text: h.text || '',
        score: typeof h.score === 'number' ? Math.round(h.score * 100) / 100 : h.score,
      }));
      return sendJSON(res, 200, { query, hits: slim, count: slim.length });
    }
    if (req.method === 'POST' && req.url.startsWith('/api/chat')) {
      req.bodyText = await readBody(req);
      return handleChat(req, res);
    }
    if (req.method === 'POST' && req.url.startsWith('/api/stop')) {
      const body = JSON.parse(await readBody(req) || '{}');
      const child = (body.runId && active.get(body.runId)) || (body.sessionId && active.get(body.sessionId));
      if (child) { try { child.kill('SIGTERM'); } catch {} return sendJSON(res, 200, { ok: true }); }
      return sendJSON(res, 200, { ok: false, error: 'no active session' });
    }
    /* ---------- L5: MCP 服务管理 ---------- */
    if (req.method === 'GET' && req.url.startsWith('/api/mcp')) {
      const r = await runHermes(['mcp', 'list']);
      const servers = parseMcpList(r.out);
      warnIfParseEmpty('mcp list', r.out, servers.length);
      return sendJSON(res, 200, { servers, raw: r.out.slice(0, 2000) });
    }
    if (req.method === 'POST' && req.url.startsWith('/api/mcp/add')) {
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
    }
    if (req.method === 'POST' && req.url.startsWith('/api/mcp/remove')) {
      const b = JSON.parse(await readBody(req) || '{}');
      const name = String(b.name || '').trim();
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) return sendJSON(res, 400, { error: 'bad name' });
      const r = await runHermes(['mcp', 'remove', name], 'y\n');
      return sendJSON(res, r.code === 0 ? 200 : 500, { ok: r.code === 0, message: (r.out + r.err).slice(-300) });
    }

    /* ---------- L5: 定时任务 ---------- */
    if (req.method === 'GET' && req.url.startsWith('/api/cron')) {
      const [list, status] = await Promise.all([runHermes(['cron', 'list']), runHermes(['cron', 'status'])]);
      const jobs = parseCronList(list.out);
      warnIfParseEmpty('cron list', list.out, jobs.length);
      return sendJSON(res, 200, {
        jobs,
        gatewayOk: /running|✓/.test(status.out) && !/not running/.test(status.out),
        raw: list.out.slice(0, 3000)
      });
    }
    if (req.method === 'POST' && req.url.startsWith('/api/cron/create')) {
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
    }
    if (req.method === 'POST' && req.url.startsWith('/api/cron/action')) {
      const b = JSON.parse(await readBody(req) || '{}');
      const id = String(b.id || '').trim();
      const action = String(b.action || '');
      if (!/^[0-9a-f]{6,}$/.test(id)) return sendJSON(res, 400, { error: 'bad job id' });
      if (!['pause', 'resume', 'run', 'remove'].includes(action)) return sendJSON(res, 400, { error: 'bad action' });
      // remove 需要交互确认 y
      const r = await runHermes(['cron', action, id], action === 'remove' ? 'y\n' : null);
      return sendJSON(res, r.code === 0 ? 200 : 500, { ok: r.code === 0, message: (r.out + r.err).slice(-300) });
    }

    /* ---------- L5: 技能管理 ---------- */
    if (req.method === 'GET' && req.url.startsWith('/api/skills')) {
      return sendJSON(res, 200, { skills: scanLocalSkills() });
    }
    if (req.method === 'POST' && req.url.startsWith('/api/skills/search')) {
      const b = JSON.parse(await readBody(req) || '{}');
      const q = String(b.query || '').trim().slice(0, 100);
      if (!q) return sendJSON(res, 400, { error: 'query required' });
      const r = await runHermes(['skills', 'search', q]);
      return sendJSON(res, 200, { raw: (r.out || r.err).slice(0, 4000) });
    }
    // 本地语义检索：bge-m3 嵌入 → 余弦相似度 → 返回最相关的已装技能（自然语言找技能）
    if (req.method === 'POST' && req.url.startsWith('/api/skills/find')) {
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
    }
    if (req.method === 'POST' && req.url.startsWith('/api/skills/install')) {
      const b = JSON.parse(await readBody(req) || '{}');
      const name = String(b.name || '').trim().slice(0, 100);
      if (!name || /\s/.test(name)) return sendJSON(res, 400, { error: 'bad skill name' });
      const r = await runHermes(['skills', 'install', name], 'y\n');
      return sendJSON(res, r.code === 0 ? 200 : 500, { ok: r.code === 0, message: (r.out + r.err).slice(-400) });
    }
    if (req.method === 'POST' && req.url.startsWith('/api/skills/uninstall')) {
      const b = JSON.parse(await readBody(req) || '{}');
      const name = String(b.name || '').trim().slice(0, 100);
      if (!name || /\s/.test(name)) return sendJSON(res, 400, { error: 'bad skill name' });
      const r = await runHermes(['skills', 'uninstall', name], 'y\n');
      return sendJSON(res, r.code === 0 ? 200 : 500, { ok: r.code === 0, message: (r.out + r.err).slice(-400) });
    }

    /* ---------- L5: 记忆（MEMORY.md / USER.md 直读直写） ---------- */
    if (req.method === 'GET' && req.url.startsWith('/api/memory')) {
      let memory = '', user = '';
      try { memory = fs.readFileSync(MEMORY_FILE, 'utf8'); } catch {}
      try { user = fs.readFileSync(USER_FILE, 'utf8'); } catch {}
      return sendJSON(res, 200, { memory, user });
    }
    if (req.method === 'POST' && req.url.startsWith('/api/memory/save')) {
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
    }

    sendJSON(res, 404, { error: 'not found' });
  } catch (e) {
    sendJSON(res, 500, { error: e.message });
  }
});

// L4: 启动时自愈 oneshot 流式补丁（hermes update 覆盖后自动重打）
const patchState = ensureOneshotPatch();
// D2: 启动时检查并截断超限的 launchd 捕获日志
trimOversizedLogs();
// B1: 启动清扫过期上传文件，此后每 24h 一次
cleanStaleUploads();
setInterval(cleanStaleUploads, 24 * 3600 * 1000);

server.listen(PORT, HOST, () => {
  console.log(`赫尔墨斯特工 UI → http://${HOST}:${PORT}`);
  // 安全：令牌不落日志（launchd 捕获的日志是明文的）。只给前 4 位便于核对是哪一把，
  // 完整令牌用 `cat ~/.hermes/ui_token` 取。
  console.log(`访问令牌 → ${String(TOKEN).slice(0, 4)}…（完整值见 ${TOKEN_FILE}，勿外传）`);
  console.log(`（令牌已存 ${TOKEN_FILE}，重启不变；可用 HERMES_TOKEN 环境变量覆盖）`);
  if (patchState.ok) {
    console.log(patchState.applied ? '流式补丁：已自动重新注入 oneshot.py ✅' : '流式补丁：oneshot.py 补丁在位 ✅');
  } else {
    console.log(`流式补丁：⚠️ ${patchState.reason}（真流式将不可用，工具调用轮询不受影响）`);
  }
  // P2-9: 打印实际选中的解释器，便于发现"路径腐烂"（托管目录改名/删除）
  if (!fs.existsSync(KB_PYTHON)) {
    console.log(`KB 解释器：⚠️ 不存在 ${KB_PYTHON}（自动召回将降级为无 KB）`);
  } else {
    console.log(`KB 解释器：${KB_PYTHON}`);
  }
});
