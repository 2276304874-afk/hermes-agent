#!/usr/bin/env node
'use strict';
/* =============================================================================
 * scripts/push-via-api.js —— 当 github.com:443 被网络策略阻断时，改用 GitHub
 * REST API 推送本地 git 历史（保留完整提交图，不是把文件重传成新历史）。
 *
 * 为什么需要它：
 *   `git push` 必须连 https://github.com/<owner>/<repo>.git，而本机所在网络
 *   对该主机返回 `CONNECT tunnel failed, response 502`（被策略阻断）。
 *   对照测试：api.github.com → 200，codeload.github.com → 301，github.com → 超时。
 *   于是改走 api.github.com 的 Git Data API：blob → tree → commit → ref。
 *
 * 保真度保证（每一步都可校验，不靠"看起来对了"）：
 *   1. blob 上传后，GitHub 返回的 sha 必须等于本地 `git hash-object` 的 sha。
 *      git blob 是内容寻址，同内容必然同 sha —— 不等即说明内容被改动，立即中止。
 *   2. 树对象按 git 的排序规则自行排序（目录名视作带尾随 '/' 参与字节比较），
 *      否则 GitHub 算出的 tree sha 会与 git 不一致。
 *   3. 全部推完后，比对远端 HEAD 的 tree sha 与本地 `HEAD^{tree}`。
 *      相等 ⇒ 文件内容与目录结构逐字节一致。
 *
 * 用法：
 *   OWNER=<owner> REPO=<repo> node scripts/push-via-api.js [branch] [--dry-run]
 *   —— token 自动取自 `gh auth token`
 *
 * 退出码：0 成功 / 1 失败（失败时不会留下半成品 ref —— ref 是最后一步才建的）
 *
 * ── 怎么判断「远端镜像是不是最新的」────────────────────────────────────────
 *
 * ⚠️ 不要用 `git status` / `git branch -vv` / `git log origin/main..main` 判断。
 *    提交 sha 两边必然不同（见下方坑 ②），本地也没有 origin/main 这个 tracking ref
 *    （`git fetch` 需要 github.com:443，本机被阻断）。这几条命令只会给出
 *    "无 upstream" 或 "diverged" 这类**结构性噪声**，不反映真实同步状态。
 *
 * ✅ 权威判据是**根树 sha**：内容寻址，与提交时间戳无关。相等 ⇒ 文件内容逐字节一致。
 *
 *     LOCAL_TREE=$(git rev-parse main^{tree})
 *     REMOTE_TREE=$(gh api repos/<owner>/<repo>/git/commits/$( \
 *       gh api repos/<owner>/<repo>/git/ref/heads/main --jq .object.sha) --jq .tree.sha)
 *     [ "$LOCAL_TREE" = "$REMOTE_TREE" ] && echo "镜像最新" || echo "镜像落后，跑 npm run mirror"
 *
 *     [脚本自身跑完也会打印这两行 + 逐提交比对，正常应看到 "57/57 一致" 与
 *      "远端可达提交: 57 / 本地 57 ✅ 完整历史"。]
 *
 * ⚠️ 本脚本每次都是**整体重推**（~700 次 API 调用、约 8 分钟，实测 723 次），
 *    没有增量。因为提交 sha 不对齐，增量同步在 Git Data API 上无从谈起。
 *    另注：前台一次性跑超过 ~120s 会被执行环境 SIGKILL，请在后台跑并读日志文件。
 *
 * ── 两条踩过的硬坑（都已在代码里修掉，勿回退）──────────────────────────────
 *
 * ① 必须用 `git ls-tree -r -z`，不能去掉 `-z`。
 *    默认输出受 core.quotePath 影响，非 ASCII 路径会被转义成带引号的形式
 *    （`"\\345\\217\\257..."`）。直接当路径用，GitHub 上就会生成一个**名字真的是
 *    那串转义**的文件，真名丢失。不报错、不告警，只在远端悄悄产生错名文件。
 *    更阴的是：如果校验时两侧都用同一段转义输出，比对会"全部一致"——拿 bug 跟
 *    自己对账，全绿但错的。所以校验必须拿远端真实路径与本地原始路径比。
 *
 * ② 提交 sha 无法与本地对齐，这是 GitHub 的硬限制，不是实现缺陷。
 *    git 提交对象把时间戳写成 `<epoch> <±HHMM>`（保留时区偏移，如 `... +0800`），
 *    而 GitHub 会把提交时间**归一到 UTC**（返回 `...Z`）。字节不同 → sha 不同，
 *    且这个差异会沿 parent 链向下级联，整条历史都对不上。
 *    因此：**内容可以逐字节一致（树 sha 全等），提交 sha 不会一致。**
 *    实际影响：本地仓库与 GitHub 是两套并行历史，`git push` 会判定 diverge。
 *    把 GitHub 当作**只读异地镜像**即可，需要更新就重跑本脚本。
 *    若哪天想要 sha 对齐，唯一办法是让本地提交从一开始就用 +0000 时区，
 *    或者干脆 `git fetch origin && git reset --hard origin/main` 以远端为准
 *    （内容不变，只是本地 sha 改写；改动前请先跑 backup.sh）。
 * ========================================================================== */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO_DIR = path.resolve(__dirname, '..');
const BRANCH = (process.argv[2] && !process.argv[2].startsWith('--')) ? process.argv[2] : 'main';
const DRY = process.argv.includes('--dry-run');

/* ⚠️ 必须走 fs.writeSync 而不是 process.stdout.write。
 * 实测：输出被管道（如 `| tail`）或被上级脚本重定向时，stdout 是**块缓冲**，
 * 一次调用里最后几十行会攒着不落盘 —— 于是进程一旦在中途死掉，
 * 日志看起来"跑到 40/317 就没了"，把「静默死亡」伪装成「卡住」，
 * 排查方向直接跑偏。writeSync 走同步系统调用，每行立即落盘。 */
const OUT = (s) => fs.writeSync(1, s + '\n');

// ---------- 工具 ----------
function git(args, opts = {}) {
  return execFileSync('git', args, { cwd: REPO_DIR, maxBuffer: 1 << 28, ...opts });
}
function gitText(args) { return git(args).toString('utf8'); }

function getToken() {
  const t = (process.env.GH_TOKEN || execFileSync('gh', ['auth', 'token']).toString()).trim();
  if (!t) throw new Error('拿不到 GitHub token（gh auth token 为空）');
  return t;
}
function getRemote() {
  let owner = process.env.OWNER, repo = process.env.REPO;
  if (!owner || !repo) {
    const url = gitText(['remote', 'get-url', 'origin']).trim();
    const m = url.match(/github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?$/);
    if (!m) throw new Error(`无法从 origin 解析 owner/repo：${url}`);
    owner = owner || m[1];
    repo = repo || m[2];
  }
  return { owner, repo };
}

const TOKEN = getToken();
const { owner, repo } = getRemote();
const API = `https://api.github.com/repos/${owner}/${repo}`;

let callCount = 0;

/* 单请求超时与重试次数。
 * 原来写死 120s / 3 次：一个卡住的请求最坏要拖 120×3+4.5 ≈ 6 分钟，
 * 而整趟推送有 ~500 个请求 —— 偶发卡顿会让总时长不可预测。
 * 实测本机 api.github.com 正常往返 0.6s、最慢 2.7s（30 次序列探针），
 * 故 30s 足够宽松；配合 5 次重试，单点卡顿的恢复时间从 6 分钟降到 ~2 分钟。 */
const intEnv = (name, dflt) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
};
const REQ_TIMEOUT_MS = intEnv('HERMES_MIRROR_TIMEOUT_MS', 30000);
const MAX_ATTEMPTS = intEnv('HERMES_MIRROR_ATTEMPTS', 5);

async function api(method, url, body, { retries = MAX_ATTEMPTS } = {}) {
  const label = url.startsWith(API) ? url.slice(API.length) : url;
  for (let attempt = 1; attempt <= retries; attempt++) {
    callCount++;
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'hermes-agent-backup',
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
      });
    } catch (e) {
      // ⚠️ 重试必须留痕。静默重试会让「很慢」与「已经挂了」在日志上长得一模一样，
      // 而这两者的处置完全不同（前者等，后者查）。故每次失败都打一行。
      OUT(`      ⚠ ${method} ${label} 第 ${attempt}/${retries} 次异常：${e.name} ${e.message}`);
      if (attempt === retries) throw new Error(`${method} ${url} 网络失败: ${e.message}`);
      await new Promise(r => setTimeout(r, 1500 * attempt));
      continue;
    }
    const text = await res.text();
    if (res.ok) return text ? JSON.parse(text) : null;
    // 5xx 与限流可重试；4xx（除 429）是逻辑错误，直接抛
    const retryable = res.status >= 500 || res.status === 429;
    if (!retryable || attempt === retries) {
      throw new Error(`${method} ${url} → HTTP ${res.status}\n${text.slice(0, 400)}`);
    }
    const wait = res.headers.get('retry-after') ? Number(res.headers.get('retry-after')) * 1000 : 1500 * attempt;
    await new Promise(r => setTimeout(r, wait));
  }
}

// git 的 tree 排序：目录名按带尾随 '/' 参与字节比较
function gitTreeSort(a, b) {
  const ka = Buffer.from(a.path + (a.type === 'tree' ? '/' : ''), 'utf8');
  const kb = Buffer.from(b.path + (b.type === 'tree' ? '/' : ''), 'utf8');
  return Buffer.compare(ka, kb);
}

// ---------- 缓存 ----------
const blobCache = new Map();   // local sha -> uploaded sha
const treeCache = new Map();   // entries JSON -> remote tree sha

// ---------- 1) 读本地历史 ----------
function readCommits() {
  const shas = gitText(['rev-list', '--reverse', BRANCH]).trim().split('\n').filter(Boolean);
  return shas.map((sha) => {
    const meta = gitText(['log', '-1', '--format=%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%P%x00%B', sha]).split('\x00');
    return {
      sha,
      authorName: meta[0], authorEmail: meta[1], authorDate: meta[2],
      committerName: meta[3], committerEmail: meta[4], committerDate: meta[5],
      parents: meta[6].trim() ? meta[6].trim().split(' ') : [],
      message: meta[7].replace(/\n+$/, ''),
    };
  });
}

/* `git ls-tree -r -z` → [{path, mode, sha}]（仅 blob）
 *
 * ⚠️ 必须用 `-z`（NUL 分隔）。默认的 `git ls-tree` 受 core.quotePath 影响，会把
 * 非 ASCII 路径输出成带引号的八进制转义，例如：
 *     "100644 blob <sha>\t\"\\345\\217\\257\\345\\244\\215...md\""
 * 直接拿这个字符串当路径，GitHub 上就会出现一个**名字真的是那串转义**的文件，
 * 而真实中文文件名丢失。这个坑不报错、不告警，只在远端悄悄产生错名文件。
 * `-z` 输出原始字节，不受 quotePath 影响。 */
function readBlobs(commitSha) {
  const raw = git(['ls-tree', '-r', '-z', commitSha]).toString('utf8');
  return raw.split('\0').filter(Boolean).map((rec) => {
    const tab = rec.indexOf('\t');
    if (tab === -1) throw new Error(`ls-tree 记录格式异常：${JSON.stringify(rec.slice(0, 80))}`);
    const [mode, type, sha] = rec.slice(0, tab).split(/\s+/);
    if (type !== 'blob') throw new Error(`遇到非 blob 条目（子模块？）：${rec.slice(0, 120)}`);
    return { path: rec.slice(tab + 1), mode, sha };
  });
}

// ---------- 2) 上传 blob ----------
async function uploadBlob(sha) {
  if (blobCache.has(sha)) return blobCache.get(sha);
  const buf = git(['cat-file', 'blob', sha]);
  if (DRY) { blobCache.set(sha, sha); return sha; }
  const res = await api('POST', `${API}/git/blobs`, { content: buf.toString('base64'), encoding: 'base64' });
  // git blob 内容寻址 —— 同内容必同 sha。不等即内容被改动，一票否决。
  if (res.sha !== sha) {
    throw new Error(`blob sha 校验失败：本地 ${sha} ≠ 远端 ${res.sha}（内容不一致，中止）`);
  }
  blobCache.set(sha, res.sha);
  return res.sha;
}

// ---------- 3) 递归建树 ----------
async function buildTree(files) {
  const entries = [];
  const byDir = new Map();
  for (const f of files) {
    const i = f.path.indexOf('/');
    if (i === -1) {
      entries.push({ path: f.path, mode: f.mode, type: 'blob', sha: f.sha });
    } else {
      const dir = f.path.slice(0, i);
      if (!byDir.has(dir)) byDir.set(dir, []);
      byDir.get(dir).push({ path: f.path.slice(i + 1), mode: f.mode, sha: f.sha });
    }
  }
  for (const [dir, sub] of byDir) {
    entries.push({ path: dir, mode: '040000', type: 'tree', sha: await buildTree(sub) });
  }
  entries.sort(gitTreeSort);

  const key = JSON.stringify(entries);
  if (treeCache.has(key)) return treeCache.get(key);
  if (DRY) { treeCache.set(key, 'dry-run-tree'); return 'dry-run-tree'; }
  const res = await api('POST', `${API}/git/trees`, { tree: entries });
  treeCache.set(key, res.sha);
  return res.sha;
}

/* GitHub 硬限制：**完全空的仓库**不允许通过 Git Data API 创建 blob/tree/commit
 * （返回 409 "Git Repository is empty."）。必须先有一个提交把仓库"激活"。
 * 用 Contents API 塞一个占位文件生成首个提交，随后 ref 会被本地历史整体替换，
 * 该占位提交自然变成不可达对象（不出现在任何分支上）。 */
async function bootstrapIfEmpty() {
  try {
    await api('GET', `${API}/git/ref/heads/${BRANCH}`);
    return false;                       // 已有分支 → 不需要引导
  } catch (e) {
    if (!/HTTP (404|409)/.test(e.message)) throw e;
  }
  OUT(`      仓库为空 → 写入引导提交（Git Data API 要求仓库非空）`);
  await api('PUT', `${API}/contents/.push-bootstrap`, {
    message: 'chore: bootstrap empty repository for Git Data API',
    content: Buffer.from('placeholder — replaced by the real history below\n').toString('base64'),
  });
  return true;
}

// ---------- 主流程 ----------
(async () => {
  OUT('==============================================');
  OUT(` 通过 GitHub REST API 推送 → ${owner}/${repo} (${BRANCH})`);
  OUT(` 提交数: ${gitText(['rev-list', '--count', BRANCH]).trim()}${DRY ? '   [DRY-RUN]' : ''}`);
  OUT('==============================================');
  OUT('');

  const commits = readCommits();
  OUT(`[1/4] 本地历史读取完成：${commits.length} 次提交`);
  if (!DRY) await bootstrapIfEmpty();

  // 先把整段历史里出现过的所有 blob 去重上传
  const allBlobs = new Set();
  for (const c of commits) for (const b of readBlobs(c.sha)) allBlobs.add(b.sha);
  OUT(`[2/4] 上传 blob（去重后 ${allBlobs.size} 个对象）`);
  let done = 0;
  for (const sha of allBlobs) {
    await uploadBlob(sha);
    if (++done % 20 === 0 || done === allBlobs.size) OUT(`      ${done}/${allBlobs.size}`);
  }

  // 逐提交建树 + 建 commit（顺序：旧 → 新，保证 parent 已存在）
  OUT(`[3/4] 重建提交图`);
  const shaMap = new Map();   // 本地 commit sha -> 远端 commit sha
  for (const c of commits) {
    const blobs = readBlobs(c.sha);
    for (const b of blobs) b.sha = blobCache.get(b.sha) || b.sha;
    const treeSha = await buildTree(blobs);
    const parents = c.parents.map(p => shaMap.get(p) || p);

    if (DRY) { shaMap.set(c.sha, c.sha); continue; }
    const res = await api('POST', `${API}/git/commits`, {
      message: c.message,
      tree: treeSha,
      parents,
      author: { name: c.authorName, email: c.authorEmail, date: c.authorDate },
      committer: { name: c.committerName, email: c.committerEmail, date: c.committerDate },
    });
    shaMap.set(c.sha, res.sha);
    OUT(`      ${c.sha.slice(0, 7)} → ${res.sha.slice(0, 7)}  ${c.message.split('\n')[0].slice(0, 46)}`);
  }

  // ref 最后建 —— 中途失败不会留下半成品分支
  const headRemote = shaMap.get(commits[commits.length - 1].sha);
  if (!DRY) {
    try {
      await api('POST', `${API}/git/refs`, { ref: `refs/heads/${BRANCH}`, sha: headRemote });
      OUT(`      ref refs/heads/${BRANCH} 已创建`);
    } catch (e) {
      if (!/HTTP 422/.test(e.message)) throw e;
      await api('PATCH', `${API}/git/refs/heads/${BRANCH}`, { sha: headRemote, force: true });
      OUT(`      ref refs/heads/${BRANCH} 已更新（force）`);
    }
  }

  // ---------- 4) 保真度校验 ----------
  OUT('');
  OUT('[4/4] 保真度校验');
  if (DRY) {
    OUT('  DRY-RUN：跳过远端比对');
    OUT(`  本地树 sha: ${gitText(['rev-parse', `${BRANCH}^{tree}`]).trim()}`);
  } else {
    const remote = await api('GET', `${API}/git/commits/${headRemote}`);
    const localTree = gitText(['rev-parse', `${BRANCH}^{tree}`]).trim();
    OUT(`  本地根树 sha: ${localTree}`);
    OUT(`  远端根树 sha: ${remote.tree.sha}`);
    if (remote.tree.sha !== localTree) {
      OUT('  ❌ 根树 sha 不一致 —— 内容有偏差，需要排查');
      process.exitCode = 1;
    }

    // 逐提交比对树 sha：只查 HEAD 一棵树太弱（远端中间某次提交出错会被漏掉）。
    // 全部相等 ⇒ 每个快照的文件内容与目录结构都与本地逐字节相同。
    let treeOk = 0;
    const treeBad = [];
    for (const c of commits) {
      const rc = await api('GET', `${API}/git/commits/${shaMap.get(c.sha)}`);
      const lt = gitText(['rev-parse', `${c.sha}^{tree}`]).trim();
      if (rc.tree.sha === lt) treeOk++; else treeBad.push(c.sha.slice(0, 7));
    }
    OUT(`  树 sha 逐提交比对: ${treeOk}/${commits.length} 一致` +
      (treeBad.length ? `  ❌ 不一致: ${treeBad.join(', ')}` : '  ✅ 全部一致'));
    if (treeBad.length) process.exitCode = 1;

    // 提交 sha 是否也与本地相同。相同 ⇒ 本地与远端完全对齐，今后 git push 可增量同步；
    // 不同 ⇒ 远端是一套独立历史，每次同步都得整体重推。
    const shaEqual = commits.filter((c) => shaMap.get(c.sha) === c.sha).length;
    OUT(`  提交 sha 对齐本地: ${shaEqual}/${commits.length}` +
      (shaEqual === commits.length
        ? '  ✅ 完全对齐（今后可 git push 增量同步）'
        : '  ⚠️ 未对齐 —— 远端是独立历史，同步需整体重推'));

    OUT('');
    OUT(`  远端 HEAD: ${headRemote}`);
    // 沿 parent 链回溯，确认整条历史都在远端（不只是最后一个快照）
    let n = 0, cur = headRemote;
    while (cur) {
      n++;
      const c = await api('GET', `${API}/git/commits/${cur}`);
      cur = (c.parents && c.parents[0]) ? c.parents[0].sha : null;
      if (n > 10000) break;            // 防御：避免异常数据导致死循环
    }
    const localN = Number(gitText(['rev-list', '--count', BRANCH]).trim());
    OUT(`  远端可达提交: ${n} / 本地 ${localN}` + (n === localN ? '  ✅ 完整历史' : '  ❌ 历史缺失'));
    if (n !== localN) process.exitCode = 1;
  }
  OUT('');
  OUT(`API 调用次数: ${callCount}`);
  OUT('==============================================');
})().catch((e) => {
  OUT('');
  OUT('❌ 推送失败：');
  OUT('  ' + String(e.message).split('\n').join('\n  '));
  process.exit(1);
});
