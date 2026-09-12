'use strict';
/* =============================================================================
 * lib/checkpoints.js —— hermes 文件系统检查点（shadow git 库）的 Node 侧读写
 *
 * 为什么自己实现，而不是转发 hermes 的 /rollback：
 *   2026-09-12 实测否证 —— gateway 的 api_server 适配器**不走斜杠命令分发**。
 *   往 /api/sessions/{id}/chat/stream 发 "/version" 会被当成普通消息喂给模型
 *   （模型还一本正经编了 "I am Hermes Agent, built by Nous Research"）。
 *   而 /rollback 只在 `_IDLE_COMMANDS` 表里、由平台消息管线派发（run_busy.py:704
 *   → slash_commands.py:669），Web UI 这条链路根本到不了。所以自己实现。
 *
 * 依据的契约（稳定、有官方文档）：docs/user-guide/checkpoints-and-rollback.md +
 * tools/checkpoint_manager.py。影子库 ~/.hermes/checkpoints/store 是**单个共享 bare git 库**：
 *   store/                                 bare git（绝不碰用户项目自己的 .git）
 *   store/refs/hermes/<hash16>             每项目一条 ref，<hash16> = sha256(realpath(workdir))[:16]
 *   store/indexes/<hash16>                 每项目独立 index
 *   store/projects/<hash16>.json           {workdir, created_at, last_touch}
 *   store/ledgers/<hash16>.json            agent 写入台账 {absPath: {sha256, ts}}
 *   store/info/exclude                     全局排除（node_modules/.git/媒体/密钥…）
 *
 * 三个关键语义（照抄 checkpoint_manager.py，勿自行发挥）：
 *   1) 快照必须在"本回合首次写文件之前"拍，故每目录每回合最多一张；无差异则跳过。
 *   2) **安全回退**（默认）：只覆盖「台账里记录过、且当前内容仍等于 hermes 最后写入」的文件；
 *      用户手改过的文件一律跳过（除非 all=true）。台账为空 → 退回整目录回退。
 *   3) 回退前先拍一张 pre-rollback 快照 —— 于是"撤销的撤销"也在检查点列表里，随时可回去。
 *
 * ⚠️ 两个实测坑：
 *   · $HOME 与 / 永不进入快照（checkpoint_manager.ensure_checkpoint 的硬护栏）。
 *     实测：让 agent 往 ~/cp-probe.txt 写文件确实落盘了，但**不会**产生任何检查点 ——
 *     表现为"我明明让它写文件了，检查点列表却是空的"，不是坏了。
 *   · 项目根由 _PROJECT_MARKERS 向上就近判定（含 .git/package.json/pyproject.toml…）。
 *     往 <项目>/子目录/x.txt 写，快照的是**整个项目根**，不是那个子目录。
 *
 * ⚠️ 安全：所有 git 调用都 GIT_CONFIG_GLOBAL/SYSTEM=∑ 的 /dev/null + 清掉 GIT_* 泄漏，
 *   绝不让使用者自己的 gitconfig（gpg 签名 / hooks / credential helper）介入后台快照。
 * ========================================================================== */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { HOME } = require('./config');

const BASE = process.env.HERMES_CHECKPOINT_BASE || path.join(HOME, '.hermes', 'checkpoints');
const STORE = path.join(BASE, 'store');

function intEnv(name, dflt) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}
const MAX_SNAPSHOTS = intEnv('HERMES_CHECKPOINT_MAX_SNAPSHOTS', 20);
const MAX_FILE_BYTES = intEnv('HERMES_CHECKPOINT_MAX_FILE_MB', 10) * 1024 * 1024;
const MAX_FILES = 50000;          // 与 hermes 的 _MAX_FILES 对齐
const GIT_MS = 30000;

/* 与 checkpoint_manager.DEFAULT_EXCLUDES 同源：写进 store/info/exclude 供 git 侧生效 */
const EXCLUDES = [
  'node_modules/', 'dist/', 'build/', 'target/', 'out/', '.next/', '.nuxt/',
  '__pycache__/', '*.pyc', '*.pyo', '.cache/', '.pytest_cache/', '.mypy_cache/',
  '.ruff_cache/', 'coverage/', '.coverage',
  '.venv/', 'venv/', 'env/',
  '.git/', '.hg/', '.svn/', '.worktrees/',
  '*.so', '*.dylib', '*.dll', '*.o', '*.a', '*.jar', '*.class', '*.exe', '*.obj',
  '*.mp4', '*.mov', '*.mkv', '*.webm', '*.zip', '*.tar', '*.tar.gz', '*.tgz',
  '*.7z', '*.rar', '*.iso',
  '.env', '.env.*', '.env.local', '.env.*.local',
  '.DS_Store', 'Thumbs.db', '*.log',
];

const HASH_RE = /^[0-9a-fA-F]{4,64}$/;

/* ---------- 路径与哈希 ---------- */

/** realpath 优先（Python 侧 Path.resolve() 会解符号链接；macOS 上 /tmp→/private/tmp 这类
 *  差异会让同一个目录算出两个 hash，进而"检查点明明在、却按路径查不到"）。 */
function realpath(p) {
  const abs = path.resolve(String(p || ''));
  try { return fs.realpathSync(abs); } catch { return abs; }
}

/** 与 hermes _project_hash 完全一致：sha256(realpath(workdir))[:16] */
function projectHash(workdir) {
  return crypto.createHash('sha256').update(realpath(workdir)).digest('hex').slice(0, 16);
}

function refName(h) { return `refs/hermes/${h}`; }
function indexPath(h) { return path.join(STORE, 'indexes', h); }
function ledgerPath(h) { return path.join(STORE, 'ledgers', `${h}.json`); }

/* ---------- git 调用 ---------- */

function isolatedEnv() {
  const env = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_NAMESPACE', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) {
    delete env[k];
  }
  env.GIT_CONFIG_GLOBAL = os.devNull;
  env.GIT_CONFIG_SYSTEM = os.devNull;
  env.GIT_CONFIG_NOSYSTEM = '1';
  return env;
}

function gitEnvFor(workdir, indexFile) {
  const env = isolatedEnv();
  env.GIT_DIR = STORE;
  env.GIT_WORK_TREE = realpath(workdir);
  if (indexFile) env.GIT_INDEX_FILE = indexFile;
  return env;
}

/** 跑一次 git（对着共享影子库）→ {ok, code, out, err}。workdir 不存在直接短路，不抛。 */
function runGit(args, workdir, { indexFile = null, timeout = GIT_MS } = {}) {
  const wd = realpath(workdir);
  let stat = null;
  try { stat = fs.statSync(wd); } catch { /* 不存在 */ }
  if (!stat || !stat.isDirectory()) {
    return { ok: false, code: -1, out: '', err: `工作目录不存在：${wd}` };
  }
  const r = spawnSync('git', args, {
    cwd: wd, env: gitEnvFor(wd, indexFile), timeout,
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  if (r.error) return { ok: false, code: -1, out: '', err: r.error.message };
  const code = typeof r.status === 'number' ? r.status : -1;
  return { ok: code === 0, code, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

function gitOut(args, workdir, opts) {
  const r = runGit(args, workdir, opts);
  return r.ok ? r.out : '';
}

/* ---------- 小工具 ---------- */

function readJson(p) {
  try {
    const v = JSON.parse(fs.readFileSync(p, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch { return null; }
}

function writeJsonAtomic(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, p);
}

function hashFile(abs) {
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) return null;
    return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
  } catch { return null; }
}

function dirSize(p) {
  let total = 0;
  const stack = [p];
  while (stack.length) {
    const d = stack.pop();
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { stack.push(full); continue; }
      try { total += fs.statSync(full).size; } catch { /* 竞态删除，忽略 */ }
    }
  }
  return total;
}

/** 有上限的文件计数（到上限即返回，避免在大目录上白跑） */
function countFiles(dir, limit) {
  let n = 0;
  const stack = [dir];
  while (stack.length) {
    let ents;
    try { ents = fs.readdirSync(stack.pop(), { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (e.isDirectory()) { if (e.name !== '.git' && e.name !== 'node_modules') stack.push(path.join(dir, e.name)); continue; }
      if (++n > limit) return n;
    }
  }
  return n;
}

function loadLedger(h) { return readJson(ledgerPath(h)) || {}; }

/* ---------- 库初始化 / 项目登记 ---------- */

function storeReady() { return fs.existsSync(path.join(STORE, 'HEAD')); }

/** 影子库不存在则 git init --bare（照抄 _init_store）。返回错误串或 null。 */
function ensureStore() {
  if (storeReady()) return null;
  try {
    fs.mkdirSync(path.join(STORE, 'indexes'), { recursive: true });
    fs.mkdirSync(path.join(STORE, 'projects'), { recursive: true });
  } catch (e) { return `无法创建检查点库目录：${e.message}`; }

  // git init --bare 拒绝 GIT_WORK_TREE，故绕开 runGit 用干净 env
  const r = spawnSync('git', ['init', '--bare', STORE], { env: isolatedEnv(), cwd: BASE, encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    return `影子库初始化失败：${(r.error && r.error.message) || (r.stderr || '').trim()}`;
  }
  for (const [k, v] of [['user.email', 'hermes@local'], ['user.name', 'Hermes Checkpoint'],
    ['commit.gpgsign', 'false'], ['tag.gpgSign', 'false'], ['gc.auto', '0']]) {
    runGit(['config', k, v], BASE);
  }
  try {
    fs.mkdirSync(path.join(STORE, 'info'), { recursive: true });
    fs.writeFileSync(path.join(STORE, 'info', 'exclude'), EXCLUDES.join('\n') + '\n');
  } catch { /* 排除表写不进去只是快照偏大，不致命 */ }
  return null;
}

function registerProject(workdir) {
  const wd = realpath(workdir);
  const h = projectHash(wd);
  const p = path.join(STORE, 'projects', `${h}.json`);
  const meta = readJson(p) || {};
  meta.workdir = wd;
  meta.last_touch = Date.now() / 1000;
  if (!meta.created_at) meta.created_at = meta.last_touch;
  try { writeJsonAtomic(p, meta); } catch { /* 登记失败不影响快照本身 */ }
}

/** 已注册项目（按最近触碰倒序）。restore 只允许作用于这里的目录 —— 浏览器传来的任意路径一律拒绝。 */
function listProjects() {
  const dir = path.join(STORE, 'projects');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const f of files) {
    const h = f.slice(0, -'.json'.length);
    const meta = readJson(path.join(dir, f));
    if (!meta || !meta.workdir) continue;
    const wd = meta.workdir;
    out.push({
      hash: h, workdir: wd, name: path.basename(wd),
      exists: fs.existsSync(wd),
      lastTouch: meta.last_touch || 0, createdAt: meta.created_at || 0,
      commits: Number(gitOut(['rev-list', '--count', refName(h)], wd) || 0),
    });
  }
  return out.sort((a, b) => (b.lastTouch || 0) - (a.lastTouch || 0));
}

/** 只接受"已注册项目"的目录；其余（含任意路径）返回 null。 */
function resolveWorkdir(input) {
  const want = realpath(String(input || ''));
  if (!want) return null;
  if (want === '/' || want === realpath(HOME)) return null;
  return listProjects().some((p) => p.workdir === want) ? want : null;
}

/* ⚠️ 两条守卫，缺一不可 —— 都由一次真实事故换来（2026-09-12 自测）：
 *   影子库是**单个共享 git 库**，因此 store 里任何提交对任何 workdir 都 cat-file 可见。
 *   只检查"提交存在"就够了吗？不够：把某个已注册项目当 workdir、配一个无关提交，
 *   `git checkout <hash> -- .` 会把**整个项目树**写到那个目录里去。
 *   实测：对未注册的 /tmp 调 restore，结果整个项目被 checkout 进 /private/tmp。
 *   故：① 回退只允许发生在已注册项目；② 目标提交必须在该项目自己的 ref 历史里。 */
function guard(wd, hash) {
  if (!resolveWorkdir(wd)) return '该目录不是已注册的检查点项目（仅允许回退已登记过的项目）';
  if (!HASH_RE.test(String(hash || ''))) return '检查点哈希非法';
  const ref = refName(projectHash(wd));
  if (runGit(['merge-base', '--is-ancestor', hash, ref], wd).code !== 0) {
    return '该检查点不属于此项目（哈希不在本项目历史中）';
  }
  return null;
}

function storeInfo() {
  const projects = fs.existsSync(path.join(STORE, 'projects')) ? listProjects() : [];
  return {
    base: BASE, store: STORE, ready: storeReady(),
    sizeBytes: fs.existsSync(STORE) ? dirSize(STORE) : 0,
    projects: projects.length,
    maxSnapshots: MAX_SNAPSHOTS, maxFileMb: Math.round(MAX_FILE_BYTES / 1024 / 1024),
  };
}

/* ---------- 快照 ---------- */

function refTip(wd, ref) { return gitOut(['rev-parse', '--verify', ref], wd); }

function seedIndex(wd, indexFile, refCommit) {
  if (!fs.existsSync(indexFile)) { fs.mkdirSync(path.dirname(indexFile), { recursive: true }); return; }
  if (refCommit) runGit(['read-tree', refCommit], wd, { indexFile });
  else { try { fs.unlinkSync(indexFile); } catch { /* 删不掉则退回空索引，git 会重建 */ } }
}

function dropOversize(wd, indexFile) {
  if (MAX_FILE_BYTES <= 0) return;
  const listed = gitOut(['ls-files', '--cached', '-z'], wd, { indexFile });
  if (!listed) return;
  const oversize = listed.split('\0').filter(Boolean).filter((rel) => {
    try { return fs.statSync(path.join(wd, rel)).size > MAX_FILE_BYTES; } catch { return false; }
  });
  for (let i = 0; i < oversize.length; i += 200) {
    runGit(['rm', '--cached', '--quiet', '--', ...oversize.slice(i, i + 200)], wd, { indexFile });
  }
}

/** 相对 ref tip 无差异 → 返回原因串（跳过快照），否则 null。 */
function unchangedReason(wd, indexFile, refCommit) {
  if (refCommit) {
    const r = runGit(['diff-index', '--cached', '--quiet', refCommit], wd, { indexFile });
    return r.code === 0 ? '与上一次快照无差异' : null;
  }
  return gitOut(['ls-files', '--cached'], wd, { indexFile }) ? null : '工作区为空';
}

/** 把 commits 重建成一条"无祖先"的线性链（同消息、同树），再把 ref 指过去。
 *  为什么必须重建：只把 ref 指向次新提交，最旧那个仍是它的父 → 可达、删不掉、日志也还在。
 *  hermes 的 _rebuild_linear_chain 是同一套做法。返回是否成功。 */
function rewriteChain(wd, ref, shas) {
  if (!shas.length) return false;
  let parent = null;
  for (const sha of shas) {
    const tree = gitOut(['rev-parse', `${sha}^{tree}`], wd);
    if (!tree) return false;
    const msg = gitOut(['log', '--format=%s', '-1', sha], wd) || 'checkpoint';
    parent = gitOut(['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', msg, '--no-gpg-sign'], wd);
    if (!parent) return false;
  }
  return runGit(['update-ref', ref, parent], wd).ok;
}

function gcStore() {
  runGit(['reflog', 'expire', '--expire=now', '--all'], BASE);
  runGit(['gc', '--prune=now', '--quiet'], BASE, { timeout: GIT_MS * 3 });
}

/** 每项目只留 max_snapshots 条：超出则重建链 + gc。 */
function prune(wd, ref) {
  const all = gitOut(['rev-list', '--reverse', ref], wd).split('\n').filter(Boolean);
  if (all.length <= MAX_SNAPSHOTS) return;
  if (rewriteChain(wd, ref, all.slice(-MAX_SNAPSHOTS))) gcStore();
}

/** 全库体积上限：超了就按项目轮转丢最旧的检查点，最后 gc。
 *  ⚠️ 为什么不能只 gc 不看体积：松散对象只是问题的一半 —— 可达的历史也会把库撑大；
 *     实测一次对 /tmp 的误暂存就攒下 25MB 不可达对象（837 个对象里只有 162 个可达）。 */
function enforceSizeCap() {
  const cap = intEnv('HERMES_CHECKPOINT_MAX_TOTAL_MB', 300) * 1024 * 1024;
  if (cap <= 0) return;
  let size = dirSize(STORE);
  if (size <= cap) return;
  for (let round = 0; round < 50 && size > cap; round++) {
    let dropped = false;
    for (const p of listProjects()) {
      const commits = gitOut(['rev-list', '--reverse', refName(p.hash)], p.workdir).split('\n').filter(Boolean);
      if (commits.length <= 1) continue;            // 每个项目至少留一个还原点
      if (!rewriteChain(p.workdir, refName(p.hash), commits.slice(1))) continue;
      dropped = true;
      size = dirSize(STORE);
      if (size <= cap) break;
    }
    if (!dropped) break;
  }
  gcStore();
}

/** 拍一张快照。返回 {ok, hash?, skipped?, error?}。
 * skipped 是**正常路径**（无差异/工作区为空/文件数超限），报告给用户时不要说成失败。
 */
function take(workdir, reason) {
  const wd = realpath(workdir);
  if (wd === '/' || wd === realpath(HOME)) return { ok: false, error: '$HOME 与 / 永不进入快照（hermes 硬护栏）' };
  const err = ensureStore();
  if (err) return { ok: false, error: err };
  registerProject(wd);

  if (countFiles(wd, MAX_FILES) > MAX_FILES) return { ok: true, skipped: `文件数超过 ${MAX_FILES}，已跳过快照` };

  const h = projectHash(wd);
  const ref = refName(h);
  const indexFile = indexPath(h);
  const refCommit = refTip(wd, ref);
  seedIndex(wd, indexFile, refCommit);

  const add = runGit(['add', '-A'], wd, { indexFile, timeout: GIT_MS * 2 });
  if (!add.ok) return { ok: false, error: `git add 失败：${add.err}` };
  dropOversize(wd, indexFile);

  const skip = unchangedReason(wd, indexFile, refCommit);
  if (skip) return { ok: true, skipped: skip };

  const tree = gitOut(['write-tree'], wd, { indexFile });
  if (!tree) return { ok: false, error: 'git write-tree 无输出' };
  const sha = gitOut(['commit-tree', tree, ...(refCommit ? ['-p', refCommit] : []), '-m', reason, '--no-gpg-sign'], wd, { indexFile });
  if (!sha) return { ok: false, error: 'git commit-tree 无输出' };
  const up = runGit(['update-ref', ref, sha, ...(refCommit ? [refCommit] : [])], wd);
  if (!up.ok) return { ok: false, error: `git update-ref 失败：${up.err}` };

  prune(wd, ref);
  enforceSizeCap();
  return { ok: true, hash: sha };
}

/* ---------- 列出 / 预览 ---------- */

function listCheckpoints(workdir, limit) {
  const wd = realpath(workdir);
  if (!storeReady()) return [];
  const n = Math.max(1, Math.min(Number(limit) || MAX_SNAPSHOTS, 200));
  const log = gitOut(['log', refName(projectHash(wd)), '--format=%H|%h|%aI|%s', '-n', String(n)], wd);
  const out = [];
  for (const line of log.split('\n')) {
    if (!line) continue;
    const parts = line.split('|');
    if (parts.length < 3) continue;
    const e = {
      hash: parts[0], shortHash: parts[1], ts: parts[2],
      reason: parts.slice(3).join('|') || '(无说明)',
      filesChanged: 0, insertions: 0, deletions: 0,
    };
    // 根提交没有父，`~1` 会失败 —— 退回 0/0/0（与 hermes 行为一致）
    const st = gitOut(['diff', '--shortstat', `${e.hash}~1`, e.hash], wd);
    const m = [/(\d+) file/, /(\d+) insertion/, /(\d+) deletion/].map((re) => st.match(re));
    e.filesChanged = m[0] ? Number(m[0][1]) : 0;
    e.insertions = m[1] ? Number(m[1][1]) : 0;
    e.deletions = m[2] ? Number(m[2][1]) : 0;
    out.push(e);
  }
  return out;
}

/** 先暂存（让新增文件也进 diff），跑完把索引复位到 ref tip —— 与 _diff_staged_tree 同序。 */
function withStagedIndex(wd, h, fn) {
  const indexFile = indexPath(h);
  runGit(['add', '-A'], wd, { indexFile, timeout: GIT_MS * 2 });
  try { return fn(indexFile); } finally { runGit(['read-tree', refName(h)], wd, { indexFile }); }
}

function diff(workdir, hash, { statOnly = false, maxChars = 20000 } = {}) {
  const wd = realpath(workdir);
  const g = guard(wd, hash);
  if (g) return { ok: false, error: g };
  const h = projectHash(wd);
  return withStagedIndex(wd, h, (indexFile) => {
    const stat = gitOut(['diff', '--cached', '--shortstat', hash], wd, { indexFile });
    if (statOnly) return { ok: true, stat, patch: '' };
    const patch = gitOut(['diff', '--cached', hash], wd, { indexFile });
    return {
      ok: true, stat,
      patch: patch.length > maxChars ? `${patch.slice(0, maxChars)}\n…（共 ${patch.length} 字符，已截断）` : patch,
    };
  });
}

/**
 * 安全回退"预案"：把自 <hash> 以来变动的文件分成 restore（仍等于 hermes 最后写入，可覆盖）
 * 与 skipped（用户手改过 / 从未由 hermes 写过，保留）。台账为空 → ledgerEmpty，调用方退回整目录回退。
 */
function plan(workdir, hash) {
  const wd = realpath(workdir);
  const g = guard(wd, hash);
  if (g) return { ok: false, error: g };
  const h = projectHash(wd);
  return withStagedIndex(wd, h, (indexFile) => {
    const names = gitOut(['diff', '--name-only', '--cached', hash], wd, { indexFile });
    const ledger = loadLedger(h);
    if (!Object.keys(ledger).length) return { ok: true, restore: [], skipped: [], ledgerEmpty: true };
    const restore = [], skipped = [];
    for (const rel of names.split('\n').map((s) => s.trim()).filter(Boolean)) {
      const entry = ledger[path.join(wd, rel)];
      const recorded = entry && entry.sha256;
      const cur = hashFile(path.join(wd, rel));
      // 文件已不存在(cur===null)也算"hermes 写过"——那多半是 hermes 自己删的
      const byAgent = recorded != null && (cur === null || cur === recorded);
      (byAgent ? restore : skipped).push(rel);
    }
    return { ok: true, restore, skipped, ledgerEmpty: false };
  });
}

/* ---------- 回退 ---------- */

function safeRel(wd, rel) {
  const abs = path.resolve(wd, String(rel || ''));
  return abs !== wd && abs.startsWith(wd + path.sep) ? abs : null;
}

/**
 * 回退到检查点。
 *   all=true  → 整目录回退，连用户手改一起覆盖（等于 /rollback <N> --all）
 *   file=相对路径 → 只回退单个文件
 * 默认安全模式：只回退"台账认定由 hermes 写入且未被手改"的文件。
 * 返回 {ok, restoredTo, reason, restoredFiles, skippedUserEdits, skippedOversize, failedDeletes}
 */
function restore(workdir, hash, { all = false, file = null } = {}) {
  const wd = realpath(workdir);
  const g = guard(wd, hash);
  if (g) return { ok: false, error: g };
  const short = String(hash).slice(0, 8);
  const target = file ? safeRel(wd, file) : null;
  if (file && !target) return { ok: false, error: '文件路径非法（必须位于该项目目录内）' };

  let restorePaths = null, skippedUserEdits = [];
  if (!all && !file) {
    const p = plan(wd, hash);
    if (!p.ok) return p;
    if (!p.ledgerEmpty) {
      restorePaths = p.restore;
      skippedUserEdits = p.skipped;
      if (!restorePaths.length) {
        return {
          ok: true, mode: 'safe', restoredTo: short,
          reason: '无需回退（变动文件全部是手动编辑，已保留）',
          restoredFiles: [], skippedUserEdits, skippedOversize: [], failedDeletes: [], deleted: [],
        };
      }
    }
  }

  // 回退前先拍一张 —— 于是"撤销的撤销"也在列表里可回
  const pre = take(wd, `回退前快照（回退到 ${short}）`);
  if (!pre.ok) return { ok: false, error: `回退前快照失败，已中止：${pre.error}` };

  const checkout = [];
  const keptOversize = [], failedDeletes = [];
  if (file) {
    // ⚠️ 单文件回退的边界：该文件在目标检查点里**尚不存在**时，"回退"的语义就是删除它。
    // hermes 在这里会抛 pathspec 错（checkout 找不到路径）—— 那是它的缺陷，不是规范。
    // 直接删不可逆，故仍受单文件大小上限保护（超限保留并如实上报）。
    const rel = path.relative(wd, target);
    const inCommit = runGit(['cat-file', '-e', `${hash}:${rel}`], wd).ok;
    if (inCommit) {
      checkout.push(rel);
    } else {
      let size = 0, exists = true;
      try { size = fs.statSync(target).size; } catch { exists = false; }
      if (!exists) {
        return { ok: true, mode: 'file', restoredTo: short, reason: '该文件在目标检查点中不存在，且当前也已不存在',
          restoredFiles: [], skippedUserEdits: [], skippedOversize: [], failedDeletes: [], deleted: [] };
      }
      if (MAX_FILE_BYTES > 0 && size > MAX_FILE_BYTES) {
        return { ok: false, error: `该文件在检查点中不存在，需删除，但体积 ${Math.round(size / 1024 / 1024)}MB 超过单文件上限，已拒绝` };
      }
      try {
        fs.unlinkSync(target);
        return { ok: true, mode: 'file', restoredTo: short, reason: `该文件在目标检查点中不存在，已删除（等价于回退）：${rel}`,
          restoredFiles: [], skippedUserEdits: [], skippedOversize: [], failedDeletes: [], deleted: [rel] };
      } catch (e) {
        return { ok: false, error: `删除失败：${e.message}` };
      }
    }
  } else if (restorePaths === null) {
    checkout.push('.');
  } else {
    for (const rel of restorePaths) {
      const abs = path.join(wd, rel);
      const inCommit = runGit(['cat-file', '-e', `${hash}:${rel}`], wd).ok;
      if (inCommit) { checkout.push(rel); continue; }
      let size = 0;
      try { size = fs.statSync(abs).size; } catch { /* 已不存在 */ }
      if (MAX_FILE_BYTES > 0 && size > MAX_FILE_BYTES) { keptOversize.push(rel); continue; }
      try { fs.unlinkSync(abs); } catch (e) { if (e.code !== 'ENOENT') failedDeletes.push(rel); }
    }
  }

  if (checkout.length) {
    const r = runGit(['checkout', hash, '--', ...checkout], wd, { indexFile: indexPath(projectHash(wd)), timeout: GIT_MS * 2 });
    if (!r.ok) return { ok: false, error: `git checkout 失败：${r.err}` };
  }

  const notRestored = new Set([...keptOversize, ...failedDeletes]);
  return {
    ok: true,
    mode: file ? 'file' : (restorePaths === null ? 'all' : 'safe'),
    restoredTo: short,
    reason: gitOut(['log', '--format=%s', '-1', hash], wd) || 'unknown',
    restoredFiles: restorePaths ? restorePaths.filter((r) => !notRestored.has(r)) : checkout,
    skippedUserEdits, skippedOversize: keptOversize, failedDeletes, deleted: [],
  };
}

module.exports = {
  BASE, STORE,
  storeReady, storeInfo, listProjects, resolveWorkdir,
  listCheckpoints, diff, plan, take, restore, gcStore,
  // 仅测试用（纯函数）
  _internal: { projectHash, refName, realpath, runGit },
};
