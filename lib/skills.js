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
const { SKILLS_DIR, SKILL_EMBED_FILE, OLLAMA, EMBED_MODEL } = require('./config');

/* 直扫技能目录（绕开 CLI skills list 的列宽截断，name 保真实完整）
 * 每个技能 = <SKILLS_DIR>/<name>/SKILL.md；额外读 frontmatter 的 name/description，
 * 供前端"点一下注入脚手架"。 */
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
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / ((Math.sqrt(na) * Math.sqrt(nb)) || 1);
}

/* ---------- 索引（内存 + 磁盘双层缓存，按技能集合指纹失效） ---------- */
let skillEmbedCache = null;   // { key, items:[{name,description,vec}] }

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

module.exports = { scanLocalSkills, embedTexts, cosine, ensureSkillIndex };
