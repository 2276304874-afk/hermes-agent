'use strict';
/* =============================================================================
 * lib/parse.js —— 纯解析层（零副作用，可单元测试）
 *
 * 为什么单独拆出来：
 *   这些函数原本内联在 server.js 里（1446 行单体），而它们全都是「文本进、数据出」
 *   的纯函数。抽出来之后可以直接被 node:test 覆盖，改一处不必靠手工点 UI 验回归。
 *   server.js 从此只 require 使用，不再持有实现。
 *
 * 设计约定：
 *   - 本文件不读写全局状态、不发网络请求、不 spawn 进程（resolvePython 只做路径探测）。
 *   - 所有函数对非法输入必须「退化」而不是抛错：调用方是 HTTP 请求路径，不能因脏数据 500。
 *   - 解析失败要在「有输出却解析不出东西」时告警（warnIfParseEmpty），不静默装作没事。
 * ========================================================================== */

const fs = require('fs');
const os = require('os');
const path = require('path');

/* ---------- 解析保鲜告警 ---------- */

/* CLI 输出格式保鲜检测。
 * Hermes 升级可能改表格格式 → 正则失配 → 解析静默返回空 → 前端表现成"功能消失了"。
 * 判据：原始输出有实质内容，且不是明确的空态文案，却解析出 0 条 → 记一条告警（只告警，不改行为）。 */
function warnIfParseEmpty(name, raw, count, log = console) {
  if (count > 0) return false;
  const t = String(raw || '').trim();
  if (t.length < 12) return false;                            // 空/极短 → 视为正常空态
  if (/(no |not |none|未|暂无|empty)/i.test(t)) return false;  // 明确的空态文案
  log.warn(`[parse] ⚠ ${name} 解析出 0 条，但 CLI 输出 ${t.length} 字符 —— 疑似输出格式变更。原文前 200 字：${t.slice(0, 200).replace(/\n/g, ' ⏎ ')}`);
  return true;
}

/* ---------- 运行期解释器探测 ---------- */

/* Python 路径运行时解析（防"版本目录改名即腐烂"，同 node 的 22.22.2-2→-3 教训）。
 * 优先级：KB_PYTHON env > 托管 versions/<最高版本>/bin/python3 > homebrew/local > 系统。
 * 硬性要求：解释器必须支持 sqlite FTS5 trigram（kb.py 索引依赖）。
 * 实测 3.13.12(3.50.4) 与 /usr/bin/python3(3.51.0) 均支持，故回退安全。
 * 注意：版本号必须按数值比较——字典序会把 3.9.6 排到 3.13.12 之后。 */
function resolvePython(home = os.homedir(), env = process.env) {
  if (env.KB_PYTHON && fs.existsSync(env.KB_PYTHON)) return env.KB_PYTHON;
  const base = path.join(home, '.workbuddy', 'binaries', 'python', 'versions');
  try {
    const cands = fs.readdirSync(base, { withFileTypes: true })
      .filter(d => d.isDirectory() && /^\d+(\.\d+)*$/.test(d.name))
      .map(d => d.name)
      .filter(n => fs.existsSync(path.join(base, n, 'bin', 'python3')))
      .sort((a, b) => {
        const A = a.split('.').map(Number), B = b.split('.').map(Number);
        for (let i = 0; i < Math.max(A.length, B.length); i++) {
          const d = (B[i] || 0) - (A[i] || 0);
          if (d) return d;
        }
        return 0;
      });
    if (cands.length) return path.join(base, cands[0], 'bin', 'python3');
  } catch (e) { /* 目录不存在 → 继续回退 */ }
  for (const c of ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3']) {
    if (fs.existsSync(c)) return c;
  }
  return 'python3';
}

/* ---------- CLI 文本解析 ---------- */

// 解析 `hermes sessions list` 表格，返回 [{id,title,info}]
// 行形如： <title> <info...> <YYYYMMDD_HHMMSS_xxxxxx>
function parseSessions(text) {
  const rows = [];
  const idRe = /^\d{8}_\d{6}_[0-9a-f]{6}$/;
  for (const line of String(text || '').split('\n')) {
    const tokens = line.trim().split(/\s+/);
    if (tokens.length < 3) continue;
    const id = tokens[tokens.length - 1];
    if (!idRe.test(id)) continue;
    rows.push({ id, title: tokens[0], info: tokens.slice(1, -1).join(' ') });
  }
  return rows;
}

// cron list 文本解析：任务头 "  <id> [state]" + 缩进键值行
function parseCronList(text) {
  const jobs = [];
  let cur = null;
  for (const line of String(text || '').split('\n')) {
    const h = line.match(/^\s{1,6}([0-9a-f]{6,})\s+\[(\w+)\]\s*$/);
    if (h) { if (cur) jobs.push(cur); cur = { id: h[1], state: h[2], name: '', schedule: '', nextRun: '', deliver: '', repeat: '' }; continue; }
    if (!cur) continue;
    let m = line.match(/^\s*Name:\s+(.+)$/);
    if (m) { cur.name = m[1].trim(); continue; }
    m = line.match(/^\s*Schedule:\s+(.+)$/);
    if (m) { cur.schedule = m[1].trim(); continue; }
    m = line.match(/^\s*Next run:\s+(.+)$/);
    if (m) { cur.nextRun = m[1].trim(); continue; }
    m = line.match(/^\s*(Repeat|Deliver|Prompt):\s+(.+)$/);
    if (m) { cur[m[1].toLowerCase()] = m[2].trim(); continue; }
  }
  if (cur) jobs.push(cur);
  return jobs;
}

// skills list 表格解析（表头用 ┃ 粗线，数据行用 │ 细线，两者都要匹配）
// ⚠️ 当前 server.js 的技能列表来自 scanLocalSkills()（直扫目录，name 不会被列宽截断），
//    本函数暂无调用方。保留作为「CLI 表格解析」的备用与回归锚点，勿删。
function parseSkillsList(text) {
  const skills = [];
  for (const line of String(text || '').split('\n')) {
    if (!/[│┃]/.test(line)) continue;
    const cells = line.split(/[│┃]/).map(c => c.trim());
    if (cells.length >= 6 && cells[1] && cells[1] !== 'Name' && !/^[-─]+$/.test(cells[1])) {
      skills.push({ name: cells[1], category: cells[2] || '', source: cells[3] || '', trust: cells[4] || '', status: cells[5] || '' });
    }
  }
  return skills;
}

// MCP list：未配置时是提示文本；已配置时格式未知 → 调用方另返回原始文本兜底
function parseMcpList(text) {
  if (/No MCP servers configured/i.test(text)) return [];
  const servers = [];
  for (const line of String(text || '').split('\n')) {
    const t = line.trim();
    // 宽松匹配：行首为名称，后面跟 url 或 command 线索
    if (!t || /^[┌└├─]|Gateway|MCP server|Add one/i.test(t)) continue;
    const m = t.match(/^([A-Za-z0-9_-]+)\s{2,}(.+)$/);
    if (m) servers.push({ name: m[1], detail: m[2].trim() });
  }
  return servers;
}

/* ---------- 知识库条目解析 ---------- */

// 镜像 kb/serve.py parse_blocks：按标题行切块为条目
function kbParseBlocks(text, cat, headerRe, srcGroup = 1) {
  const out = [];
  if (!text) return out;
  let cur = null, buf = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/\r$/, '');
    const m = headerRe.exec(line);
    if (m) {
      if (cur !== null) { cur.text = buf.join('\n').trim(); out.push(cur); }
      cur = { cat, type: cat, src: (m[srcGroup] || '').trim(), text: '' };
      buf = [];
    } else if (cur !== null) {
      buf.push(line);
    }
  }
  if (cur !== null) { cur.text = buf.join('\n').trim(); out.push(cur); }
  return out;
}

/* 从「已读取的文本」组装 KB 条目列表（纯函数，便于测试；文件 IO 由调用方负责）。
 * inbox/distilled 走标题切块；memoryFiles 每条整体作为一条记忆条目。
 * memoryFiles: [{ src, text }]，src 由调用方预先算好（通常相对工作区）。 */
function kbListFromBlocks({ inbox = '', distilled = '', memoryFiles = [] } = {}, cat = 'all') {
  let res = [];
  res = res.concat(kbParseBlocks(inbox, 'inbox', /^###\s*\[[^\]]*\]\s*(.*)/));
  res = res.concat(kbParseBlocks(distilled, 'distilled', /^##\s*技能（源自\s*(.*)）/));
  for (const m of memoryFiles) {
    if (m && m.text) res.push({ cat: 'memory', type: '记忆', src: m.src, text: m.text });
  }
  if (cat !== 'all') res = res.filter(e => e.cat === cat);
  return res;
}

module.exports = {
  warnIfParseEmpty,
  resolvePython,
  parseSessions,
  parseCronList,
  parseSkillsList,
  parseMcpList,
  kbParseBlocks,
  kbListFromBlocks,
};
