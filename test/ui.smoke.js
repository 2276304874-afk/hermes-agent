#!/usr/bin/env node
'use strict';
/* =============================================================================
 * test/ui.smoke.js —— 前端浏览器冒烟测试（无头 Chrome）
 *
 * 为什么需要它：2026-09-11 前端从 index.html 单文件拆成 index.html + app.css +
 * app.js 三个文件。拆分前 1400 行内联脚本躺在 HTML 里，node --check 够不着；
 * 拆分后虽然能过语法检查，但「CSS 真加载了吗 / JS 真跑起来了吗 / 页面有没有
 * 一上来就抛错」这三件事仍然只有肉眼能验。这个脚本把它们变成可重复的断言。
 *
 * 判据分五层（缺一层都不算通过）：
 *   L1 传输层：/ 返回 200、/app.css 与 /app.js 可获取且 MIME 正确
 *   L2 执行层：app.js 真的执行了（window.__UI_VERSION__ 被服务端替换成数值）
 *   L3 渲染层：CSS 变量生效、关键 DOM 存在且有尺寸
 *   L4 健康层：加载与初始化期间零 pageerror、零 console.error
 *   L5 降级层：拦截 /api/sessions 返回 degraded，告警必须出现且不阻断列表（P1-4）
 *   L6 KB 页层：/kb 带令牌可渲染、搜索按 {results:[]} 形状渲染、无令牌须提示补填（P2-10）
 *
 * 用法：
 *   node test/ui.smoke.js [port] [token]
 *   node test/ui.smoke.js 4173 "$(cat ~/.hermes/ui_token)"
 *
 * 依赖 playwright-core + 本机已装的 Chrome。二者缺一时打印 SKIP 并以 0 退出
 * （不阻断流水线），但会明确标注"前端未经验证"，避免造成虚假的安全感。
 * ========================================================================== */

const os = require('os');
const fs = require('fs');
const path = require('path');

const PORT = process.argv[2] || '4173';
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = process.argv[3] || process.env.HERMES_TOKEN || '';
const SHOT = process.env.UI_SMOKE_SHOT || '/tmp/hermes-ui-smoke.png';

/* ---------- playwright-core 解析（多路兜底，不硬编码版本目录） ---------- */
function loadPlaywright() {
  try { return require('playwright-core'); } catch { /* 继续找 */ }
  try { return require('playwright'); } catch { /* 继续找 */ }
  // 托管 node workspace 兜底
  const home = process.env.HOME || os.homedir();
  const ws = path.join(home, '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules', 'playwright-core');
  try { return require(ws); } catch { /* 放弃 */ }
  return null;
}

/* ---------- Chrome 可执行文件探测 ---------- */
function findChrome() {
  const cands = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  ];
  return cands.find(p => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}

/* ---------- 断言收集 ---------- */
let pass = 0, fail = 0;
const failures = [];
function ok(name, detail) { pass++; console.log(`  ✅ ${name}${detail ? ' — ' + detail : ''}`); }
function bad(name, detail) { fail++; failures.push(`${name}${detail ? ' — ' + detail : ''}`); console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
function check(cond, name, detail) { cond ? ok(name, detail) : bad(name, detail); }

/* 这些 console 错误属于预期噪声，不算前端故障 */
const CONSOLE_WHITELIST = [
  /favicon\.ico/i,           // 本项目没放 favicon，Chrome 会主动请求并拿到 404
  /net::ERR_ABORTED/i,       // 页面卸载/重载时被主动中断的请求
];

(async () => {
  const pw = loadPlaywright();
  if (!pw) {
    console.log('⚠️  SKIP：未找到 playwright-core，前端未经验证。');
    console.log('    安装后可用：npm i -D playwright-core（本机已装 Chrome 即可，无需下浏览器）');
    process.exit(0);
  }
  const chrome = findChrome();
  if (!chrome) {
    console.log('⚠️  SKIP：未找到本机 Chrome/Chromium，前端未经验证。');
    process.exit(0);
  }

  console.log(`前端冒烟测试 → ${BASE}`);
  const appName = (chrome.match(/\/([^/]+)\.app\//) || [])[1];
  console.log(`  浏览器: ${appName || path.basename(chrome)}`);
  console.log('');

  let browser;
  try {
    browser = await pw.chromium.launch({ executablePath: chrome, headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });

    // 注入 token，让页面跳过登录遮罩直接渲染主界面
    await ctx.addInitScript(([tok]) => {
      try {
        if (tok) localStorage.setItem('hermes_ui_token', tok);
        localStorage.setItem('hermes_ui_theme', 'light');
      } catch (e) {}
    }, [TOKEN]);

    const page = await ctx.newPage();
    const pageErrors = [];
    const consoleErrors = [];
    const badResponses = [];
    page.on('pageerror', e => pageErrors.push(String(e && e.message || e)));
    page.on('console', m => {
      if (m.type() !== 'error') return;
      // 资源类报错的文本里不含 URL（只有"Failed to load resource ... 404"），
      // 必须把 location().url 一起带上才能正确归因，否则 favicon 的 404 会被误判成前端故障。
      let loc = '';
      try { loc = (m.location() && m.location().url) || ''; } catch (e) {}
      consoleErrors.push({ text: m.text(), url: loc });
    });
    page.on('response', r => {
      const u = r.url();
      if (r.status() >= 400 && !/favicon\.ico/.test(u)) badResponses.push(`${r.status()} ${u}`);
    });

    /* ---------- L1 传输层 ---------- */
    console.log('L1 传输层');
    const resp = await page.goto(BASE + '/', { waitUntil: 'load', timeout: 20000 });
    check(resp && resp.status() === 200, '/ 返回 200', resp ? `HTTP ${resp.status()}` : '无响应');
    check((await page.title()).includes('赫尔墨斯特工'), '页面标题正确', await page.title());

    const assets = await page.evaluate(async () => {
      const out = [];
      for (const u of ['/app.css', '/app.js']) {
        try {
          const r = await fetch(u);
          out.push({ u, status: r.status, ct: r.headers.get('content-type') || '', len: (await r.text()).length });
        } catch (e) { out.push({ u, status: 0, ct: '', len: 0, err: String(e) }); }
      }
      return out;
    });
    for (const a of assets) {
      check(a.status === 200, `${a.u} 可获取`, `HTTP ${a.status}, ${a.len} 字节`);
      const want = a.u.endsWith('.css') ? 'text/css' : 'text/javascript';
      check(a.ct.includes(want), `${a.u} MIME 正确`, a.ct);
    }

    /* ---------- L2 执行层 ---------- */
    console.log('L2 执行层');
    const ver = await page.evaluate(() => window.__UI_VERSION__);
    check(!!ver && ver !== '__UI_VERSION__', 'app.js 已执行 & 版本戳被服务端替换', String(ver));

    /* ---------- L3 渲染层 ---------- */
    console.log('L3 渲染层');
    const css = await page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      return {
        bgVar: cs.getPropertyValue('--bg').trim(),
        accentVar: cs.getPropertyValue('--accent').trim(),
        bodyBg: getComputedStyle(document.body).backgroundColor,
        sheets: document.styleSheets.length,
      };
    });
    check(!!css.bgVar && !!css.accentVar, 'app.css 已加载（主题变量可读）', `--bg=${css.bgVar} --accent=${css.accentVar} (${css.sheets} 张样式表)`);
    check(css.bodyBg && css.bodyBg !== 'rgba(0, 0, 0, 0)', 'body 背景色已应用', css.bodyBg);

    const REQUIRED = ['messages', 'input', 'sendBtn', 'modelSelect', 'sessList', 'loginMask', 'tabBody', 'kbBtn'];
    const dom = await page.evaluate((ids) => ids.map(id => {
      const el = document.getElementById(id);
      if (!el) return { id, exists: false };
      const r = el.getBoundingClientRect();
      return { id, exists: true, w: Math.round(r.width), h: Math.round(r.height) };
    }), REQUIRED);
    for (const d of dom) {
      check(d.exists, `#${d.id} 存在`, d.exists ? `${d.w}×${d.h}` : '未找到');
    }
    // 主容器必须真的有尺寸（防"CSS 没生效导致全部塌成 0×0"）
    const msgBox = dom.find(d => d.id === 'messages');
    check(msgBox && msgBox.h > 100, '#messages 有实际高度（布局生效）', msgBox ? `${msgBox.h}px` : 'n/a');

    // 登录遮罩应因注入了 token 而隐藏
    const maskHidden = await page.evaluate(() => {
      const el = document.getElementById('loginMask');
      if (!el) return null;
      const cs = getComputedStyle(el);
      return cs.display === 'none' || cs.visibility === 'hidden' || el.hidden || Number(cs.opacity) === 0;
    });
    check(maskHidden === true, '注入 token 后登录遮罩已隐藏', String(maskHidden));

    /* ---------- L4 健康层 ---------- */
    console.log('L4 健康层');
    // 给异步初始化（loadSessions/loadModels/refreshStatus）留出时间
    await page.waitForTimeout(2500);
    check(pageErrors.length === 0, '无 JS 运行时错误 (pageerror)', pageErrors.length ? pageErrors.slice(0, 3).join(' | ') : '');

    const realConsoleErrors = consoleErrors.filter(c => !CONSOLE_WHITELIST.some(re => re.test(c.text) || re.test(c.url)));
    check(realConsoleErrors.length === 0, '无 console.error', realConsoleErrors.length
      ? realConsoleErrors.slice(0, 3).map(c => `${c.text} @ ${c.url || '(无 URL)'}`).join(' | ') : '');
    check(badResponses.length === 0, '无 4xx/5xx 资源请求', badResponses.length ? badResponses.slice(0, 3).join(' | ') : '');

    /* ---------- L5 降级分支（P1-4） ---------- */
    // /api/sessions 返回 degraded 时，会话列表区必须出现"疑似格式变更"告警且仍照常渲染。
    // 正常态永远测不到这个分支（后端只在 CLI 输出格式变更时才给标记），故用路由拦截构造响应。
    console.log('L5 降级分支');
    await page.route('**/api/sessions', r => r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ sessions: [], degraded: true, warning: 'sessions list 输出疑似格式变更' }),
    }));
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(1500);
    const sessText = await page.$eval('#sessList', el => el.textContent).catch(() => '');
    check(/疑似格式变更/.test(sessText), 'degraded 时显示解析告警', sessText.slice(0, 50));
    check(/暂无历史会话/.test(sessText), 'degraded 不阻断列表渲染（不白屏）', '');
    check(pageErrors.length === 0, '降级分支无 JS 运行时错误', pageErrors.length ? pageErrors.slice(0, 2).join(' | ') : '');
    // 还原真实响应，保证下面的截图反映的是正常态
    await page.unroute('**/api/sessions');
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(1200);

    /* ---------- L5b 工作区「移动到」入口 ---------- */
    // 会话项上的「移动到工作区」入口是 2026-09-12 补的：会话归入工作区只有「新建时归类」一条路，
    // 已有会话无法搬迁。它有三个容易回归又肉眼难以发现的点：
    //   ① 按钮没渲染出来（innerHTML 拼接错一处就整个动作行消失）；
    //   ② 点了没冒出选择器（openWsPicker 未定义 → 只有一条 pageerror，界面毫无反馈）；
    //   ③ 选完不刷新列表（assign 成功但 loadSessions 没重跑，看起来像没生效）。
    // 故在此固化。本机无会话时跳过并标注，不因环境差异虚报。
    console.log('L5b 工作区移动入口');
    const moveProbe = await page.evaluate(() => {
      const item = document.querySelector('.sess-item');
      if (!item) return { skipped: true };
      const btn = item.querySelector('[data-act="move"]');
      if (!btn) return { noButton: true };
      btn.click();
      const sel1 = item.querySelector('.ws-picker');
      const opened = !!sel1;
      const opts = sel1 ? Array.from(sel1.options).map(o => o.value) : [];
      btn.click();                                  // 再点一次应收起
      const closed = !item.querySelector('.ws-picker');
      // 二次点击已在 UI 内部把它摘掉，此处必须先判 parentNode（否则 evaluate 里抛 NotFoundError）
      if (sel1 && sel1.parentNode) sel1.remove();
      return { skipped: false, opened, closed, opts };
    });
    if (moveProbe.skipped) {
      console.log('  ⚠️ 跳过：本机无历史会话，无法验证移动入口');
    } else {
      check(!moveProbe.noButton, '会话项渲染出「移动到工作区」按钮', moveProbe.noButton ? '未找到 data-act="move"' : '');
      check(moveProbe.opened === true, '点击弹出工作区选择器', String(moveProbe.opened));
      check((moveProbe.opts || []).includes('') && (moveProbe.opts || []).includes('__new__'),
        '选择器含「未归类」与「新建工作区…」', (moveProbe.opts || []).join(','));
      check(moveProbe.closed === true, '再次点击收起选择器（幂等）', String(moveProbe.closed));
    }

    // 重命名能力 2026-09-12 补：此前改工作区名只能「删除再新建」，而删除会连带清掉该区
    // 全部会话归属（会话就此散落回「未归类」）。这里守住入口存在 + 默认区受保护。
    const renameProbe = await page.evaluate(() => {
      const chips = Array.from(document.querySelectorAll('#wsBar .ws-chip'));
      // 优先取「非默认」工作区：默认区那条是被锁定的分支，测不到真实删除项
      const pickable = chips.filter(c => c.textContent && c.textContent.trim() !== '全部' && c.textContent.trim() !== '默认' && !c.classList.contains('add'));
      const fallback = chips.filter(c => c.textContent && c.textContent.trim() !== '全部' && !c.classList.contains('add'));
      const target = pickable[0] || fallback[0];
      if (!target) return { skipped: true };
      const isDefault = target.textContent.trim() === '默认';
      target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      const menu = document.querySelector('.ws-menu');
      const items = menu ? Array.from(menu.querySelectorAll('.ws-menu-item')).map(b => b.textContent) : [];
      const disabledHint = menu ? items.some(t => /默认工作区不可删除/.test(t)) : false;
      menu && menu.remove();
      return { skipped: false, opened: !!menu, items, disabledHint, isDefault };
    });
    if (renameProbe.skipped) {
      console.log('  ⚠️ 跳过：无可操作的工作区 chip');
    } else {
      check(renameProbe.opened === true, '工作区右键弹出菜单', String(renameProbe.opened));
      check((renameProbe.items || []).some(t => /重命名/.test(t)), '菜单含「重命名…」', (renameProbe.items || []).join(' / '));
      // 默认区：删除项必须是"不可删"提示；普通区：必须是真删除项
      const expectLocked = renameProbe.isDefault === true;
      check(expectLocked ? renameProbe.disabledHint : (renameProbe.items || []).some(t => /^删除工作区/.test(t)),
        expectLocked ? '默认区显示为「不可删除」（受保护）' : '普通工作区显示真实删除项', (renameProbe.items || []).join(' / '));
    }
    check(pageErrors.length === 0, '工作区入口交互无 JS 运行时错误', pageErrors.length ? pageErrors.slice(0, 2).join(' | ') : '');

    /* ---------- L6 KB 查看器（P2-10 认证 + 返回形状归一） ---------- */
    // 两件「页面打得开、但功能其实是空的」的故障，肉眼极难发现，故固化进冒烟网：
    //   ① KB 接口已移入认证闸门 → /kb 页面不带令牌时全是 401（页面本身仍 200，只是空）；
    //   ② /api/kb/list 返回数组、/api/kb/search 返回 {results:[]} —— 合并到 4173 后
    //      搜索分支直接对对象调 .map()，导致搜索永远显示"暂无内容"（本次修掉的真实 bug）。
    console.log('L6 KB 查看器');
    const kbErrorsBefore = pageErrors.length;
    await page.goto(`${BASE}/kb`, { waitUntil: 'load' });
    await page.waitForTimeout(1200);
    const authHidden = await page.$eval('#authBar', el => el.hidden).catch(() => null);
    check(authHidden === true, '有令牌时不再提示补填', String(authHidden));
    const kbListText = await page.$eval('#list', el => el.textContent).catch(() => '');
    check(!/加载失败/.test(kbListText), 'KB 列表正常渲染（非 401/报错）', kbListText.slice(0, 30));

    // 用拦截构造 search 的**真实**形状（对象而非数组），锁死"形状归一"这处回归
    await page.route('**/api/kb/search*', r => r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        query: 'launchd', count: 1,
        results: [{ cat: 'search', type: '经验', src: 'test.md', text: '形状归一回归样本', score: 0.9 }],
      }),
    }));
    await page.click('#nav button[data-cat="search"]');
    await page.fill('#q', 'launchd');
    await page.click('#searchRow button');
    await page.waitForTimeout(900);
    const searchText = await page.$eval('#list', el => el.textContent).catch(() => '');
    check(/形状归一回归样本/.test(searchText), '搜索结果按 {results:[]} 形状渲染', searchText.slice(0, 40));
    await page.unroute('**/api/kb/search*');

    // 反面：令牌无效时必须弹出补填提示，而不是静默显示空列表。
    // 注意：ctx.addInitScript 每次导航都会把正确令牌重新写进 localStorage，
    // 所以这里改测"令牌错误 + 触发请求"——走的是同一条 401 → showAuthBar 路径，
    // 比单纯清 localStorage 更贴近真实故障（用户在另一台机器/换了令牌）。
    await page.evaluate(() => localStorage.setItem('hermes_ui_token', 'wrong-token-for-smoke'));
    await page.click('#nav button[data-cat="all"]');
    await page.waitForTimeout(900);
    const authShown = await page.$eval('#authBar', el => el.hidden).catch(() => null);
    check(authShown === false, '令牌无效时提示补填令牌', String(authShown));
    check(pageErrors.length === kbErrorsBefore, 'KB 页面无 JS 运行时错误',
      pageErrors.length > kbErrorsBefore ? pageErrors.slice(kbErrorsBefore, kbErrorsBefore + 2).join(' | ') : '');

    // 恢复令牌并回到主界面，让末尾截图反映正常态
    await page.evaluate(t => localStorage.setItem('hermes_ui_token', t), TOKEN);
    await page.goto(`${BASE}/`, { waitUntil: 'load' });
    await page.waitForTimeout(800);

    /* ---------- L7 思考块显示开关的语义守门 ----------
     * 2026-09-12：原名「快速/思考」会让人以为切换后回答变快，但该开关从不进入请求参数。
     * 这里锁住「不得再用暗示速度的词」，防止日后改回去。 */
    const modeProbe = await page.evaluate(() => {
      const seg = document.getElementById('modeSeg');
      if (!seg) return { missing: true };
      const btns = [...seg.querySelectorAll('button')].map(b => b.textContent.trim());
      return { missing: false, labels: btns, ctrls: seg.querySelectorAll('button').length };
    });
    check(modeProbe.missing === false, '思考块开关存在', String(modeProbe.missing));
    check(modeProbe.ctrls === 2, '开关为展开/折叠两段', String(modeProbe.ctrls));
    check(
      !modeProbe.labels.some(t => /快速|极速|加速|省时/.test(t)),
      '开关文案不得暗示影响速度（本开关只切显示）',
      modeProbe.labels.join(' / ')
    );

    /* ---------- L8 执行轨迹（Trajectory） ----------
     * 本地模型一轮有 10~20s 纯等待。用 mock SSE 把事件流固定下来，
     * 断言 Phase 面板能按事件推进并给出耗时 —— 这是「等待可见」的关键手段。
     * 必须 mock 真实模型调用：否则用例耗时会跟着模型走，测试不可重复。 */
    await page.route('**/api/chat', route => route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: [
        'event: ready\ndata: {"runId":"r-ui-probe","sessionId":"api_1789152458_78429320"}\n\n',
        'event: session\ndata: {"sessionId":"api_1789152458_78429320"}\n\n',
        'event: token\ndata: {"text":"你好"}\n\n',
        'event: done\ndata: {"elapsed":12.3,"sessionId":"api_1789152458_78429320"}\n\n',
      ].join(''),
    }));
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(1200);
    await page.fill('#input', '只回复两个字：你好');
    await page.click('#sendBtn');
    await page.waitForTimeout(1500);

    const traj = await page.evaluate(() => {
      const box = document.querySelector('.run .traj');
      if (!box) return { missing: true };
      const rows = [...box.querySelectorAll('.traj-step')].map(r => ({
        step: r.dataset.step,
        state: r.classList.contains('done') ? 'done'
          : r.classList.contains('aborted') ? 'aborted'
            : r.classList.contains('running') ? 'running' : 'pending',
        time: (r.querySelector('.traj-t') || {}).textContent || '',
      }));
      // has-traj 时「思考中…」必须让位，否则同一信息显示两遍
      const th = document.querySelector('.run.has-traj .thinking');
      const thinkingHidden = th ? getComputedStyle(th).display === 'none' : true;
      return { missing: false, rows, thinkingHidden };
    });

    check(traj.missing === false, 'Trajectory 面板已渲染', String(traj.missing));
    check((traj.rows || []).length === 3, '轨迹为「建立连接/准备上下文/模型推理」三段', String((traj.rows || []).length));
    check(
      (traj.rows || []).every(r => r.state === 'done'),
      '本轮结束后各阶段均标记为已完成（不留卡住的转圈）',
      (traj.rows || []).map(r => `${r.step}:${r.state}`).join(' ')
    );
    check(
      (traj.rows || []).every(r => /^\d+\.\d+s$/.test(r.time)),
      '每阶段都给出实测耗时（秒）',
      (traj.rows || []).map(r => r.time).join(' / ')
    );
    check(traj.thinkingHidden === true, 'has-traj 时隐藏「思考中…」占位（避免信息重复）', String(traj.thinkingHidden));
    await page.unroute('**/api/chat');

    /* ---------- L9 优化提示词按钮 ---------- */
    const optBtn = await page.$('#optimizeBtn');
    check(optBtn !== null, '优化提示词按钮存在', String(!!optBtn));
    if (optBtn) {
      const title = await optBtn.getAttribute('title') || '';
      check(title.includes('优化'), '按钮 title 含"优化"', title.slice(0, 60));
      // 确认按钮在 modeSeg 之后、modelSelect 之前
      const html = await page.evaluate(() => {
        const btn = document.getElementById('optimizeBtn');
        if (!btn) return null;
        const prev = btn.previousElementSibling;
        const next = btn.nextElementSibling;
        return { prevId: prev?.id, nextId: next?.id };
      });
      check(html && html.prevId === 'modeSeg', '按钮位置：在 modeSeg 之后', html?.prevId);
      check(html && html.nextId === 'modelSelect', '按钮位置：在 modelSelect 之前', html?.nextId);
    }

    /* ---------- 截图存档 ---------- */
    try {
      await page.screenshot({ path: SHOT, fullPage: false });
      console.log(`\n  📷 截图: ${SHOT}`);
    } catch (e) { /* 截图失败不影响结论 */ }

    await browser.close();
  } catch (e) {
    bad('测试执行异常', String(e && e.message || e).split('\n')[0]);
    if (browser) { try { await browser.close(); } catch {} }
  }

  console.log('');
  console.log(`结果：${pass} 通过 / ${fail} 失败`);
  if (fail) {
    console.log('失败项：');
    failures.forEach(f => console.log('  - ' + f));
  }
  process.exit(fail ? 1 : 0);
})();
