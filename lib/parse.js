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
 *   - 解析失败要在「有输出却解析不出东西」时告警（warnIfParseEmpty），不静默装作没事；
 *     需要把该判定传给前端的场景用 parseResult() 包装，产出 degraded 信号。
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

/* 解析结果包装（P1-4）：把「真的没有数据」与「解析失效」区分开。
 *
 * 为什么需要：各 parse* 遇到 CLI 输出格式变更时，统一表现为「返回空数组」，
 * 前端只能显示"暂无历史会话"——用户分不清是真没有，还是功能坏了（历史上已经
 * 因此误判过两次"功能缺失"）。本函数把 warnIfParseEmpty 的判定结果一并带出，
 * 调用方据此在响应里附加 degraded 标记，前端就能显示告警而不是装作没事。
 *
 * 约定：**不改变各 parse* 的签名**（它们仍是纯函数返回数组，测试与内部调用不受影响），
 * 本函数只做包装。ok=false 表示"有实质输出却解析出 0 条"。
 * 返回：{ ok, items, raw, warning } */
function parseResult(name, raw, items, log = console) {
  const list = Array.isArray(items) ? items : [];
  const degraded = warnIfParseEmpty(name, raw, list.length, log);
  return {
    ok: !degraded,
    items: list,
    raw: raw == null ? '' : String(raw),
    warning: degraded ? `${name} 输出疑似格式变更（有内容但解析出 0 条）` : '',
  };
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

/* 会话 ID 的两种形态，缺一不可：
 *   -z 路径      20260911_173559_3e8110      ← YYYYMMDD_HHMMSS_6位hex
 *   gateway 路径 api_1789152458_78429320    ← api_10位时间戳_8位hex（gateway 后端落地后的主流）
 *   历史遗留     api-278230a76156998c       ← api- 连字号形态
 * 2026-09-12 事故：gateway 切为默认后端后列表里绝大多数会话变成 api_ 形态，
 * 而此处正则只认 Z 前一种，导致「有内容却解析出 0 条」→ /api/sessions 返回 degraded。
 * 大写十六进制仍不合法（既有测试依赖此判据），故字符集限定小写。 */
const SESSION_ID_RE = /^(?:\d{8}_\d{6}_[0-9a-f]{6}|api_[0-9]{6,}_[0-9a-z]{6,}|api-[0-9a-z]{6,32})$/;

// 解析 `hermes sessions list` 表格，返回 [{id,title,info}]
// 行形如： <title(定宽)> <preview|workspace(定宽)> <last active> <id>
//
// 为什么不能简单 `split(/\s+/)`：标题内部本身含空格（'只回复两个字：你好 #b8e8f637'），
// 分词后只剩第一个词，列表里会看到一堆同名项（我们给标题加 #runId 后缀正是为了区分）。
// 为什么也不能按**列号**切片：CLI 按显示宽度对齐，中文占两列，而 JS 的 slice 按字符数，
// 两者必然错位（实测 30 行只切出 1 条）。
// 可行依据：定宽表格用**多个空格**填充列间距，而正文内部是单空格 —— 故按 /\s{2,}/ 分列。
function parseSessions(text) {
  const rows = [];
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^[─—━]+$/.test(trimmed)) continue;                     // 横线分隔符
    if (/Title/.test(trimmed) && /\bID\b/.test(trimmed)) continue; // 表头

    let id, title, mid;
    const cols = trimmed.split(/\s{2,}/).filter(Boolean);
    if (cols.length >= 2) {
      id = cols[cols.length - 1];
      title = cols[0];
      mid = cols.slice(1, -1).join(' ');
    } else {
      // 不是定宽表格（CLI 输出形式又变了）：退化成按空白分词，至少保证解析出条目
      const tokens = trimmed.split(/\s+/);
      if (tokens.length < 3) continue;
      id = tokens[tokens.length - 1];
      title = tokens[0];
      mid = tokens.slice(1, -1).join(' ');
    }
    if (!SESSION_ID_RE.test(id)) continue;
    rows.push({ id, title, info: mid });
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
  SESSION_ID_RE,
  warnIfParseEmpty,
  parseResult,
  resolvePython,
  parseSessions,
  parseCronList,
  parseSkillsList,
  parseMcpList,
  kbParseBlocks,
  kbListFromBlocks,
};
