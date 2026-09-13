'use strict';
/* =============================================================================
 * lib/hermes.js —— Hermes CLI 调用层 + oneshot 流式补丁自愈
 *
 * 关键约束（来自部署实践，踩过才知道）：
 *   - **必须删除 PYTHONPATH** —— WorkBuddy 注入的 sitecustomize 会劫持 mkdir。
 *   - **本地请求必须 NO_PROXY=127.0.0.1,localhost**，否则被代理拦截返回 502。
 *   - -z（oneshot）模式内部强制 yolo，故 --yolo 标志本身无意义；安全靠 hook。
 *
 * 真流式的来龙去脉：oneshot.py 需要一处补丁（HERMES_STREAM_FILE）才能把
 * assistant 文本 delta 逐块吐给 UI。`hermes update` 会覆盖该文件，所以每次启动自检：
 *   补丁在 → ok；补丁丢但锚点在 → 自动重打；锚点也没了（版本大变）→ 报告需人工适配。
 * ========================================================================== */

const fs = require('fs');
const { spawn } = require('child_process');
const { HOME, HERMES } = require('./config');
const { parseSessions } = require('./parse');

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

/* ---------- L4: 通用 hermes 子命令执行（sessions rename/delete 等） ----------
 * L5: stdinText 用于自动应答 CLI 的交互确认（如 cron remove 的 y/N） */
function runHermes(argsArr, stdinText) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const p = spawn(HERMES, argsArr, { env: hermesEnv() });
    let out = '', err = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    // ⚠️ P0（审计 2026-09-13 修复）：Hermes 二进制缺失/ENOENT 时，spawn 的 'error'
    // 事件若无监听者会升格为 uncaughtException → server.js 全局处理器 process.exit(1)
    // → 整个 UI 服务随一次失败请求（如 /api/sessions 列表）一起死。这里降级成「带错误码的结果」，
    // 让调用方（/api/session/rename/delete 等）自行报 5xx，而不是拖垮全服务。与 chat.js 的
    // child.on('error') 行为对齐。settled 标志防止 'error' 与 'close' 双重 resolve。
    p.on('error', e => done({ code: -1, out: '', err: 'spawn Hermes 失败: ' + e.message }));
    p.on('close', code => done({ code, out, err: (err + out).slice(-500) }));
    if (stdinText != null) { p.stdin.write(stdinText); p.stdin.end(); }
  });
}

/* L4: 会话列表。返回 { items, raw }（P1-4）—— 调用方需要 raw 才能用 parseResult()
 * 区分"真的没有会话"与"CLI 输出格式变了导致解析失效"，故不在这里吞掉原始输出。 */
function runSessionsList(limit = 30) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const p = spawn(HERMES, ['sessions', 'list', '--limit', String(limit)], { env: hermesEnv() });
    let out = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', () => {});
    // ⚠️ P0（审计 2026-09-13 修复）：同上，二进制 ENOENT 必须被捕获，否则升格为
    // uncaughtException 拖垮整服务。/api/sessions 列表是最高频的只读接口，绝不能因一次 spawn 失败崩服。
    p.on('error', e => done({ items: [], raw: 'spawn Hermes 失败: ' + e.message }));
    p.on('close', () => done({ items: parseSessions(out), raw: out }));
  });
}

/* ---------- L4: oneshot 流式补丁自愈 ---------- */
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

/* ⚠️ 必须在模块加载期求值：/api/health 要读 patchState 回报补丁状态。
 *    放在这里（而非 server.js 末尾）不影响语义——两者都是 require 期执行，
 *    但放在本模块可让「补丁是否已打」与「补丁怎么打」在一起，便于排查。 */
const patchState = ensureOneshotPatch();

module.exports = {
  hermesEnv, runHermes, runSessionsList,
  ensureOneshotPatch, patchState,
  ONESHOT_PATH, PATCH_MARKER,
};
