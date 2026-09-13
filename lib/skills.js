'use strict';
/* =============================================================================
 * lib/skills.js —— 技能扫描 + 语义检索索引
 *
 * 为什么直扫目录而不解析 `hermes skills list`：CLI 表格会按列宽截断技能名，
 * 截断后的名字没法用来 install/inject。目录扫描拿到的是真名。
 *
 * 语义检索用本地 bge-m3（纯文本嵌入，1024 维）：给「技能名 + 描述」建向量索引，
 * 让"帮我看张图 / 写个爬虫"这类自然语言能直接命中技能，而不是靠字面匹配。
 * 索引按技能集合指纹在内存 + 磁盘缓存；技能增删后指纹变化即自动重建。
 * 若 bge-m3 未安装/不可用 → 返回空索引，前端降级为字面过滤。
 * ========================================================================== */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { SKILLS_DIR, SKILL_EMBED_FILE, OLLAMA, EMBED_MODEL, CONFIG_YAML } = require('./config');

/* ---------- 引擎技能门控（disabled / platform） ----------
 * 引擎在 agent/skill_utils.py 的 get_disabled_skill_names() 里读 config.yaml 的
 * skills.disabled（全局）∪ skills.platform_disabled.<平台>，在注入前过滤。
 * 本文件此前直扫目录、完全不读这份配置 → UI 技能列表/语义检索会列出引擎其实
 * 已禁用的技能，两侧视图漂移。这里补上同一份门控（只读，零依赖，失败降级为空集）。
 * 平台键固定 api_server：Web UI 的会话在引擎侧硬编码 platform="api_server"。
 */
const SKILL_PLATFORM = 'api_server';

// 极简 YAML 子集解析：只取 skills.disabled 与 skills.platform_disabled.<SKILL_PLATFORM> 两个列表。
// 支持块式（- name）与流式（[a, b]）两种写法；节点名含特殊字符或结构异常时静默返回已收集部分。
function readDisabledSkillNames() {
  const out = new Set();
  let text;
  try { text = fs.readFileSync(CONFIG_YAML, 'utf8'); } catch { return out; }

  const addInline = (s) => {
    // 去掉 [] 与引号，按逗号切分
    for (const part of String(s).replace(/^\[|\]$/g, '').split(',')) {
      const v = part.trim().replace(/^['"]|['"]$/g, '');
      if (v) out.add(v);
    }
  };
  const addBlock = (lines, startIdx, indent) => {
    for (let j = startIdx + 1; j < lines.length; j++) {
      const ln = lines[j];
      if (!ln.trim() || /^\s*#/.test(ln)) continue;
      const ind = ln.match(/^\s*/)[0].length;
      if (ind <= indent) break;
      const m = ln.trim().match(/^-\s*(.+)$/);
      if (m) { const v = m[1].trim().replace(/^['"]|['"]$/g, ''); if (v) out.add(v); }
    }
  };

  const lines = text.split(/\r?\n/);
  let inSkills = false, inPlatform = false, platformIndent = -1;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (!ln.trim() || /^\s*#/.test(ln)) continue;
    const ind = ln.match(/^\s*/)[0].length;
    const t = ln.trim();

    if (ind === 0) { inSkills = t === 'skills:'; inPlatform = false; continue; }
    if (!inSkills) continue;

    if (/^disabled:\s*/.test(t)) {
      inPlatform = false;
      const inline = t.replace(/^disabled:\s*/, '');
      if (inline) addInline(inline); else addBlock(lines, i, ind);
      continue;
    }
    if (/^platform_disabled:\s*$/.test(t)) { inPlatform = true; platformIndent = ind; continue; }
    if (inPlatform) {
      const m = t.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (m && ind > platformIndent) {
        if (m[1] === SKILL_PLATFORM) { if (m[2]) addInline(m[2]); else addBlock(lines, i, ind); }
        else inPlatform = false;   // 进入别的平台键 → 停（只关心 api_server）
      }
    }
  }
  return out;
}

// 前端原样呈现 desc 而非 60 字符截断：这些描述被 /api/skills 用于展示与语义检索，不是进 prompt 的索引。

/* 直扫技能目录（绕开 CLI skills list 的列宽截断，name 保真实完整）
 * 每个技能 = <SKILLS_DIR>/<name>/SKILL.md；额外读 frontmatter 的 name/description，
 * 供前端"点一下注入脚手架"。 */
/* 递归收集技能 SKILL.md（镜像引擎 agent/skill_utils.py::iter_skill_index_files 的剪枝规则）：
 *   - 剪掉 VCS/缓存/依赖目录；- 技能包自身的支撑目录（references/templates/assets/scripts）不算独立技能。
 * 为什么必须递归：技能实际按分类子目录组织（如 apple/imessage/SKILL.md），
 * 只扫一层会漏掉绝大多数技能（2026-09-13 实测：本机 194 个里只看到 69 个 = 漏 64%）。 */
const EXCLUDED_SKILL_DIRS = new Set([
  '.git', '.github', '.hub', '.archive', '.curator_backups', '.venv', 'venv',
  'node_modules', 'site-packages', '__pycache__', '.tox', '.nox',
  '.pytest_cache', '.mypy_cache', '.ruff_cache',
]);
const SKILL_SUPPORT_DIRS = new Set(['references', 'templates', 'assets', 'scripts']);

function collectSkillMds(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  const hasSkillMd = entries.some(e => e.isFile() && e.name === 'SKILL.md');
  if (hasSkillMd) out.push(path.join(dir, 'SKILL.md'));
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (EXCLUDED_SKILL_DIRS.has(e.name)) continue;
    if (hasSkillMd && SKILL_SUPPORT_DIRS.has(e.name)) continue;   // 支撑目录不递归
    collectSkillMds(path.join(dir, e.name), out);
  }
}

function scanLocalSkills() {
  const disabled = readDisabledSkillNames();   // 引擎侧禁用名单（config.yaml），失败为空集
  const skills = [];
  const mds = [];
  collectSkillMds(SKILLS_DIR, mds);
  for (const md of mds) {
    const dirName = path.basename(path.dirname(md));
    let name = dirName, description = '', platforms = '';
    try {
      const raw = fs.readFileSync(md, 'utf8').slice(0, 2500);
      const m = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
      if (m) {
        const g = m[1].match(/^name:\s*['"]?([^'"\n]+)['"]?$/m); if (g) name = g[1].trim();
        const d = m[1].match(/^(?:description|summary):\s*['"]?([^'"\n]+)['"]?$/m); if (d) description = d[1].trim().slice(0, 220);
        const p = m[1].match(/^platforms:\s*(.+)$/m); if (p) platforms = p[1].trim();
      }
    } catch { /* 单个技能的 SKILL.md 读不动 → 退化为「目录名 + 无描述」，其余技能不受影响。
                 * 不逐条告警：本函数每次 /api/skills 都会跑一遍，逐条打会重复刷屏。 */ }
    // 门控（镜像引擎，不额外发明规则）：
    //   ① 引擎显式禁用名单命中（按 frontmatter name 匹配，与 get_disabled_skill_names 同口径）；
    //   ② platforms 与本机（darwin）不符 —— 引擎 skill_matches_platform 的硬门控。
    const platformMismatch = !!platforms && !/darwin|macos/i.test(platforms);
    const isDisabled = disabled.has(name) || platformMismatch;
    // 分类 = 相对 SKILLS_DIR 的父路径（如 apple/imessage → 'apple'；顶层技能 → ''）
    const segs = path.relative(SKILLS_DIR, path.dirname(md)).split(path.sep).filter(Boolean);
    const category = segs.length > 1 ? segs.slice(0, -1).join('/') : '';
    skills.push({
      name, category, source: 'local', trust: 'local',
      status: isDisabled ? 'disabled' : 'enabled', description,
      ...(isDisabled ? { disabled: true } : {}),
    });
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

/* ---------- 嵌入调用（失败返回 null，调用方降级） ---------- */
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
  // 维度不一致（如嵌入模型更换/部分失败）时，超出短向量的下标取 undefined → NaN 污染整列，
  // 再经 sort 比较退化成未定义顺序。用短向量长度作上界，空向量自然得 0（中性分），绝不出 NaN。
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / ((Math.sqrt(na) * Math.sqrt(nb)) || 1);
}

/* ---------- 索引（内存 + 磁盘双层缓存，按技能集合指纹失效） ---------- */
let skillEmbedCache = null;   // { key, items:[{name,description,vec}] }

async function ensureSkillIndex() {
  // 与引擎视图一致：引擎已禁用/平台不符的技能不进语义索引，
  // 否则 /api/skills/find 会命中一个引擎实际拿不到的技能。指纹含被过滤集合 →
  // 禁用名单一变指纹即变，磁盘缓存自动重建。
  const skills = scanLocalSkills().filter(s => !s.disabled);
  const key = crypto.createHash('sha1')
    .update(skills.map(s => s.name + '|' + (s.description || '')).join('\n')).digest('hex');
  if (skillEmbedCache && skillEmbedCache.key === key) return skillEmbedCache;
  if (!skillEmbedCache) {                      // 首次：尝试磁盘缓存（跨重启复用）
    try {
      const j = JSON.parse(fs.readFileSync(SKILL_EMBED_FILE, 'utf8'));
      if (j.key === key && Array.isArray(j.items) && j.items.length) { skillEmbedCache = j; return j; }
    } catch { /* 磁盘缓存缺失/损坏 → 落到下面的重新嵌入。属正常分支（首次运行就是这条路径） */ }
  }
  const inputs = skills.map(s => `${s.name}\n${s.description || ''}`.trim());
  const vecs = await embedTexts(inputs);
  if (!vecs) return { key, items: [] };        // 嵌入不可用 → 空索引（前端降级）
  const items = skills
    .map((s, i) => ({ name: s.name, description: s.description || '', vec: vecs[i] || [] }))
    .filter(x => x.vec.length);
  skillEmbedCache = { key, items };
  try { fs.writeFileSync(SKILL_EMBED_FILE, JSON.stringify(skillEmbedCache), { mode: 0o600 }); } catch { /* 缓存写不进去只影响下次启动要重算，不影响本次结果 */ }
  return skillEmbedCache;
}

module.exports = { scanLocalSkills, embedTexts, cosine, ensureSkillIndex, readDisabledSkillNames };
