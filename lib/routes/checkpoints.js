'use strict';
/*
 * 检查点路由 —— 「改坏了能一键回到上一步」。
 *
 * 背景（两条实测结论，决定了这一层的形态）：
 *   1) hermes 的 /rollback **到不了 Web UI**：gateway 的 api_server 适配器不做斜杠命令分发，
 *      发 "/version" 会被当普通消息喂给模型。所以读写影子库的逻辑在 lib/checkpoints.js 里自己实现。
 *   2) 检查点默认关闭（官方 v2 起 opt-in）。~/.hermes/config.yaml 的 checkpoints.enabled
 *      由 setup.sh / healthcheck 保证为 true，否则本路由会明确报告"未启用"而不是假装空列表。
 *
 * 安全边界（全部在认证闸门之后，且服务端二次校验）：
 *   · dir 参数只接受**已注册项目**（lib/checkpoints.resolveWorkdir）—— 浏览器不能指定任意路径；
 *   · 目标提交必须属于该项目自己的 ref 历史（跨项目哈希一律拒，见 lib/checkpoints 的 guard）；
 *   · file 参数必须落在项目目录内（防路径穿越）；
 *   · 回退前自动拍 pre-rollback 快照，所以回退本身是可逆的。
 *
 * 回退是**破坏性操作**：默认走安全模式（只覆盖助手写入且未被手改的文件），
 * all=true（连手改一起覆盖）必须由前端显式二次确认后才发。
 */

const { sendJSON, readBody } = require('../http');
const { WORKSPACE } = require('../config');
const cp = require('../checkpoints');

/* 目录参数解析：接受绝对路径，只认已注册项目；缺省回落到本工作区（若已注册）。 */
function pickDir(raw) {
  const want = String(raw || '').trim() || WORKSPACE;
  const dir = cp.resolveWorkdir(want);
  return { dir, want };
}

module.exports = {
  register(router) {

    /* 总览：影子库状态 + 已登记项目（按最近触碰倒序）。
     * projects[].commits>0 才算"真的有东西可回退"，前端据此灰掉空项目。
     * ⚠️ 匹配器必须是**精确路径**而不是字符串前缀：lib/router.js 是前缀匹配、首个命中即处理，
     *    写成 '/api/checkpoints' 会把后面的 /list、/plan、/diff 全部吞掉
     *    （实测：/api/checkpoints/list 返回了总览 JSON）。 */
    router.add('GET', (req) => req.url.split('?')[0] === '/api/checkpoints', (req, res) => {
      const info = cp.storeInfo();
      const projects = cp.listProjects();
      // 本工作区若还没被登记，明确带出来 —— 否则前端看到"空列表"会以为是坏了
      const workspaceRegistered = projects.some((p) => p.workdir === cp.resolveWorkdir(WORKSPACE));
      return sendJSON(res, 200, {
        enabled: info.ready,
        base: info.base,
        sizeBytes: info.sizeBytes,
        maxSnapshots: info.maxSnapshots,
        maxFileMb: info.maxFileMb,
        workspace: WORKSPACE,
        workspaceRegistered,
        projects,
      });
    });

    /* 某项目的检查点列表（最近的在前） */
    router.add('GET', '/api/checkpoints/list', (req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      const { dir, want } = pickDir(u.searchParams.get('dir'));
      if (!dir) return sendJSON(res, 200, { enabled: cp.storeReady(), dir: null, requested: want, checkpoints: [], unregistered: true });
      const limit = Number(u.searchParams.get('limit') || 20);
      return sendJSON(res, 200, { dir, checkpoints: cp.listCheckpoints(dir, limit) });
    });

    /* 变更预案：回退前先让用户看清"哪些会被覆盖、哪些会被保留" */
    router.add('GET', '/api/checkpoints/plan', (req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      const { dir } = pickDir(u.searchParams.get('dir'));
      const hash = (u.searchParams.get('hash') || '').trim();
      if (!dir) return sendJSON(res, 400, { error: '目录未登记为检查点项目' });
      if (!hash) return sendJSON(res, 400, { error: 'hash required' });
      const r = cp.plan(dir, hash);
      return sendJSON(res, r.ok ? 200 : 400, r);
    });

    /* 差异预览（diff --stat + patch，patch 服务端已截断） */
    router.add('GET', '/api/checkpoints/diff', (req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      const { dir } = pickDir(u.searchParams.get('dir'));
      const hash = (u.searchParams.get('hash') || '').trim();
      const statOnly = u.searchParams.get('stat') === '1';
      if (!dir) return sendJSON(res, 400, { error: '目录未登记为检查点项目' });
      if (!hash) return sendJSON(res, 400, { error: 'hash required' });
      const r = cp.diff(dir, hash, { statOnly });
      return sendJSON(res, r.ok ? 200 : 400, r);
    });

    /* 手动拍一张快照（不依赖"助手正好写了文件"）—— 用户想留个还原点时的入口 */
    router.add('POST', '/api/checkpoints/snapshot', async (req, res) => {
      const b = JSON.parse(await readBody(req) || '{}');
      const want = String(b.dir || '').trim() || WORKSPACE;
      const wd = cp.resolveWorkdir(want) || (want === WORKSPACE ? want : null);
      if (!wd) return sendJSON(res, 400, { error: '只能对当前工作区或已登记项目拍快照' });
      const r = cp.take(wd, String(b.reason || '').trim().slice(0, 80) || 'UI 手动快照');
      if (!r.ok) return sendJSON(res, 400, r);
      return sendJSON(res, 200, { ...r, dir: wd, skipped: r.skipped });
    });

    /* 回退。all=true 时必须带 confirm:true —— 双保险，避免前端误触发全量覆盖。 */
    router.add('POST', '/api/checkpoints/restore', async (req, res) => {
      const b = JSON.parse(await readBody(req) || '{}');
      const { dir } = pickDir(b.dir);
      const hash = String(b.hash || '').trim();
      if (!dir) return sendJSON(res, 400, { error: '目录未登记为检查点项目，拒绝回退' });
      if (!hash) return sendJSON(res, 400, { error: 'hash required' });
      const all = b.all === true;
      if (all && b.confirm !== true) {
        return sendJSON(res, 400, { error: '全量回退（覆盖手动改动）需要显式确认' });
      }
      const r = cp.restore(dir, hash, { all, file: b.file ? String(b.file) : null });
      return sendJSON(res, r.ok ? 200 : 400, { ...r, dir });
    });
  },
};
